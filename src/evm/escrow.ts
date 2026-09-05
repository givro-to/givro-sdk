// The Givro settlement escrow (`HfiPayIntentBlinded`): transaction builders
// and the EIP-712 material a wallet needs to talk to it.
//
// Every payment commits a fresh `blindedBinding` derived per intent, so no
// two payments to the same person share an on-chain tag. Deposit, cancel and
// refund are plain calls. Claim is not built here: the escrow resolves no
// recipient on its own, so a claim carries either a recipient signature over
// `INTENT_CLAIM_TYPES` or a ZK proof, both produced per payment and
// orchestrated by the portal's claim endpoints.
//
// The ABI, the type strings and the domain are copied from the deployed
// escrow. A drift in any of them yields signatures that verify nowhere and
// calldata that reverts, so they are asserted against a live quote in
// `tests/e2e/liveQuote.e2e.test.ts`.
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { GivroPayBuildTxError } from "../errors.js";
import type { EscrowOrder } from "../types.js";

/** Sentinel for the native gas token in EVM order tuples. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const ORDER_TUPLE = [
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
] as const;

export const GIVRO_PAY_ESCROW_ABI = [
  {
    type: "function",
    name: "depositNativeWithOrder",
    stateMutability: "payable",
    inputs: [
      { name: "order", type: "tuple", components: ORDER_TUPLE },
      { name: "mandateCommit", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "depositErc20WithOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "order", type: "tuple", components: ORDER_TUPLE },
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
 * the integrator pinned at onboarding.
 */
export const escrowDomain = (chainId: number, escrow: Address) =>
  ({
    name: "HfiPayIntentBlinded",
    version: "1",
    chainId,
    verifyingContract: escrow,
  }) as const;

export interface EvmTxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

/** An `EscrowOrder` whose token is already a checksummable EVM address. */
export type EvmEscrowOrder = Omit<EscrowOrder, "token"> & { token: Address };

function assertCanonicalNonZeroContract(address: string, fieldName: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new GivroPayBuildTxError(`${fieldName} must be a canonical non-zero EVM address`);
  }
}

export function isNativeEvmToken(token: string): boolean {
  const t = token.toLowerCase();
  return t === ZERO_ADDRESS || t === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
}

function encodeOrder(order: EvmEscrowOrder) {
  return {
    chainId: order.chainId,
    paymentRef: order.paymentRef,
    intentId: order.intentId,
    blindedBinding: order.blindedBinding,
    bindingEpoch: order.bindingEpoch,
    claimAuthorization: order.claimAuthorization,
    token: order.token,
    amount: order.amount,
    cancelBefore: order.cancelBefore,
    claimBefore: order.claimBefore,
    refundAfter: order.refundAfter,
  };
}

/**
 * Native deposit. `mandateCommit` is `keccak256(abi.encode(mandateSigner, salt))`
 * when the recipient already has a wallet bound, and 32 zero bytes when they do
 * not — a zero commitment is legal and marks the vault as one that cannot be
 * settled unattended, only claimed with the recipient's own signature.
 */
export function buildEvmNativeDeposit(params: {
  escrow: Address;
  order: EvmEscrowOrder;
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
      abi: GIVRO_PAY_ESCROW_ABI,
      functionName: "depositNativeWithOrder",
      args: [encodeOrder(params.order), params.mandateCommit],
    }),
  };
}

/** ERC-20 deposit: approve first, then deposit. Both must be broadcast, in order. */
export function buildEvmErc20Deposit(params: {
  escrow: Address;
  order: EvmEscrowOrder;
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
        abi: GIVRO_PAY_ESCROW_ABI,
        functionName: "depositErc20WithOrder",
        args: [encodeOrder(params.order), params.mandateCommit],
      }),
    },
  };
}

/** Payer-only, and only inside the cancel window. */
export function buildEvmCancelTx(params: { escrow: Address; paymentRef: Hex }): EvmTxRequest {
  assertCanonicalNonZeroContract(params.escrow, "escrow");
  return {
    to: params.escrow,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_ESCROW_ABI,
      functionName: "cancelByPayer",
      args: [params.paymentRef],
    }),
  };
}

/** Permissionless once `refundAfter` has passed; funds return to the payer. */
export function buildEvmRefundTx(params: { escrow: Address; paymentRef: Hex }): EvmTxRequest {
  assertCanonicalNonZeroContract(params.escrow, "escrow");
  return {
    to: params.escrow,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_ESCROW_ABI,
      functionName: "refund",
      args: [params.paymentRef],
    }),
  };
}
