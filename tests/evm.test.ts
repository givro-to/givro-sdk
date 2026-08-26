import { describe, it, expect } from "vitest";
import {
  isNativeEvmToken,
  buildEvmDepositRequest,
  buildEvmApproveRequest,
  buildEvmAttestedDepositRequest,
} from "../src/evm/prepareEvmDeposit.js";
import { tronAttestedOrderTupleFromQuote } from "../src/tron/prepareTronAttestedDeposit.js";
import { GivroPayBuildTxError } from "../src/errors.js";
import { hfipayClaimDigestEvm } from "../src/evm/claimDigest.js";
import { GIVRO_PAY_ATTESTED_V1_ABI, ZERO_ADDRESS } from "../src/evm/abi.js";
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from "viem";

const DEPOSIT_CONTRACT = "0xdEADbeEF00000000000000000000000000000001" as Address;
const ERC20_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address; // USDC
const PAYMENT_REF = ("0x" + "ab".repeat(32)) as Hex;
const AMOUNT = 1_000_000n;

describe("isNativeEvmToken", () => {
  it("returns true for zero address", () => {
    expect(isNativeEvmToken(ZERO_ADDRESS)).toBe(true);
  });

  it("returns true for 0xeeee...eeee sentinel", () => {
    expect(isNativeEvmToken("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address)).toBe(true);
  });

  it("returns true for lowercase zero address", () => {
    expect(isNativeEvmToken("0x0000000000000000000000000000000000000000" as Address)).toBe(true);
  });

  it("returns false for a real ERC-20 address", () => {
    expect(isNativeEvmToken(ERC20_TOKEN)).toBe(false);
  });

  it("returns false for a random non-sentinel address", () => {
    expect(isNativeEvmToken("0x1234567890123456789012345678901234567890" as Address)).toBe(false);
  });
});

describe("buildEvmDepositRequest — native token", () => {
  const req = buildEvmDepositRequest({
    depositContract: DEPOSIT_CONTRACT,
    paymentRef: PAYMENT_REF,
    token: ZERO_ADDRESS,
    amount: AMOUNT,
  });

  it("sends to the deposit contract", () => {
    expect(req.to.toLowerCase()).toBe(DEPOSIT_CONTRACT.toLowerCase());
  });

  it("sets value to the amount", () => {
    expect(req.value).toBe(AMOUNT);
  });

  it("encodes depositNative selector in calldata", () => {
    // keccak256("depositNative(bytes32)")[0..4] — just verify it starts with 0x and has data
    expect(req.data).toMatch(/^0x[0-9a-f]+$/i);
    // depositNative(bytes32) selector
    expect(req.data.slice(0, 10)).toBe("0x42ef5fbb");
  });
});

describe("buildEvmAttestedDepositRequest", () => {
  it("encodes current attested native deposit selector", () => {
    const req = buildEvmAttestedDepositRequest({
      depositContract: DEPOSIT_CONTRACT,
      order: {
        chainId: 8453n,
        paymentRef: PAYMENT_REF,
        idHash: ("0x" + "cd".repeat(32)) as Hex,
        token: ZERO_ADDRESS,
        amount: AMOUNT,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    });
    expect(req.to.toLowerCase()).toBe(DEPOSIT_CONTRACT.toLowerCase());
    expect(req.value).toBe(AMOUNT);
    expect(req.data.slice(0, 10)).toBe("0x5476871e");
  });

  it("rejects zero and non-canonical settlement contract addresses", () => {
    const order = {
      chainId: 8453n,
      paymentRef: PAYMENT_REF,
      idHash: ("0x" + "cd".repeat(32)) as Hex,
      token: ZERO_ADDRESS,
      amount: AMOUNT,
      cancelBefore: 1n,
      claimBefore: 2n,
      refundAfter: 3n,
    };
    expect(() => buildEvmAttestedDepositRequest({ depositContract: ZERO_ADDRESS, order }))
      .toThrow(GivroPayBuildTxError);
    expect(() => buildEvmAttestedDepositRequest({
      depositContract: "0x1234" as Address,
      order,
    })).toThrow(GivroPayBuildTxError);
  });
});

describe("tronAttestedOrderTupleFromQuote", () => {
  it("returns the tuple shape and order expected by GivroPayAttestedTron", () => {
    const order = tronAttestedOrderTupleFromQuote({
      protocolVersion: 1,
      paymentRef: PAYMENT_REF,
      amount: AMOUNT.toString(),
      token: "native",
      ecosystem: "tron",
      chainId: 728126428,
      attestedContract: DEPOSIT_CONTRACT,
      attestedOrder: {
        chainId: 728126428n,
        paymentRef: PAYMENT_REF,
        idHash: ("0x" + "cd".repeat(32)) as Hex,
        token: "native",
        amount: AMOUNT,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    });

    expect(Object.keys(order)).toEqual([
      "chainId",
      "paymentRef",
      "idHash",
      "token",
      "amount",
      "cancelBefore",
      "claimBefore",
      "refundAfter",
    ]);
    expect(order.chainId).toBe("728126428");
    expect(order.token).toBe(ZERO_ADDRESS);

    const data = encodeFunctionData({
      abi: GIVRO_PAY_ATTESTED_V1_ABI,
      functionName: "depositNativeWithOrder",
      args: [order as any, ZERO_ADDRESS],
    });
    const decoded = decodeFunctionData({ abi: GIVRO_PAY_ATTESTED_V1_ABI, data });
    expect(decoded.functionName).toBe("depositNativeWithOrder");
    expect((decoded.args[0] as { chainId: bigint }).chainId).toBe(728126428n);
    expect((decoded.args[0] as { paymentRef: Hex }).paymentRef).toBe(PAYMENT_REF);
  });

  it("uses a typed build error for a non-Tron quote", () => {
    expect(() => tronAttestedOrderTupleFromQuote({
      protocolVersion: 1,
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      ecosystem: "evm",
      amount: "1",
      token: "0x0000000000000000000000000000000000000000",
    })).toThrow(GivroPayBuildTxError);
  });
});

describe("hfipayClaimDigestEvm", () => {
  it("matches the canonical EVM claim digest test vector", () => {
    const digest = hfipayClaimDigestEvm({
      chainId: 8453n,
      verifyingContract: "0x1111111111111111111111111111111111111111",
      hasErc20: true,
      mint32: "0x0000000000000000000000002222222222222222222222222222222222222222",
      bindingEpoch: 0n,
      intentId: ("0x" + "ab".repeat(32)) as Hex,
      blindedBinding: ("0x" + "cd".repeat(32)) as Hex,
      amount: 1_000_000n,
      destinationEvm: "0x3333333333333333333333333333333333333333",
      expiry: 1_800_000_000n,
      nonce: 7n,
    });
    expect(digest).toBe("0x063c569be121c102820db3040bb9d132c9e9773243b0c8409e0ec5abdc49a1ee");
  });
});

describe("buildEvmDepositRequest — ERC-20 token", () => {
  const req = buildEvmDepositRequest({
    depositContract: DEPOSIT_CONTRACT,
    paymentRef: PAYMENT_REF,
    token: ERC20_TOKEN,
    amount: AMOUNT,
  });

  it("sends to the deposit contract", () => {
    expect(req.to.toLowerCase()).toBe(DEPOSIT_CONTRACT.toLowerCase());
  });

  it("sets value to zero", () => {
    expect(req.value).toBe(0n);
  });

  it("encodes depositErc20 selector in calldata", () => {
    expect(req.data).toMatch(/^0x[0-9a-f]+$/i);
    // depositErc20(bytes32,address,uint256) selector
    expect(req.data.slice(0, 10)).toBe("0xbe056b28");
  });
});

describe("buildEvmApproveRequest", () => {
  it("targets the ERC-20 token contract", () => {
    const req = buildEvmApproveRequest({
      token: ERC20_TOKEN,
      depositContract: DEPOSIT_CONTRACT,
      amount: AMOUNT,
    });
    expect(req.to.toLowerCase()).toBe(ERC20_TOKEN.toLowerCase());
  });

  it("sets value to zero", () => {
    const req = buildEvmApproveRequest({
      token: ERC20_TOKEN,
      depositContract: DEPOSIT_CONTRACT,
      amount: AMOUNT,
    });
    expect(req.value).toBe(0n);
  });

  it("encodes approve selector", () => {
    const req = buildEvmApproveRequest({
      token: ERC20_TOKEN,
      depositContract: DEPOSIT_CONTRACT,
      amount: AMOUNT,
    });
    // keccak256("approve(address,uint256)")[0..4] = 0x095ea7b3
    expect(req.data.slice(0, 10)).toBe("0x095ea7b3");
  });

  it("uses the exact deposit amount when approveAmount is omitted", () => {
    const req = buildEvmApproveRequest({
      token: ERC20_TOKEN,
      depositContract: DEPOSIT_CONTRACT,
      amount: AMOUNT,
    });
    expect(BigInt(`0x${req.data.slice(-64)}`)).toBe(AMOUNT);
  });

  it("encodes a specific approveAmount when provided", () => {
    const specificAmount = 500_000n;
    const req = buildEvmApproveRequest({
      token: ERC20_TOKEN,
      depositContract: DEPOSIT_CONTRACT,
      amount: AMOUNT,
      approveAmount: specificAmount,
    });
    expect(BigInt(`0x${req.data.slice(-64)}`)).toBe(specificAmount);
  });
});
