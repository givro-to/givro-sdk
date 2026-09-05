import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import {
  GIVRO_PAY_ESCROW_ABI,
  ZERO_ADDRESS,
  buildEvmCancelTx,
  buildEvmErc20Deposit,
  buildEvmNativeDeposit,
  buildEvmRefundTx,
  escrowDomain,
  isNativeEvmToken,
  type EvmEscrowOrder,
} from "../src/evm/escrow.js";
import { GivroPayBuildTxError } from "../src/errors.js";

const ESCROW = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const ERC20_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const PAYMENT_REF = ("0x" + "ab".repeat(32)) as Hex;
const MANDATE_COMMIT = ("0x" + "00".repeat(32)) as Hex;

function order(token: Address): EvmEscrowOrder {
  return {
    chainId: 8453n,
    paymentRef: PAYMENT_REF,
    intentId: ("0x" + "11".repeat(32)) as Hex,
    blindedBinding: ("0x" + "22".repeat(32)) as Hex,
    bindingEpoch: 1n,
    claimAuthorization: 0,
    token,
    amount: 1_000_000n,
    cancelBefore: 1n,
    claimBefore: 2n,
    refundAfter: 3n,
  };
}

describe("isNativeEvmToken", () => {
  it("treats the zero address and the 0xeeee sentinel as native", () => {
    expect(isNativeEvmToken(ZERO_ADDRESS)).toBe(true);
    expect(isNativeEvmToken("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")).toBe(true);
    expect(isNativeEvmToken(ERC20_TOKEN)).toBe(false);
  });
});

describe("buildEvmNativeDeposit", () => {
  it("encodes the escrow's 11-field order tuple with the mandate commitment", () => {
    const tx = buildEvmNativeDeposit({ escrow: ESCROW, order: order(ZERO_ADDRESS), mandateCommit: MANDATE_COMMIT });
    expect(tx.to).toBe(ESCROW);
    expect(tx.value).toBe(1_000_000n);
    const decoded = decodeFunctionData({ abi: GIVRO_PAY_ESCROW_ABI, data: tx.data });
    expect(decoded.functionName).toBe("depositNativeWithOrder");
    const [tuple, commit] = decoded.args as unknown as [Record<string, unknown>, string];
    expect(Object.keys(tuple)).toHaveLength(11);
    expect(tuple.blindedBinding).toBe("0x" + "22".repeat(32));
    expect(commit).toBe(MANDATE_COMMIT);
  });

  it("refuses a token order, a zero escrow, and a malformed escrow", () => {
    expect(() => buildEvmNativeDeposit({ escrow: ESCROW, order: order(ERC20_TOKEN), mandateCommit: MANDATE_COMMIT }))
      .toThrow(/must be the zero address/);
    expect(() => buildEvmNativeDeposit({ escrow: ZERO_ADDRESS, order: order(ZERO_ADDRESS), mandateCommit: MANDATE_COMMIT }))
      .toThrow(GivroPayBuildTxError);
    expect(() => buildEvmNativeDeposit({ escrow: "0x1234" as Address, order: order(ZERO_ADDRESS), mandateCommit: MANDATE_COMMIT }))
      .toThrow(GivroPayBuildTxError);
  });
});

describe("buildEvmErc20Deposit", () => {
  it("returns approve-then-deposit, approving exactly the deposit amount by default", () => {
    const { approve, deposit } = buildEvmErc20Deposit({ escrow: ESCROW, order: order(ERC20_TOKEN), mandateCommit: MANDATE_COMMIT });
    expect(approve.to.toLowerCase()).toBe(ERC20_TOKEN.toLowerCase());
    expect(approve.value).toBe(0n);
    expect(approve.data.slice(0, 10)).toBe("0x095ea7b3");
    expect(BigInt(`0x${approve.data.slice(-64)}`)).toBe(1_000_000n);
    expect(deposit.to).toBe(ESCROW);
    // Native `value` on an ERC-20 deposit would be silently unrecoverable.
    expect(deposit.value).toBe(0n);
    expect(decodeFunctionData({ abi: GIVRO_PAY_ESCROW_ABI, data: deposit.data }).functionName).toBe("depositErc20WithOrder");
  });

  it("honours an explicit approveAmount", () => {
    const { approve } = buildEvmErc20Deposit({
      escrow: ESCROW, order: order(ERC20_TOKEN), mandateCommit: MANDATE_COMMIT, approveAmount: 500_000n,
    });
    expect(BigInt(`0x${approve.data.slice(-64)}`)).toBe(500_000n);
  });

  it("refuses a native order", () => {
    expect(() => buildEvmErc20Deposit({ escrow: ESCROW, order: order(ZERO_ADDRESS), mandateCommit: MANDATE_COMMIT }))
      .toThrow(/must not be the zero address/);
  });
});

describe("cancel and refund", () => {
  it("target the escrow, never the token, and carry only the paymentRef", () => {
    for (const tx of [
      buildEvmCancelTx({ escrow: ESCROW, paymentRef: PAYMENT_REF }),
      buildEvmRefundTx({ escrow: ESCROW, paymentRef: PAYMENT_REF }),
    ]) {
      expect(tx.to).toBe(ESCROW);
      expect(tx.value).toBe(0n);
      expect(decodeFunctionData({ abi: GIVRO_PAY_ESCROW_ABI, data: tx.data }).args).toEqual([PAYMENT_REF]);
    }
  });
});

describe("escrowDomain", () => {
  it("matches the escrow's EIP-712 domain exactly", () => {
    // These four values are compared byte-for-byte inside the contract. A drift
    // here does not throw anywhere -- it produces signatures that verify
    // nowhere, which is why they are pinned rather than derived.
    expect(escrowDomain(31338, ESCROW)).toEqual({
      name: "HfiPayIntentBlinded",
      version: "1",
      chainId: 31338,
      verifyingContract: ESCROW,
    });
  });
});
