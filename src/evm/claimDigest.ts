import { concatBytes, pad, sha256, toBytes, type Address, type Hex } from "viem";

/** Must match `hfi_pay_core` / EVM `HfiPayClaimDigest` / Solana program. */
export const HFI_PAY_DEPLOYMENT_DOMAIN = "hfi-pay:v1" as const;

const CHAIN_TAG_EVM = 0x01;

function leU64(n: bigint): Uint8Array {
  const v = n < 0n ? 0n : n;
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return b;
}

/**
 * Claim message digest for EVM leg (`chain_tag = 1`), aligned with
 * `hfi_pay_core::zk::compute_hfipay_claim_message_digest` and `HfiPayClaimDigest.sol`.
 */
export function hfipayClaimDigestEvm(params: {
  hasErc20: boolean;
  /** For ERC-20: left-padded 32-byte mint; ignored when `hasErc20` is false. */
  mint32?: Hex | Uint8Array;
  bindingEpoch: bigint;
  intentId: Hex | Uint8Array;
  blindedBinding: Hex | Uint8Array;
  amount: bigint;
  destinationEvm: Address;
  expiry: bigint;
  nonce: bigint;
}): Hex {
  const head: Uint8Array[] = [
    toBytes("hfipay:claim"),
    toBytes(HFI_PAY_DEPLOYMENT_DOMAIN),
    Uint8Array.of(CHAIN_TAG_EVM),
  ];
  if (params.hasErc20) {
    const mint: Uint8Array =
      params.mint32 instanceof Uint8Array
        ? params.mint32
        : (pad(toBytes(params.mint32 as Hex), { size: 32 }) as Uint8Array);
    if (mint.length !== 32) throw new Error("mint32 must be 32 bytes");
    head.push(Uint8Array.of(1), mint);
  } else {
    head.push(Uint8Array.of(0));
  }
  const intent: Uint8Array =
    params.intentId instanceof Uint8Array
      ? params.intentId
      : (pad(toBytes(params.intentId as Hex), { size: 32 }) as Uint8Array);
  const blinded: Uint8Array =
    params.blindedBinding instanceof Uint8Array
      ? params.blindedBinding
      : (pad(toBytes(params.blindedBinding as Hex), { size: 32 }) as Uint8Array);
  if (intent.length !== 32 || blinded.length !== 32) throw new Error("intentId / blindedBinding must be 32 bytes");
  const dest20 = toBytes(params.destinationEvm);
  if (dest20.length !== 20) throw new Error("destinationEvm must be 20 bytes");
  const packed = concatBytes([
    ...head,
    leU64(params.bindingEpoch),
    intent,
    blinded,
    leU64(params.amount),
    dest20,
    leU64(params.expiry),
    leU64(params.nonce),
  ]);
  return sha256(packed);
}
