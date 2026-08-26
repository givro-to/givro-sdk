// v2 intent-blinded escrow: the rail the portal actually funds today.
//
// v1 tagged every payment to a recipient with a stable on-chain `idHash`, so
// two payments to the same person were linkable by anyone reading the chain.
// v2 replaces that tag with a `blindedBinding` computed fresh per intent, which
// is why the order tuple gained four fields and why the escrow rejects a
// binding it has already seen.
//
// Deposit, cancel and refund map mechanically from v1. **Claim does not**: v1
// let anyone call `claim(paymentRef)` because the contract resolved the
// recipient from an on-chain registry, and that registry is precisely what v2
// removes. Every v2 claim carries a recipient signature or a ZK proof produced
// per payment, so this module ships the EIP-712 material a wallet needs to
// produce one and leaves the orchestration to the portal's claim endpoints.
//
// The ABI, the type strings and the domain are copied from the escrow that the
// portal deploys. A drift in any of them yields signatures that verify nowhere
// and calldata that reverts, so they are asserted against a live quote in
// `tests/e2e/liveQuote.e2e.test.ts`.
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { GivroPayBuildTxError } from "../errors.js";
import type { EvmTxRequest } from "./prepareEvmDeposit.js";

export const GIVRO_PAY_INTENT_BLINDED_ABI = [
  {
    type: "function",
    name: "depositNativeWithOrder",
    stateMutability: "payable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "chainId", type: "uint256" },
          { name: "paymentRef", type: "bytes32" },
          { name: "intentId", type: "bytes32" },
          { name: "blindedBinding", type: "bytes32" },
          { name: "bindingEpoch", type: "uint64" },
          { name: "claimAuthorization", type: "uint8" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "cancelBefore", type: "uint64" },
          { name: "claimBefore", type: "uint64" },
          { name: "refundAfter", type: "uint64" },
        ],
      },
      { name: "mandateCommit", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "depositErc20WithOrder",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "chainId", type: "uint256" },
          { name: "paymentRef", type: "bytes32" },
          { name: "intentId", type: "bytes32" },
          { name: "blindedBinding", type: "bytes32" },
          { name: "bindingEpoch", type: "uint64" },
          { name: "claimAuthorization", type: "uint8" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "cancelBefore", type: "uint64" },
          { name: "claimBefore", type: "uint64" },
          { name: "refundAfter", type: "uint64" },
        ],
      },
      { name: "mandateCommit", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelByPayer",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentRef", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentRef", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "previewFee",
    stateMutability: "view",
    inputs: [{ name: "paymentRef", type: "bytes32" }],
    outputs: [
      { name: "fee", type: "uint256" },
      { name: "recipientAmount", type: "uint256" },
    ],
  },
] as const;

/** Which authorization route the order commits to, fixed before funding. */
export const CLAIM_AUTHORIZATION = {
  /** First-receipt onboarding: recipient and attester both sign. */
  LazyAttested: 0,
  /** Requires a circuit-produced proof. */
  ZkRegistered: 1,
} as const;
export type ClaimAuthorization =
  (typeof CLAIM_AUTHORIZATION)[keyof typeof CLAIM_AUTHORIZATION];

export interface IntentBlindedOrder {
  chainId: bigint;
  paymentRef: Hex;
  /** Per-payment identifier, bound into every claim digest for this vault. */
  intentId: Hex;
  /** Fresh per intent. The escrow rejects a value it has already seen. */
  blindedBinding: Hex;
  bindingEpoch: bigint;
  claimAuthorization: ClaimAuthorization;
  token: Address;
  amount: bigint;
  /** 0 waives the payer's cancel window entirely. */
  cancelBefore: bigint;
  claimBefore: bigint;
  refundAfter: bigint;
}

/**
 * The mandate a recipient signs to name where their payments land. Mirrors the
 * escrow's `PAYOUT_MANDATE_TYPEHASH`; the strings are load-bearing.
 */
export const PAYOUT_MANDATE_TYPES = {
  PayoutMandate: [
    { name: "mandateSigner", type: "address" },
    { name: "payoutAddress", type: "address" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** What a recipient signs to release one payment to themselves. */
export const INTENT_CLAIM_TYPES = {
  IntentClaim: [
    { name: "paymentRef", type: "bytes32" },
    { name: "intentId", type: "bytes32" },
    { name: "blindedBinding", type: "bytes32" },
    { name: "bindingEpoch", type: "uint64" },
    { name: "recipient", type: "address" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/**
 * EIP-712 domain for both type sets above. `verifyingContract` is the escrow
 * from the quote's `intentBlinded.escrow`, which an integrator should have
 * pinned at onboarding rather than adopted from the quote at runtime.
 */
export const intentBlindedDomain = (chainId: number, escrow: Address) =>
  ({
    name: "HfiPayIntentBlinded",
    version: "1",
    chainId,
    verifyingContract: escrow,
  }) as const;

function assertCanonicalNonZeroContract(address: string, fieldName: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new GivroPayBuildTxError(`${fieldName} must be a canonical non-zero EVM address`);
  }
}

export function isNativeEvmToken(token: string): boolean {
  return token.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

/**
 * Native deposit. `mandateCommit` is `keccak256(abi.encode(mandateSigner, salt))`
 * when the recipient already has a wallet bound, and 32 zero bytes when they do
 * not — a zero commitment is legal and marks the vault as one that cannot be
 * settled unattended, only claimed with the recipient's own signature.
 */
export function buildIntentBlindedNativeDeposit(params: {
  escrow: Address;
  order: IntentBlindedOrder;
  mandateCommit: Hex;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.escrow, "escrow");
  if (!isNativeEvmToken(params.order.token)) {
    throw new GivroPayBuildTxError("order.token must be the zero address for a native deposit");
  }
  return {
    to: params.escrow,
    value: params.order.amount,
    data: encodeFunctionData({
      abi: GIVRO_PAY_INTENT_BLINDED_ABI,
      functionName: "depositNativeWithOrder",
      args: [params.order, params.mandateCommit],
    }),
  };
}

/** ERC-20 deposit: approve first, then deposit. Both must be broadcast, in order. */
export function buildIntentBlindedErc20Deposit(params: {
  escrow: Address;
  order: IntentBlindedOrder;
  mandateCommit: Hex;
  /** Explicit override. Defaults to the exact deposit amount. */
  approveAmount?: bigint;
}): { approve: EvmTxRequest; deposit: EvmTxRequest } {
  assertCanonicalNonZeroContract(params.escrow, "escrow");
  if (isNativeEvmToken(params.order.token)) {
    throw new GivroPayBuildTxError("order.token must not be the zero address for an ERC-20 deposit");
  }
  assertCanonicalNonZeroContract(params.order.token, "order.token");
  return {
    approve: {
      to: params.order.token,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [params.escrow, params.approveAmount ?? params.order.amount],
      }),
    },
    deposit: {
      to: params.escrow,
      value: 0n,
      data: encodeFunctionData({
        abi: GIVRO_PAY_INTENT_BLINDED_ABI,
        functionName: "depositErc20WithOrder",
        args: [params.order, params.mandateCommit],
      }),
    },
  };
}

/** Payer-only, and only inside the cancel window. Same shape as v1. */
export function buildIntentBlindedCancelTx(params: { escrow: Address; paymentRef: Hex }): EvmTxRequest {
  assertCanonicalNonZeroContract(params.escrow, "escrow");
  return {
    to: params.escrow,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_INTENT_BLINDED_ABI,
      functionName: "cancelByPayer",
      args: [params.paymentRef],
    }),
  };
}

/** Permissionless once `refundAfter` has passed. Same shape as v1. */
export function buildIntentBlindedRefundTx(params: { escrow: Address; paymentRef: Hex }): EvmTxRequest {
  assertCanonicalNonZeroContract(params.escrow, "escrow");
  return {
    to: params.escrow,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_INTENT_BLINDED_ABI,
      functionName: "refund",
      args: [params.paymentRef],
    }),
  };
}
