import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import { GivroPayBuildTxError } from "../errors.js";
import { GIVRO_PAY_ATTESTED_V1_ABI, GIVRO_PAY_DEPOSIT_ABI, ZERO_ADDRESS } from "./abi.js";

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export function isNativeEvmToken(token: Address): boolean {
  const t = token.toLowerCase();
  return t === ZERO_ADDRESS.toLowerCase() || t === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
}

export interface EvmTxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

function assertCanonicalNonZeroContract(address: string, fieldName: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new GivroPayBuildTxError(`${fieldName} must be a canonical non-zero EVM address`);
  }
}

/** ERC-20: first tx — `approve(depositContract, amount)`. */
export function buildEvmApproveRequest(params: {
  token: Address;
  depositContract: Address;
  amount: bigint;
  /** Explicit override. Defaults to the exact deposit amount. */
  approveAmount?: bigint;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.token, "token");
  assertCanonicalNonZeroContract(params.depositContract, "depositContract");
  return {
    to: params.token,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [params.depositContract, params.approveAmount ?? params.amount],
    }),
  };
}

export interface AttestedOrder {
  chainId: bigint;
  paymentRef: Hex;
  idHash: Hex;
  token: Address;
  amount: bigint;
  cancelBefore: bigint;
  claimBefore: bigint;
  refundAfter: bigint;
}

/** Build deposit tx for `HfiPayAttested` v2 — permissionless, no portal signature required. */
export function buildEvmAttestedDepositRequest(params: {
  depositContract: Address;
  order: AttestedOrder;
  /** Relay node address to receive origin fee share. Omit for no relay (address(0)). */
  originRelayAddress?: Address;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.depositContract, "depositContract");
  const o = params.order;
  const isNative = isNativeEvmToken(o.token);
  const relay: Address = params.originRelayAddress ?? ZERO_ADDRESS;
  return {
    to: params.depositContract,
    value: isNative ? o.amount : 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_ATTESTED_V1_ABI,
      functionName: isNative ? "depositNativeWithOrder" : "depositErc20WithOrder",
      args: [
        {
          chainId: o.chainId,
          paymentRef: o.paymentRef,
          idHash: o.idHash,
          token: o.token,
          amount: o.amount,
          cancelBefore: o.cancelBefore,
          claimBefore: o.claimBefore,
          refundAfter: o.refundAfter,
        },
        relay,
      ],
    }),
  };
}

/**
 * Legacy/basic deposit helper for old `HfiPayDeposit` deployments.
 *
 * Current Givro quotes use `buildEvmAttestedDepositRequest` with
 * `depositNativeWithOrder` / `depositErc20WithOrder`; do not use this helper
 * for attested Rail 1 quotes.
 *
 * @deprecated Use `buildEvmAttestedDepositRequest` for current Givro quotes.
 */
export function buildEvmDepositRequest(params: {
  depositContract: Address;
  paymentRef: Hex;
  token: Address;
  amount: bigint;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.depositContract, "depositContract");
  if (isNativeEvmToken(params.token)) {
    return {
      to: params.depositContract,
      value: params.amount,
      data: encodeFunctionData({
        abi: GIVRO_PAY_DEPOSIT_ABI,
        functionName: "depositNative",
        args: [params.paymentRef],
      }),
    };
  }
  return {
    to: params.depositContract,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_DEPOSIT_ABI,
      functionName: "depositErc20",
      args: [params.paymentRef, params.token, params.amount],
    }),
  };
}

/** Cancel a deposit within the cancelBefore window (payer only). Works with `HfiPayAttestedV1`. */
/** Works on both rails: `cancelByPayer(bytes32)` is selector-identical in v2. */
export function buildEvmCancelRequest(params: {
  depositContract: Address;
  paymentRef: Hex;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.depositContract, "depositContract");
  return {
    to: params.depositContract,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_ATTESTED_V1_ABI,
      functionName: "cancelByPayer",
      args: [params.paymentRef],
    }),
  };
}

export type BindingMessage = {
  idHash: Hex;
  addr: Address;
  issuedAt: bigint;
};

/** Register an EVM address binding for an identifier hash. */
/**
 * v1 only. v2 replaces `bind` with `registerPayoutMandate`, signed over
 * `PAYOUT_MANDATE_TYPES` in the `intentBlindedDomain`.
 */
export function buildEvmBindTx(params: {
  attestedContract: Address;
  message: BindingMessage;
  recipientSig: Hex;
  serverSig: Hex;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.attestedContract, "attestedContract");
  return {
    to: params.attestedContract,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_ATTESTED_V1_ABI,
      functionName: "bind",
      args: [params.message, params.recipientSig, params.serverSig],
    }),
  };
}

/** Revoke a pending binding before it activates. */
/** v1 only. v2's `revokePendingMandate` takes a different argument list. */
export function buildEvmRevokePendingTx(params: {
  attestedContract: Address;
  idHash: Hex;
  nonce: bigint;
  deadline: bigint;
  sig: Hex;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.attestedContract, "attestedContract");
  return {
    to: params.attestedContract,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_ATTESTED_V1_ABI,
      functionName: "revokePending",
      args: [params.idHash, params.nonce, params.deadline, params.sig],
    }),
  };
}

/** Claim a deposited payment (recipient calls after binding is active). */
/**
 * v1 only. The v2 escrow has no `claim(bytes32)`: v1 could resolve the
 * recipient from an on-chain `idHash -> address` registry, and removing that
 * registry is the point of v2. A v2 claim carries a per-payment recipient
 * signature over `INTENT_CLAIM_TYPES`, orchestrated by the portal's
 * `/api/intent/claim/v2/*` endpoints.
 */
export function buildEvmClaimTx(params: {
  attestedContract: Address;
  paymentRef: Hex;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.attestedContract, "attestedContract");
  return {
    to: params.attestedContract,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_ATTESTED_V1_ABI,
      functionName: "claim",
      args: [params.paymentRef],
    }),
  };
}

/** Refund an expired deposit back to the payer. */
/** Works on both rails: `refund(bytes32)` is selector-identical in v2. */
export function buildEvmRefundTx(params: {
  attestedContract: Address;
  paymentRef: Hex;
}): EvmTxRequest {
  assertCanonicalNonZeroContract(params.attestedContract, "attestedContract");
  return {
    to: params.attestedContract,
    value: 0n,
    data: encodeFunctionData({
      abi: GIVRO_PAY_ATTESTED_V1_ABI,
      functionName: "refund",
      args: [params.paymentRef],
    }),
  };
}
