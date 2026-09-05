// End-to-end against a running portal and its chain. Nothing is mocked: the
// quote comes from the portal, the escrow address comes from that quote, and
// the transaction the SDK builds is submitted to the node with `eth_call`.
//
// The hermetic tests can only assert that the SDK agrees with itself. Only the
// chain can say whether the calldata the SDK produces is what the deployed
// escrow accepts.
//
//   GIVRO_E2E_PORTAL_URL=http://127.0.0.1:3100 \
//   GIVRO_E2E_RPC_URL=http://127.0.0.1:8545 \
//   GIVRO_E2E_CHAIN_ID=31338 npx vitest run tests/e2e
import { describe, expect, it, beforeAll } from "vitest";
import { decodeFunctionData } from "viem";
import { coercePaymentQuote } from "../../src/quote.js";
import { createGivroPayClient } from "../../src/client.js";
import { buildEvmDepositFromQuote } from "../../src/evm/depositFromQuote.js";
import { fetchPublicSupportedAssets } from "../../src/supportedAssets.js";
import { GIVRO_PAY_ESCROW_ABI } from "../../src/evm/escrow.js";

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
      // disabled Turnstile for local runs.
      turnstile: "",
    }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`quote failed: ${JSON.stringify(json)}`);
  return json;
}

describeLive("SDK against a live portal + chain", () => {
  beforeAll(async () => {
    const chain = await rpc("eth_chainId", []);
    expect(Number(chain.result)).toBe(CHAIN_ID);
  });

  it("publishes the same escrow in discovery that it settles quotes on", async () => {
    const config = await fetchPublicSupportedAssets(PORTAL!);
    const chain = config.chains.find((c) => "chainId" in c && c.chainId === CHAIN_ID);
    const published = (chain as { attestedContract?: string } | undefined)?.attestedContract;
    expect(published, "the portal publishes no settlement contract to pin").toBeDefined();

    const q = coercePaymentQuote(await freshQuote());
    expect(published!.toLowerCase()).toBe(q.attestedContract.toLowerCase());
  });

  it("builds a native deposit the escrow accepts", async () => {
    const raw = await freshQuote();
    const q = coercePaymentQuote(raw);
    const plan = buildEvmDepositFromQuote({ quote: q, pinnedEscrow: q.attestedContract });
    expect(plan.steps).toHaveLength(1);

    // Two separate claims, because `eth_call` alone proves less than it looks.
    // The escrow accepts any *unseen* blindedBinding, so a deposit built with a
    // wrong-but-fresh value still executes: the call proves the selector and
    // tuple layout are right, not that the values came from this quote.
    const out = await ethCall(plan.steps[0]!);
    expect(out.error, `escrow rejected the SDK's deposit: ${out.error?.message}`).toBeUndefined();

    // So the values are checked directly, against the quote the portal issued.
    const decoded = decodeFunctionData({ abi: GIVRO_PAY_ESCROW_ABI, data: plan.steps[0]!.data as `0x${string}` });
    expect(decoded.functionName).toBe("depositNativeWithOrder");
    const [order, mandateCommit] = decoded.args as unknown as [Record<string, unknown>, string];
    const issued = q.order;
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
    expect(mandateCommit).toBe(q.mandateCommit);
  });

  it("routes the documented entry point to the pinned escrow", async () => {
    const q = coercePaymentQuote(await freshQuote());
    const client = createGivroPayClient({
      quoteUrl: `${PORTAL}/api/intent/quote`,
      trustedAttestedContracts: { [`evm:${CHAIN_ID}`]: [q.attestedContract] },
    });
    const { approve, deposit } = client.prepareEvmTransactions({ quote: q });
    expect(approve).toBeNull();
    const out = await ethCall(deposit);
    expect(out.error, `escrow rejected the SDK's deposit: ${out.error?.message}`).toBeUndefined();
  });
});
