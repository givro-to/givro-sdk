import type { Address, Hex } from "viem";
import { encodeFunctionData, maxUint256 } from "viem";
import { HFI_PAY_ATTESTED_V1_ABI, HFI_PAY_DEPOSIT_ABI, ZERO_ADDRESS } from "./abi.js";

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

/** ERC-20: first tx — `approve(depositContract, amount)` (or max). */
export function buildEvmApproveRequest(params: {
  token: Address;
  depositContract: Address;
  amount: bigint;
  /** default unlimited approve */
  approveAmount?: bigint;
}): EvmTxRequest {
  return {
    to: params.token,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [params.depositContract, params.approveAmount ?? maxUint256],
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
  const o = params.order;
  const isNative = isNativeEvmToken(o.token);
  const relay: Address = params.originRelayAddress ?? ZERO_ADDRESS;
  return {
    to: params.depositContract,
    value: isNative ? o.amount : 0n,
    data: encodeFunctionData({
      abi: HFI_PAY_ATTESTED_V1_ABI,
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

/** Second tx (or only tx for native): deposit into the configured EVM deposit contract (e.g. `HfiPayDeposit`). */
export function buildEvmDepositRequest(params: {
  depositContract: Address;
  paymentRef: Hex;
  token: Address;
  amount: bigint;
}): EvmTxRequest {
  if (isNativeEvmToken(params.token)) {
    return {
      to: params.depositContract,
      value: params.amount,
      data: encodeFunctionData({
        abi: HFI_PAY_DEPOSIT_ABI,
        functionName: "depositNative",
        args: [params.paymentRef],
      }),
    };
  }
  return {
    to: params.depositContract,
    value: 0n,
    data: encodeFunctionData({
      abi: HFI_PAY_DEPOSIT_ABI,
      functionName: "depositErc20",
      args: [params.paymentRef, params.token, params.amount],
    }),
  };
}

/** Cancel a deposit within the cancelBefore window (payer only). Works with `HfiPayAttestedV1`. */
export function buildEvmCancelRequest(params: {
  depositContract: Address;
  paymentRef: Hex;
}): EvmTxRequest {
  return {
    to: params.depositContract,
    value: 0n,
    data: encodeFunctionData({
      abi: HFI_PAY_ATTESTED_V1_ABI,
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
export function buildEvmBindTx(params: {
  attestedContract: Address;
  message: BindingMessage;
  recipientSig: Hex;
  serverSig: Hex;
}): EvmTxRequest {
  return {
    to: params.attestedContract,
    value: 0n,
    data: encodeFunctionData({
      abi: HFI_PAY_ATTESTED_V1_ABI,
      functionName: "bind",
      args: [params.message, params.recipientSig, params.serverSig],
    }),
  };
}

/** Revoke a pending binding before it activates. */
export function buildEvmRevokePendingTx(params: {
  attestedContract: Address;
  idHash: Hex;
  nonce: bigint;
  deadline: bigint;
  sig: Hex;
}): EvmTxRequest {
  return {
    to: params.attestedContract,
    value: 0n,
    data: encodeFunctionData({
      abi: HFI_PAY_ATTESTED_V1_ABI,
      functionName: "revokePending",
      args: [params.idHash, params.nonce, params.deadline, params.sig],
    }),
  };
}

/** Claim a deposited payment (recipient calls after binding is active). */
export function buildEvmClaimTx(params: {
  attestedContract: Address;
  paymentRef: Hex;
}): EvmTxRequest {
  return {
    to: params.attestedContract,
    value: 0n,
    data: encodeFunctionData({
      abi: HFI_PAY_ATTESTED_V1_ABI,
      functionName: "claim",
      args: [params.paymentRef],
    }),
  };
}

/** Refund an expired deposit back to the payer. */
export function buildEvmRefundTx(params: {
  attestedContract: Address;
  paymentRef: Hex;
}): EvmTxRequest {
  return {
    to: params.attestedContract,
    value: 0n,
    data: encodeFunctionData({
      abi: HFI_PAY_ATTESTED_V1_ABI,
      functionName: "refund",
      args: [params.paymentRef],
    }),
  };
}
