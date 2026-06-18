/**
 * wagmi / viem adapter helpers.
 *
 * These convert SDK `EvmTxRequest` objects into the exact shape that
 * wagmi's `useSendTransaction` / `useWriteContract` hooks expect, so
 * wallet integrators don't need to touch raw encoding.
 *
 * Usage (React + wagmi v2):
 *
 *   const { sendTransactionAsync } = useSendTransaction();
 *   const txs = client.prepareEvmTransactions({ quote, depositContract });
 *   if (txs.approve) await sendTransactionAsync(toWagmiSendParams(txs.approve));
 *   await sendTransactionAsync(toWagmiSendParams(txs.deposit));
 */

import type { EvmTxRequest } from "./prepareEvmDeposit.js";
import type { Address, Hex } from "viem";

/** Shape accepted by wagmi v2 `useSendTransaction` / `sendTransactionAsync`. */
export interface WagmiSendParams {
  to: Address;
  data: Hex;
  value: bigint;
  /** Optional gas limit override. Wallets estimate automatically when omitted. */
  gas?: bigint;
}

/** Convert a single SDK EvmTxRequest to wagmi send params. */
export function toWagmiSendParams(tx: EvmTxRequest, gas?: bigint): WagmiSendParams {
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value,
    ...(gas !== undefined ? { gas } : {}),
  };
}

/**
 * EVM full send sequence: returns [approve?, deposit] as wagmi params.
 * Null approve means native token — skip it.
 *
 * Example:
 *   const steps = toWagmiSendSequence(txs);
 *   for (const step of steps) {
 *     const hash = await sendTransactionAsync(step);
 *     await waitForTransactionReceipt(publicClient, { hash });
 *   }
 */
export function toWagmiSendSequence(txs: {
  approve: EvmTxRequest | null;
  deposit: EvmTxRequest;
}): WagmiSendParams[] {
  const steps: WagmiSendParams[] = [];
  if (txs.approve) steps.push(toWagmiSendParams(txs.approve));
  steps.push(toWagmiSendParams(txs.deposit));
  return steps;
}

/** Shape accepted by wagmi v2 `useWaitForTransactionReceipt`. */
export interface WagmiWaitParams {
  hash: Hex;
  chainId?: number;
}

/** Wrap a raw tx hash string (from wallet API) into a wagmi-compatible wait request. */
export function toWagmiWaitParams(hash: string, chainId?: number): WagmiWaitParams {
  const h = hash.startsWith("0x") ? (hash as Hex) : (`0x${hash}` as Hex);
  return { hash: h, ...(chainId !== undefined ? { chainId } : {}) };
}
