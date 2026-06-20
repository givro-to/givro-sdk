import { PublicKey } from "@solana/web3.js";

const SEED_CONFIG          = Buffer.from("config");
const SEED_VAULT_AUTHORITY = Buffer.from("vault_authority");
const SEED_VAULT_ATA       = Buffer.from("vault_ata");
const SEED_VAULT_META      = Buffer.from("vault_meta");
const SEED_BINDING         = Buffer.from("binding");
const SEED_MINT_POLICY     = Buffer.from("mint_policy");

export function configPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_CONFIG], programId);
  return pda;
}

export function vaultAuthorityPda(programId: PublicKey, paymentRef: Uint8Array): PublicKey {
  if (paymentRef.length !== 32) throw new Error("paymentRef must be 32 bytes");
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_VAULT_AUTHORITY, Buffer.from(paymentRef)],
    programId,
  );
  return pda;
}

export function vaultAtaPda(programId: PublicKey, paymentRef: Uint8Array): PublicKey {
  if (paymentRef.length !== 32) throw new Error("paymentRef must be 32 bytes");
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_VAULT_ATA, Buffer.from(paymentRef)],
    programId,
  );
  return pda;
}

export function vaultMetaPda(programId: PublicKey, paymentRef: Uint8Array): PublicKey {
  if (paymentRef.length !== 32) throw new Error("paymentRef must be 32 bytes");
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_VAULT_META, Buffer.from(paymentRef)],
    programId,
  );
  return pda;
}

export function bindingPda(programId: PublicKey, idHash: Uint8Array): PublicKey {
  if (idHash.length !== 32) throw new Error("idHash must be 32 bytes");
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_BINDING, Buffer.from(idHash)],
    programId,
  );
  return pda;
}

export function mintPolicyPda(programId: PublicKey, mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_MINT_POLICY, mint.toBuffer()],
    programId,
  );
  return pda;
}
