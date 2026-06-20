/** Must match `declare_id!` after you deploy; replace for mainnet. */
export const DEFAULT_HFI_PAY_PROGRAM_ID = "B8sLQ5g6ABbZyyuyx9hia4kFv8nMo4wCqWXcLcR9XpJZ";

/** sha256("global:deposit_spl").slice(0,8) */
export const DEPOSIT_SPL_DISCRIMINATOR = Uint8Array.from([224, 0, 198, 175, 198, 47, 105, 204]);

/** sha256("global:deposit_native").slice(0,8) */
export const DEPOSIT_NATIVE_DISCRIMINATOR = Uint8Array.from([13, 158, 13, 223, 95, 213, 28, 6]);

/** sha256("global:claim").slice(0,8) */
export const CLAIM_DISCRIMINATOR = Uint8Array.from([62, 198, 214, 193, 213, 159, 108, 210]);

/** sha256("global:claim_native").slice(0,8) */
export const CLAIM_NATIVE_DISCRIMINATOR = Uint8Array.from([65, 171, 104, 250, 157, 187, 30, 151]);
