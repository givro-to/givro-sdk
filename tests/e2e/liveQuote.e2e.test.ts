// End-to-end against a running portal and its chain. Nothing is mocked: the
// quote comes from the portal, the escrow address comes from that quote, and
// the transaction the SDK builds is submitted to the node with `eth_call`.
//
// This suite exists because the SDK's hermetic tests could not have caught the
// defect it was written for. They asserted the SDK agreed with itself, and it
// did -- it parsed a v2 quote cleanly and produced a v1 transaction that only
// failed once broadcast. Only the chain could say so.
//
//   GIVRO_E2E_PORTAL_URL=http://127.0.0.1:3100 \
//   GIVRO_E2E_RPC_URL=http://127.0.0.1:8545 \
//   GIVRO_E2E_CHAIN_ID=31338 npx vitest run tests/e2e
import { describe, expect, it, beforeAll } from "vitest";
import { decodeFunctionData } from "viem";
import { coercePaymentQuote } from "../../src/quote.js";
import { createGivroPayClient } from "../../src/client.js";
import { buildEvmDepositFromQuote } from "../../src/evm/depositFromQuote.js";
import { buildEvmAttestedDepositRequest } from "../../src/evm/prepareEvmDeposit.js";
import { fetchPublicSupportedAssets } from "../../src/supportedAssets.js";
import { GIVRO_PAY_INTENT_BLINDED_ABI } from "../../src/evm/prepareIntentBlindedDeposit.js";

const PORTAL = process.env.GIVRO_E2E_PORTAL_URL;
const RPC = process.env.GIVRO_E2E_RPC_URL;
const CHAIN_ID = Number(process.env.GIVRO_E2E_CHAIN_ID ?? 0);
// Anvil's first funded account. Only ever used as an `eth_call` sender.
const PAYER = process.env.GIVRO_E2E_PAYER ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NATIVE = "0x0000000000000000000000000000000000000000";

const live = Boolean(PORTAL && RPC && CHAIN_ID > 0);
const describeLive = live ? describe : describe.skip;

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(RPC!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as { result?: unknown; error?: { message: string } };
}

async function ethCall(tx: { to: string; value: bigint; data: string }) {
  return rpc("eth_call", [
    { from: PAYER, to: tx.to, value: `0x${tx.value.toString(16)}`, data: tx.data },
    "latest",
  ]);
}

/** A fresh recipient per quote: the escrow rejects a reused `blindedBinding`. */
async function freshQuote(token = NATIVE, amountWei = "1000000000000000") {
  const res = await fetch(`${PORTAL}/api/intent/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identifier: `sdk-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
      identifierKind: "email",
      amountWei,
      token,
      chainId: CHAIN_ID,
      ecosystem: "evm",
      // Accepted only when the portal is non-production and has explicitly
      // opted in; a deployed portal rejects it.
      turnstile: "local-bypass",
    }),
  });
  const raw = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`quote failed ${res.status}: ${JSON.stringify(raw)}`);
  return raw;
}

describeLive("live portal", () => {
  beforeAll(async () => {
    const res = await fetch(`${PORTAL}/api/public/supported-assets`);
    if (!res.ok) throw new Error(`portal unreachable: ${res.status}`);
  });

  it("parses the portal's published asset config", async () => {
    const config = await fetchPublicSupportedAssets(PORTAL!);
    expect(config.chains.length).toBeGreaterThan(0);
    const chain = config.chains.find((c) => "chainId" in c && c.chainId === CHAIN_ID);
    expect(chain, `chain ${CHAIN_ID} is not in the portal's published config`).toBeDefined();
    expect(chain!.tokens.length).toBeGreaterThan(0);
  });

  it("publishes the same escrow it issues quotes against", async () => {
    // The whole point of the published registry: an integrator reads it at
    // onboarding, reviews the address independently, and pins it. That only
    // works if it is the address the money actually goes to. For a while it
    // was not published at all, and the docs still told integrators to pin it.
    const config = await fetchPublicSupportedAssets(PORTAL!);
    const chain = config.chains.find((c) => "chainId" in c && c.chainId === CHAIN_ID);
    const published = (chain as { attestedContract?: string } | undefined)?.attestedContract;
    expect(published, "the portal publishes no settlement contract to pin").toBeDefined();

    const q = coercePaymentQuote(await freshQuote());
    expect(published!.toLowerCase()).toBe(q.intentBlinded!.escrow.toLowerCase());
  });

  it("reads a live quote as v2 and rejects the retired v1 fields", async () => {
    const raw = await freshQuote();
    const q = coercePaymentQuote(raw);
    expect(q.protocolVersion).toBe(2);
    expect(q.intentBlinded?.escrow).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The portal still emits both, and `attestedContract` is the v2 escrow.
    expect(raw.order).toBeDefined();
    expect(raw.attestedContract).toBe(q.intentBlinded!.escrow);
    expect(q.depositContract).toBeUndefined();
    expect(q.attestedOrder).toBeUndefined();
  });

  it("builds a native deposit the escrow accepts", async () => {
    const raw = await freshQuote();
    const q = coercePaymentQuote(raw);
    const plan = buildEvmDepositFromQuote({
      quote: q,
      pinnedEscrow: q.intentBlinded!.escrow as `0x${string}`,
    });
    expect(plan.protocolVersion).toBe(2);
    expect(plan.steps).toHaveLength(1);

    // Two separate claims, because `eth_call` alone proves less than it looks.
    // The escrow accepts any *unseen* blindedBinding, so a deposit built with a
    // wrong-but-fresh value still executes: the call proves the selector and
    // tuple layout are right, not that the values came from this quote.
    const out = await ethCall(plan.steps[0]!);
    expect(out.error, `escrow rejected the SDK's deposit: ${out.error?.message}`).toBeUndefined();

    // So the values are checked directly, against the quote the portal issued.
    const decoded = decodeFunctionData({
      abi: GIVRO_PAY_INTENT_BLINDED_ABI,
      data: plan.steps[0]!.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("depositNativeWithOrder");
    const [order, mandateCommit] = decoded.args as unknown as [Record<string, unknown>, string];
    const issued = q.intentBlinded!.order;
    expect(order.chainId).toBe(issued.chainId);
    expect(order.paymentRef).toBe(issued.paymentRef);
    expect(order.intentId).toBe(issued.intentId);
    expect(order.blindedBinding).toBe(issued.blindedBinding);
    expect(order.bindingEpoch).toBe(issued.bindingEpoch);
    expect(order.claimAuthorization).toBe(issued.claimAuthorization);
    expect(order.token).toBe(issued.token);
    expect(order.amount).toBe(issued.amount);
    expect(order.cancelBefore).toBe(issued.cancelBefore);
    expect(order.claimBefore).toBe(issued.claimBefore);
    expect(order.refundAfter).toBe(issued.refundAfter);
    expect(mandateCommit).toBe(q.intentBlinded!.mandateCommit);
  });

  it("would have reverted on the v1 rail -- which is why the parser refuses it", async () => {
    // The regression witness. Rebuilding the pre-fix behaviour by hand shows
    // what a v1 integrator got from a v2 quote: a well-formed transaction,
    // aimed at a real contract, that the chain throws out. If this ever stops
    // reverting, the two rails have converged and the refusal above should be
    // revisited rather than left in place on a stale assumption.
    const raw = await freshQuote();
    const legacy = raw.order as Record<string, string>;
    const doomed = buildEvmAttestedDepositRequest({
      depositContract: raw.attestedContract as `0x${string}`,
      order: {
        chainId: BigInt(legacy.chainId),
        paymentRef: legacy.paymentRef as `0x${string}`,
        idHash: legacy.idHash as `0x${string}`,
        token: legacy.token as `0x${string}`,
        amount: BigInt(legacy.amount),
        cancelBefore: BigInt(legacy.cancelBefore),
        claimBefore: BigInt(legacy.claimBefore),
        refundAfter: BigInt(legacy.refundAfter),
      },
    });
    const out = await ethCall(doomed);
    expect(out.error?.message ?? "").toMatch(/revert/i);
  });

  it("carries a live quote through the documented entry point onto the chain", async () => {
    // The README tells integrators to call `prepareEvmTransactions`. This is
    // that exact path, from a real quote to a call the real escrow accepts --
    // no builder chosen by hand, no shape assumed.
    const raw = await freshQuote();
    const q = coercePaymentQuote(raw);
    const client = createGivroPayClient({
      quoteUrl: `${PORTAL}/api/intent/quote`,
      trustedAttestedContracts: { [`evm:${CHAIN_ID}`]: [q.intentBlinded!.escrow] },
    });
    const { approve, deposit } = client.prepareEvmTransactions({ quote: q });
    expect(approve).toBeNull();
    const out = await ethCall(deposit);
    expect(out.error, `escrow rejected the client's deposit: ${out.error?.message}`).toBeUndefined();
  });

  it("plans approve-then-deposit for an ERC-20 quote", async () => {
    const config = await fetchPublicSupportedAssets(PORTAL!);
    const chain = config.chains.find((c) => "chainId" in c && c.chainId === CHAIN_ID)!;
    const erc20 = chain.tokens.find((t) => !("native" in t && t.native));
    if (!erc20) return; // chain publishes no ERC-20; nothing to assert
    const address = (erc20 as { address?: string }).address!;
    const q = coercePaymentQuote(await freshQuote(address, "1000000"));
    const plan = buildEvmDepositFromQuote({
      quote: q,
      pinnedEscrow: q.intentBlinded!.escrow as `0x${string}`,
    });
    // Not submitted: the deposit needs the approve mined first, so `eth_call`
    // against current state would revert for a reason unrelated to the SDK.
    expect(plan.steps).toHaveLength(2);
    const [approve, deposit] = plan.steps as [typeof plan.steps[0], typeof plan.steps[0]];
    expect(approve.to.toLowerCase()).toBe(address.toLowerCase());
    expect(deposit.to).toBe(q.intentBlinded!.escrow);
    expect(deposit.value).toBe(0n);
  });
});
