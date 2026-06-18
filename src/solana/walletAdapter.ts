/**
 * Helpers for @solana/wallet-adapter-react (Phantom, Solflare, etc.).
 *
 * These wrap the low-level transaction builders so wallet integrators
 * only need a connected WalletContextState and a Connection.
 *
 * Usage (React + @solana/wallet-adapter-react):
 *
 *   const wallet = useWallet();
 *   const { connection } = useConnection();
 *
 *   const result = await signAndSendSolanaDeposit(wallet, connection, {
 *     programId: new PublicKey(DEFAULT_HFI_PAY_PROGRAM_ID),
 *     payer: wallet.publicKey!,
 *     mint: new PublicKey(quote.token),
 *     paymentRef: paymentRefHexToBytes(quote.paymentRef),
 *     amount: BigInt(quote.amount),
 *   });
 *   console.log("deposit tx:", result.signature);
 */

import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { buildSolanaAttestedDepositTransaction } from "./prepareSolanaDeposit.js";

/** Minimal interface satisfied by @solana/wallet-adapter-react WalletContextState. */
export interface SolanaWalletLike {
  signTransaction?: <T extends VersionedTransaction>(tx: T) => Promise<T>;
  sendTransaction?: (tx: VersionedTransaction, connection: Connection) => Promise<string>;
}

export interface SolanaDepositResult {
  /** Transaction signature (base58). */
  signature: string;
}

/**
 * Build, sign, and send a Solana attested deposit in one call.
 */
export async function signAndSendSolanaAttestedDeposit(
  wallet: SolanaWalletLike,
  connection: Connection,
  params: Parameters<typeof buildSolanaAttestedDepositTransaction>[1],
): Promise<SolanaDepositResult> {
  if (!wallet.sendTransaction) {
    throw new Error("Wallet does not support sendTransaction");
  }

  const tx = await buildSolanaAttestedDepositTransaction(connection, params);
  const signature = await wallet.sendTransaction(tx, connection);
  return { signature };
}

/**
 * Wait for a Solana transaction to reach "confirmed" commitment.
 * Returns the slot it was confirmed in.
 */
export async function waitForSolanaConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs = 60_000,
): Promise<{ slot: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(signature);
    const conf = status?.value?.confirmationStatus;
    if (conf === "confirmed" || conf === "finalized") {
      return { slot: status!.value!.slot };
    }
    if (status?.value?.err) {
      throw new Error(`Solana transaction failed: ${JSON.stringify(status.value.err)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Solana transaction not confirmed within ${timeoutMs}ms`);
}
