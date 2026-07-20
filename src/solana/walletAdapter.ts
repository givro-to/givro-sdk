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
 *   const result = await signAndSendSolanaAttestedDeposit(wallet, connection, {
 *     programId: new PublicKey(DEFAULT_GIVRO_PAY_PROGRAM_ID),
 *     payer: wallet.publicKey!,
 *     mint: new PublicKey(quote.token),
 *     paymentRef: paymentRefHexToBytes(quote.paymentRef),
 *     amount: BigInt(quote.amount),
 *   });
 *   console.log("deposit tx:", result.signature);
 */

import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { buildSolanaAttestedDepositTransaction } from "./prepareSolanaDeposit.js";
import { GivroPayBuildTxError, GivroPayError, GivroPayTimeoutError } from "../errors.js";

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
    throw new GivroPayError("WALLET_NOT_CONNECTED", "Solana wallet does not support sendTransaction");
  }

  let tx: VersionedTransaction;
  try {
    tx = await buildSolanaAttestedDepositTransaction(connection, params);
  } catch (err) {
    if (err instanceof GivroPayError) throw err;
    throw new GivroPayBuildTxError("could not build Solana attested deposit", { cause: err });
  }
  try {
    const signature = await wallet.sendTransaction(tx, connection);
    return { signature };
  } catch (err) {
    if (err instanceof GivroPayError) throw err;
    throw new GivroPayError("SIGN_FAILED", "Solana wallet failed to sign or send the deposit", { cause: err });
  }
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
    let status: Awaited<ReturnType<Connection["getSignatureStatus"]>>;
    try {
      status = await connection.getSignatureStatus(signature);
    } catch (err) {
      throw new GivroPayError("NETWORK_ERROR", "Solana confirmation RPC request failed", { cause: err });
    }
    const value = status?.value;
    if (value?.err) {
      throw new GivroPayError("TRANSACTION_FAILED", `Solana transaction failed: ${JSON.stringify(value.err)}`);
    }
    if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
      return { slot: value.slot };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new GivroPayTimeoutError(timeoutMs, { code: "NETWORK_TIMEOUT" });
}
