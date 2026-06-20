import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DEPOSIT_SPL_DISCRIMINATOR,
  DEPOSIT_NATIVE_DISCRIMINATOR,
} from "./constants.js";
import { configPda, mintPolicyPda, vaultAuthorityPda, vaultAtaPda, vaultMetaPda } from "./pda.js";

const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");

function encodeDepositSplData(
  paymentRef: Uint8Array,
  idHash: Uint8Array,
  amount: bigint,
  cancelBefore: bigint,
  claimBefore: bigint,
  refundAfter: bigint,
  originRelay: Uint8Array,
): Buffer {
  const buf = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 8 + 8 + 32);
  Buffer.from(DEPOSIT_SPL_DISCRIMINATOR).copy(buf, 0);
  Buffer.from(paymentRef).copy(buf, 8);
  Buffer.from(idHash).copy(buf, 40);
  buf.writeBigUInt64LE(amount, 72);
  buf.writeBigInt64LE(cancelBefore, 80);
  buf.writeBigInt64LE(claimBefore, 88);
  buf.writeBigInt64LE(refundAfter, 96);
  Buffer.from(originRelay).copy(buf, 104);
  return buf;
}

function encodeDepositNativeData(
  paymentRef: Uint8Array,
  idHash: Uint8Array,
  amount: bigint,
  cancelBefore: bigint,
  claimBefore: bigint,
  refundAfter: bigint,
  originRelay: Uint8Array,
): Buffer {
  const buf = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 8 + 8 + 32);
  Buffer.from(DEPOSIT_NATIVE_DISCRIMINATOR).copy(buf, 0);
  Buffer.from(paymentRef).copy(buf, 8);
  Buffer.from(idHash).copy(buf, 40);
  buf.writeBigUInt64LE(amount, 72);
  buf.writeBigInt64LE(cancelBefore, 80);
  buf.writeBigInt64LE(claimBefore, 88);
  buf.writeBigInt64LE(refundAfter, 96);
  Buffer.from(originRelay).copy(buf, 104);
  return buf;
}

export interface AttestedSolanaOrder {
  paymentRef: Uint8Array; // 32 bytes
  idHash: Uint8Array;     // 32 bytes
  mint: PublicKey;
  amount: bigint;
  cancelBefore: bigint;
  claimBefore: bigint;
  refundAfter: bigint;
}

/** Build a VersionedTransaction for a permissionless Solana deposit.
 *  No portal signature required — SDK computes all params locally. */
export async function buildSolanaAttestedDepositTransaction(
  _connection: unknown,
  params: {
    programId: PublicKey;
    payer: PublicKey;
    order: AttestedSolanaOrder;
    /** Relay node pubkey for off-chain fee attribution. Omit for no relay. */
    originRelayAddress?: PublicKey;
    recentBlockhash: string;
  }
): Promise<VersionedTransaction> {
  const { programId, payer, order } = params;
  const relayBytes = (params.originRelayAddress ?? PublicKey.default).toBuffer();
  const isNative = order.mint.equals(PublicKey.default) ||
    order.mint.toBase58() === "11111111111111111111111111111111";

  const ixs: TransactionInstruction[] = [];

  const vaultAuthority = vaultAuthorityPda(programId, order.paymentRef);
  const vaultMeta = vaultMetaPda(programId, order.paymentRef);
  const config = configPda(programId);
  const mintPolicy = mintPolicyPda(programId, isNative ? PublicKey.default : order.mint);

  if (isNative) {
    ixs.push(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: mintPolicy, isSigner: false, isWritable: false },
        { pubkey: vaultAuthority, isSigner: false, isWritable: true },
        { pubkey: vaultMeta, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeDepositNativeData(
        order.paymentRef, order.idHash, order.amount,
        order.cancelBefore, order.claimBefore, order.refundAfter, relayBytes,
      ),
    }));
  } else {
    const vaultAta = vaultAtaPda(programId, order.paymentRef);
    const payerAta = getAssociatedTokenAddressSync(order.mint, payer);

    ixs.push(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: order.mint, isSigner: false, isWritable: false },
        { pubkey: mintPolicy, isSigner: false, isWritable: false },
        { pubkey: payerAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultMeta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: encodeDepositSplData(
        order.paymentRef, order.idHash, order.amount,
        order.cancelBefore, order.claimBefore, order.refundAfter, relayBytes,
      ),
    }));
  }

  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: params.recentBlockhash,
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}
