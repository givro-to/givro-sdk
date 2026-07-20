import { concatBytes, pad, sha256, toBytes, type Address, type Hex } from "viem";

/**
 * Protocol domain-separation constant. Must match `hfi_pay_core` / EVM
 * `HfiPayClaimDigest.sol` / Solana program byte-for-byte. The value predates
 * the Givro rebrand and is hashed into on-chain claim digests — never rename
 * or rebrand it.
 */
export const HFI_PAY_DEPLOYMENT_DOMAIN = "hfi-pay:v1" as const;

const CHAIN_TAG_EVM = 0x01;

function leU64(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new Error("value must fit uint64");
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
}

function beU256(n: bigint): Uint8Array {
  if (n < 0n || n > (1n << 256n) - 1n) throw new Error("chainId must fit uint256");
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}

function bytes32(value: Hex | Uint8Array, label: string): Uint8Array {
  const out = value instanceof Uint8Array ? value : (pad(toBytes(value), { size: 32 }) as Uint8Array);
  if (out.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return out;
}

/**
 * Claim message digest for EVM leg (`chain_tag = 1`), aligned with
 * `hfi_pay_core::zk::compute_hfipay_claim_message_digest` and `HfiPayClaimDigest.sol`.
 */
export function hfipayClaimDigestEvm(params: {
  chainId: bigint;
  verifyingContract: Address;
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
  const deploymentHash = sha256(concatBytes([
    toBytes(HFI_PAY_DEPLOYMENT_DOMAIN),
    beU256(params.chainId),
    toBytes(params.verifyingContract),
  ]), "bytes");

  const assetBytes: Uint8Array[] = [Uint8Array.of(CHAIN_TAG_EVM)];
  if (params.hasErc20) {
    if (!params.mint32) throw new Error("mint32 is required when hasErc20 is true");
    assetBytes.push(Uint8Array.of(1), bytes32(params.mint32, "mint32"));
  } else {
    assetBytes.push(Uint8Array.of(0));
  }
  const assetHash = sha256(concatBytes(assetBytes), "bytes");
  const domainHash = sha256(concatBytes([deploymentHash, assetHash]), "bytes");

  const intent = bytes32(params.intentId, "intentId");
  const blinded = bytes32(params.blindedBinding, "blindedBinding");
  const dest20 = toBytes(params.destinationEvm);
  if (dest20.length !== 20) throw new Error("destinationEvm must be 20 bytes");

  const bodyAHash = sha256(concatBytes([
    leU64(params.bindingEpoch),
    intent,
    blinded,
  ]), "bytes");
  const bodyBHash = sha256(concatBytes([
    leU64(params.amount),
    dest20,
    leU64(params.expiry),
    leU64(params.nonce),
  ]), "bytes");
  const bodyHash = sha256(concatBytes([bodyAHash, bodyBHash]), "bytes");

  return sha256(concatBytes([
    toBytes("hfipay:claim"),
    domainHash,
    bodyHash,
  ]));
}
