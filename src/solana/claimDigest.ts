import { concatBytes, sha256, toBytes } from "viem";

import { HFI_PAY_DEPLOYMENT_DOMAIN } from "../evm/claimDigest.js";

const CHAIN_TAG_SVM = 0x02;

function leU64(n: bigint): Uint8Array {
  const v = n < 0n ? 0n : n;
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return b;
}

/**
 * Same as `VmAddress::Svm` auth bytes in `hfi_pay_core::intent`:
 * `SHA-256("svm:" || pubkey32)`.
 */
export function svmDestinationAuthBytes(recipientPubkey: Uint8Array): Uint8Array {
  if (recipientPubkey.length !== 32) throw new Error("Solana pubkey must be 32 bytes");
  return sha256(concatBytes([toBytes("svm:"), recipientPubkey]), "bytes");
}

/**
 * Claim message digest for Solana SPL path (`chain_tag = 2`, SPL mint present),
 * aligned with the `hfi-pay` program and `compute_hfipay_claim_message_digest`
 * when the prover supplies the same destination encoding as `claim_message` / ZK.
 */
export function hfipayClaimDigestSvmSpl(params: {
  mint: Uint8Array;
  bindingEpoch: bigint;
  intentId: Uint8Array;
  blindedBinding: Uint8Array;
  amount: bigint;
  recipientPubkey: Uint8Array;
  expiry: bigint;
  nonce: bigint;
}): Uint8Array {
  if (params.mint.length !== 32) throw new Error("mint must be 32 bytes");
  if (params.intentId.length !== 32 || params.blindedBinding.length !== 32) {
    throw new Error("intentId / blindedBinding must be 32 bytes");
  }
  const dest = svmDestinationAuthBytes(params.recipientPubkey);
  const packed = concatBytes([
    toBytes("hfipay:claim"),
    toBytes(HFI_PAY_DEPLOYMENT_DOMAIN),
    Uint8Array.of(CHAIN_TAG_SVM),
    Uint8Array.of(1),
    params.mint,
    leU64(params.bindingEpoch),
    params.intentId,
    params.blindedBinding,
    leU64(params.amount),
    dest,
    leU64(params.expiry),
    leU64(params.nonce),
  ]);
  return sha256(packed, "bytes");
}
