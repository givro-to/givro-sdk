// The fixture is a real response recorded from a running portal, not a
// hand-written approximation: every test agreeing with the SDK's own idea of
// the shape is exactly how a server-side drift goes unnoticed.
import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import liveQuote from "./fixtures/liveQuote.evm.json" with { type: "json" };
import { coercePaymentQuote } from "../src/quote.js";
import { createGivroPayClient } from "../src/client.js";
import { buildEvmDepositFromQuote } from "../src/evm/depositFromQuote.js";
import { GIVRO_PAY_ESCROW_ABI } from "../src/evm/escrow.js";
import { tronDepositCallFromQuote } from "../src/tron/deposit.js";
import { GivroPayBuildTxError, GivroPayQuoteError } from "../src/errors.js";

const RAW = liveQuote as unknown as Record<string, unknown>;
const ESCROW = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const material = () => RAW.intentBlinded as Record<string, unknown>;
const materialOrder = () => material().order as Record<string, unknown>;

describe("quote parsing", () => {
  it("carries the escrow, the mandate commitment and the order", () => {
    const q = coercePaymentQuote(RAW);
    expect(q.attestedContract).toBe(ESCROW);
    expect(q.mandateCommit).toBe(`0x${"0".repeat(64)}`);
    expect(q.order.intentId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(q.order.blindedBinding).toMatch(/^0x[0-9a-f]{64}$/);
    expect(q.order.amount).toBe(1000000000000000n);
    expect(q.amount).toBe("1000000000000000");
    expect(q.chainId).toBe(31338);
  });

  it("refuses a quote without settlement material", () => {
    const { intentBlinded: _i, ...broken } = RAW;
    expect(() => coercePaymentQuote(broken)).toThrow(GivroPayQuoteError);
  });

  it("refuses a quote whose published escrow disagrees with its settlement escrow", () => {
    // The two fields are issued together and always agree today. If a portal
    // ever emitted a quote where they differ, one of them is the address the
    // caller pinned and the other is where the money would go.
    const split = { ...RAW, attestedContract: "0x000000000000000000000000000000000000dEaD" };
    expect(() => coercePaymentQuote(split)).toThrow(/disagrees/);
  });

  it("refuses a claimAuthorization the escrow has no route for", () => {
    const bad = { ...RAW, intentBlinded: { ...material(), order: { ...materialOrder(), claimAuthorization: 7 } } };
    expect(() => coercePaymentQuote(bad)).toThrow(GivroPayQuoteError);
  });

  it("refuses an order whose amount or paymentRef disagrees with the quote", () => {
    expect(() => coercePaymentQuote({ ...RAW, amountWei: "1" })).toThrow(/amountWei disagrees/);
    const other = "0x" + "ff".repeat(32);
    expect(() => coercePaymentQuote({ ...RAW, intentBlinded: { ...material(), order: { ...materialOrder(), paymentRef: other } } }))
      .toThrow(/paymentRef disagrees/);
  });
});

describe("deposit building", () => {
  it("encodes the escrow's 11-field order tuple", () => {
    const q = coercePaymentQuote(RAW);
    const plan = buildEvmDepositFromQuote({ quote: q, pinnedEscrow: ESCROW });
    expect(plan.steps).toHaveLength(1);
    const [tx] = plan.steps;
    expect(tx.to).toBe(ESCROW);
    expect(tx.value).toBe(1000000000000000n);
    const decoded = decodeFunctionData({ abi: GIVRO_PAY_ESCROW_ABI, data: tx.data });
    expect(decoded.functionName).toBe("depositNativeWithOrder");
    const [order, mandateCommit] = decoded.args as unknown as [Record<string, unknown>, string];
    expect(Object.keys(order)).toHaveLength(11);
    expect(order.blindedBinding).toBe(q.order.blindedBinding);
    expect(order.intentId).toBe(q.order.intentId);
    expect(mandateCommit).toBe(`0x${"0".repeat(64)}`);
  });

  it("returns approve-then-deposit for an ERC-20 payment", () => {
    const token = "0xbded0d2bf404bdcba897a74e6657f1f12e5c6fb6";
    const q = coercePaymentQuote({ ...RAW, token, intentBlinded: { ...material(), order: { ...materialOrder(), token } } });
    const plan = buildEvmDepositFromQuote({ quote: q, pinnedEscrow: ESCROW });
    expect(plan.steps).toHaveLength(2);
    const [approve, deposit] = plan.steps as [typeof plan.steps[0], typeof plan.steps[0]];
    expect(approve.to.toLowerCase()).toBe(token.toLowerCase());
    expect(approve.value).toBe(0n);
    expect(deposit.to).toBe(ESCROW);
    expect(deposit.value).toBe(0n);
  });

  it("refuses an escrow the integrator did not pin", () => {
    const q = coercePaymentQuote(RAW);
    expect(() => buildEvmDepositFromQuote({ quote: q, pinnedEscrow: "0x000000000000000000000000000000000000dEaD" }))
      .toThrow(/does not match the pinned escrow/);
    expect(() => buildEvmDepositFromQuote({ quote: q, pinnedEscrow: "" as `0x${string}` })).toThrow(GivroPayBuildTxError);
  });
});

describe("prepareEvmTransactions -- the documented entry point", () => {
  const client = () =>
    createGivroPayClient({
      quoteUrl: "https://example.invalid/api/intent/quote",
      trustedAttestedContracts: { "evm:31338": [ESCROW] },
    });

  it("routes the quote to the pinned escrow", () => {
    const { approve, deposit } = client().prepareEvmTransactions({ quote: coercePaymentQuote(RAW) });
    expect(approve).toBeNull();
    expect(deposit.to).toBe(ESCROW);
    expect(decodeFunctionData({ abi: GIVRO_PAY_ESCROW_ABI, data: deposit.data }).functionName)
      .toBe("depositNativeWithOrder");
  });

  it("refuses an escrow outside the caller's pin list", () => {
    const wrong = createGivroPayClient({
      quoteUrl: "https://example.invalid/api/intent/quote",
      trustedAttestedContracts: { "evm:31338": ["0x000000000000000000000000000000000000dEaD"] },
    });
    expect(() => wrong.prepareEvmTransactions({ quote: coercePaymentQuote(RAW) })).toThrow(/not trusted/);
  });
});

describe("Tron", () => {
  const tronRaw = () => ({
    ...RAW,
    ecosystem: "tron",
    chainId: 3448148188,
    token: "native",
    intentBlinded: { ...material(), order: { ...materialOrder(), chainId: 3448148188, token: "native" } },
  });

  it("builds the TronWeb call for a native deposit from the same order tuple", () => {
    const call = tronDepositCallFromQuote(coercePaymentQuote(tronRaw()));
    expect(call.escrow).toBe(ESCROW);
    expect(call.functionName).toBe("depositNativeWithOrder");
    expect(call.callValue).toBe("1000000000000000");
    expect(call.order.token).toBe("0x0000000000000000000000000000000000000000");
    expect(Object.keys(call.order)).toEqual([
      "chainId", "paymentRef", "intentId", "blindedBinding", "bindingEpoch", "claimAuthorization",
      "token", "amount", "cancelBefore", "claimBefore", "refundAfter",
    ]);
  });

  it("keeps a TRC20 contract as the portal returned it and sends no callValue", () => {
    const raw = tronRaw();
    const usdt = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    raw.token = usdt;
    (raw.intentBlinded.order as Record<string, unknown>).token = usdt;
    const call = tronDepositCallFromQuote(coercePaymentQuote(raw));
    expect(call.functionName).toBe("depositErc20WithOrder");
    expect(call.order.token).toBe(usdt);
    expect(call.callValue).toBe("0");
  });

  it("is pinned through the client like EVM", () => {
    const pinned = createGivroPayClient({
      quoteUrl: "https://example.invalid/api/intent/quote",
      trustedAttestedContracts: { "tron:3448148188": [ESCROW] },
    });
    expect(pinned.tronDepositCall(coercePaymentQuote(tronRaw())).escrow).toBe(ESCROW);
    const unpinned = createGivroPayClient({ quoteUrl: "https://example.invalid/api/intent/quote" });
    expect(() => unpinned.tronDepositCall(coercePaymentQuote(tronRaw()))).toThrow(/not trusted/);
  });
});
