// The fixture is a real response recorded from a running portal, not a
// hand-written approximation. Hand-written v2 quotes were exactly the thing
// that let the v1 mismatch go unnoticed: every test agreed with the SDK's own
// idea of the shape, and the server's disagreed.
import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import liveQuote from "./fixtures/liveQuote.v2.evm.json" with { type: "json" };
import { coercePaymentQuote } from "../src/quote.js";
import { createGivroPayClient } from "../src/client.js";
import { buildEvmDepositFromQuote } from "../src/evm/depositFromQuote.js";
import {
  GIVRO_PAY_INTENT_BLINDED_ABI,
  buildIntentBlindedCancelTx,
  buildIntentBlindedErc20Deposit,
  buildIntentBlindedNativeDeposit,
  buildIntentBlindedRefundTx,
  intentBlindedDomain,
} from "../src/evm/prepareIntentBlindedDeposit.js";
import { assertTronAttestedQuote } from "../src/tron/prepareTronAttestedDeposit.js";
import { buildEvmCancelRequest, buildEvmRefundTx } from "../src/evm/prepareEvmDeposit.js";
import { GivroPayBuildTxError, GivroPayQuoteError } from "../src/errors.js";

const RAW = liveQuote as unknown as Record<string, unknown>;
const ESCROW = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

describe("v2 quote parsing", () => {
  it("recognizes a live v2 quote and carries its settlement material", () => {
    const q = coercePaymentQuote(RAW);
    expect(q.protocolVersion).toBe(2);
    expect(q.intentBlinded?.escrow).toBe(ESCROW);
    expect(q.intentBlinded?.order.intentId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(q.intentBlinded?.order.blindedBinding).toMatch(/^0x[0-9a-f]{64}$/);
    expect(q.intentBlinded?.order.amount).toBe(1000000000000000n);
  });

  it("refuses to derive v1 funding fields from a v2 quote", () => {
    // The portal still returns the legacy `order` block, and its
    // `attestedContract` is a real non-zero address -- so nothing about the
    // response stops a v1 builder from accepting it. This is where that stops.
    expect(RAW.order).toBeDefined();
    expect(RAW.attestedContract).toBe(ESCROW);
    const q = coercePaymentQuote(RAW);
    expect(q.depositContract).toBeUndefined();
    expect(q.attestedOrder).toBeUndefined();
  });

  it("still parses a v1 quote the old way", () => {
    const { protocolVersion: _v, intentBlinded: _i, ...v1Raw } = RAW as Record<string, unknown>;
    const q = coercePaymentQuote(v1Raw);
    expect(q.protocolVersion).toBe(1);
    expect(q.depositContract).toBe(ESCROW);
    expect(q.attestedOrder?.idHash).toBeDefined();
  });

  it("rejects a quote that claims v2 but carries nothing", () => {
    const { intentBlinded: _i, ...broken } = RAW as Record<string, unknown>;
    expect(() => coercePaymentQuote(broken)).toThrow(GivroPayQuoteError);
  });

  it("rejects an unknown protocol version rather than guessing", () => {
    expect(() => coercePaymentQuote({ ...RAW, protocolVersion: 3 })).toThrow(GivroPayQuoteError);
  });

  it("rejects a claimAuthorization the escrow has no route for", () => {
    const bad = {
      ...RAW,
      intentBlinded: {
        ...(RAW.intentBlinded as Record<string, unknown>),
        order: { ...((RAW.intentBlinded as Record<string, unknown>).order as object), claimAuthorization: 7 },
      },
    };
    expect(() => coercePaymentQuote(bad)).toThrow(GivroPayQuoteError);
  });
});

describe("v2 deposit building", () => {
  it("encodes the escrow's 11-field order tuple", () => {
    const q = coercePaymentQuote(RAW);
    const plan = buildEvmDepositFromQuote({ quote: q, pinnedEscrow: ESCROW });
    expect(plan.protocolVersion).toBe(2);
    expect(plan.steps).toHaveLength(1);
    const [tx] = plan.steps;
    expect(tx.to).toBe(ESCROW);
    expect(tx.value).toBe(1000000000000000n);
    // Decoding against the escrow ABI is what actually proves the tuple: a
    // field dropped or reordered changes the selector or fails to decode.
    const decoded = decodeFunctionData({ abi: GIVRO_PAY_INTENT_BLINDED_ABI, data: tx.data });
    expect(decoded.functionName).toBe("depositNativeWithOrder");
    const [order, mandateCommit] = decoded.args as unknown as [Record<string, unknown>, string];
    expect(Object.keys(order)).toHaveLength(11);
    expect(order.blindedBinding).toBe(q.intentBlinded?.order.blindedBinding);
    expect(order.intentId).toBe(q.intentBlinded?.order.intentId);
    expect(mandateCommit).toBe(`0x${"0".repeat(64)}`);
  });

  it("returns approve-then-deposit for an ERC-20 payment", () => {
    const token = "0xbded0d2bf404bdcba897a74e6657f1f12e5c6fb6";
    const q = coercePaymentQuote({
      ...RAW,
      token,
      intentBlinded: {
        ...(RAW.intentBlinded as Record<string, unknown>),
        order: { ...((RAW.intentBlinded as Record<string, unknown>).order as object), token },
      },
    });
    const plan = buildEvmDepositFromQuote({ quote: q, pinnedEscrow: ESCROW });
    expect(plan.steps).toHaveLength(2);
    const [approve, deposit] = plan.steps as [typeof plan.steps[0], typeof plan.steps[0]];
    expect(approve.to.toLowerCase()).toBe(token.toLowerCase());
    expect(approve.value).toBe(0n);
    expect(deposit.to).toBe(ESCROW);
    // Native `value` on an ERC-20 deposit would be silently unrecoverable.
    expect(deposit.value).toBe(0n);
  });

  it("refuses an escrow the integrator did not pin", () => {
    const q = coercePaymentQuote(RAW);
    expect(() =>
      buildEvmDepositFromQuote({ quote: q, pinnedEscrow: "0x000000000000000000000000000000000000dEaD" }),
    ).toThrow(/does not match the pinned escrow/);
  });

  it("will not build a v2 deposit without a pinned escrow at all", () => {
    const q = coercePaymentQuote(RAW);
    expect(() => buildEvmDepositFromQuote({ quote: q })).toThrow(GivroPayBuildTxError);
  });

  it("refuses a native build for a token order, and the reverse", () => {
    const q = coercePaymentQuote(RAW);
    const order = q.intentBlinded!.order;
    expect(() =>
      buildIntentBlindedErc20Deposit({
        escrow: ESCROW,
        order: { ...order, token: order.token as `0x${string}` },
        mandateCommit: q.intentBlinded!.mandateCommit,
      }),
    ).toThrow(/must not be the zero address/);
    expect(() =>
      buildIntentBlindedNativeDeposit({
        escrow: ESCROW,
        order: { ...order, token: "0xbded0d2bf404bdcba897a74e6657f1f12e5c6fb6" },
        mandateCommit: q.intentBlinded!.mandateCommit,
      }),
    ).toThrow(/must be the zero address/);
  });

  it("builds cancel and refund against the escrow, never the token", () => {
    const ref = "0xe57b7a1f92c64a6205d929dc3ec60936bff121a5bec6d0ad04b0ce8982897f2c" as const;
    for (const tx of [
      buildIntentBlindedCancelTx({ escrow: ESCROW, paymentRef: ref }),
      buildIntentBlindedRefundTx({ escrow: ESCROW, paymentRef: ref }),
    ]) {
      expect(tx.to).toBe(ESCROW);
      expect(tx.value).toBe(0n);
      expect(decodeFunctionData({ abi: GIVRO_PAY_INTENT_BLINDED_ABI, data: tx.data }).args).toEqual([ref]);
    }
  });
});

describe("v2 signing domain", () => {
  it("matches the escrow's EIP-712 domain exactly", () => {
    // These four values are compared byte-for-byte inside the contract. A drift
    // here does not throw anywhere -- it produces signatures that verify
    // nowhere, which is why they are pinned rather than derived.
    expect(intentBlindedDomain(31338, ESCROW)).toEqual({
      name: "HfiPayIntentBlinded",
      version: "1",
      chainId: 31338,
      verifyingContract: ESCROW,
    });
  });
});

describe("the v1 surface, against a v2 escrow", () => {
  it("tells a Tron caller the rail moved, not that a field is missing", () => {
    const q = coercePaymentQuote({ ...RAW, ecosystem: "tron" });
    expect(() => assertTronAttestedQuote(q)).toThrow(/v2 intent-blinded rail/);
  });

  it("keeps cancel and refund usable, because v2 kept their selectors", () => {
    // Verified against the deployed escrow's bytecode: `cancelByPayer(bytes32)`
    // and `refund(bytes32)` are byte-identical across the two rails, so these
    // two v1 builders are not stale and must not be fenced off with the rest.
    const ref = "0xe57b7a1f92c64a6205d929dc3ec60936bff121a5bec6d0ad04b0ce8982897f2c" as const;
    for (const tx of [
      buildEvmCancelRequest({ depositContract: ESCROW, paymentRef: ref }),
      buildEvmRefundTx({ attestedContract: ESCROW, paymentRef: ref }),
    ]) {
      const v2 = decodeFunctionData({ abi: GIVRO_PAY_INTENT_BLINDED_ABI, data: tx.data });
      expect(v2.args).toEqual([ref]);
    }
  });
});

describe("prepareEvmTransactions -- the documented entry point", () => {
  const client = () =>
    createGivroPayClient({
      quoteUrl: "https://example.invalid/api/intent/quote",
      trustedAttestedContracts: { "evm:31338": [ESCROW] },
    });

  it("routes a v2 quote to the v2 escrow instead of failing closed", () => {
    const { approve, deposit } = client().prepareEvmTransactions({ quote: coercePaymentQuote(RAW) });
    expect(approve).toBeNull();
    expect(deposit.to).toBe(ESCROW);
    expect(decodeFunctionData({ abi: GIVRO_PAY_INTENT_BLINDED_ABI, data: deposit.data }).functionName)
      .toBe("depositNativeWithOrder");
  });

  it("still refuses an escrow outside the caller's pin list", () => {
    const wrong = createGivroPayClient({
      quoteUrl: "https://example.invalid/api/intent/quote",
      trustedAttestedContracts: { "evm:31338": ["0x000000000000000000000000000000000000dEaD"] },
    });
    expect(() => wrong.prepareEvmTransactions({ quote: coercePaymentQuote(RAW) })).toThrow(/not trusted/);
  });

  it("refuses a v2 quote whose escrow disagrees with its own attestedContract", () => {
    // The two fields are issued together and always agree today. If a portal
    // ever emitted a quote where they differ, one of them is the address the
    // caller pinned and the other is where the money would go.
    const split = {
      ...RAW,
      intentBlinded: {
        ...(RAW.intentBlinded as Record<string, unknown>),
        escrow: "0x000000000000000000000000000000000000dEaD",
      },
    };
    expect(() => client().prepareEvmTransactions({ quote: coercePaymentQuote(split) }))
      .toThrow(/disagrees with/);
  });
});
