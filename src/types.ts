import type { RecipientKind } from "./identifier.js";

/** The VM / ecosystem a payment runs on. */
export type ChainVm = "evm" | "solana" | "tron";

export interface QuoteRequestBody {
  identifier: string;
  identifierKind: RecipientKind;
  /** Smallest units as decimal string (EVM wei / Solana raw amount / Tron sun or token raw) */
  amountWei: string;
  /**
   * Human amount label for `POST /api/intent/quote` (e.g. `"10.5"`).
   * Required for best UX on the portal; when omitted, the SDK sends `amountWei` as `amount` as well.
   */
  amount?: string;
  /**
   * Token identifier. Accepts:
   *  - EVM: checksummed `0x` token address, or a native symbol such as ETH
   *  - Solana: base58 mint address, or "SOL" for native SOL
   *  - Tron: TRC20 contract (base58), or "TRX" for native TRX
   * Non-native symbols are not independently resolvable by the SDK and must be
   * converted through an application-owned, reviewed asset registry first.
   */
  token: string;
  /** Deprecated alias for `vm`. If both present, `vm` takes precedence. */
  ecosystem?: ChainVm;
  /** Target VM / chain type. */
  vm?: ChainVm;
  chainId?: number;
  /**
   * Cloudflare Turnstile token for `POST /api/intent/quote`.
   * Omit when using a partner `X-API-Key` (server skips Turnstile).
   */
  turnstile?: string;
  /** Optional X sender uid (portal notifications). */
  senderXUid?: string;
  /** Optional wallet that pays credits / attribution (see portal docs). */
  senderWalletAddr?: string;
  senderWalletEcosystem?: "evm" | "solana" | "tron";
  /**
   * Cancel window in seconds. 0 = no cancel window (recipient notified immediately after deposit).
   * Portal enforces a max (default 3600). Omit to use portal's default (typically 600).
   */
  cancelWindowSec?: number;
}

/** Response your HFI Pay quote service should return (fields may be nested; see `coercePaymentQuote`). */
export interface PaymentQuote {
  paymentRef: `0x${string}`;
  amount: string;
  token: string;
  /** The VM / chain type for this quote. */
  ecosystem: ChainVm;
  chainId?: number;

  // ── EVM attested flow ─────────────────────────────────────────────────────
  /** EVM: deployed `HfiPayDeposit` contract address */
  depositContract?: `0x${string}`;
  /**
   * Attested `HfiPayAttested` contract. EVM: `0x…` address. Tron: portal returns hex (`0x…`) for TronWeb.
   */
  attestedContract?: string;
  /** EVM attested flow: canonical order fields for on-chain deposit */
  attestedOrder?: {
    chainId: bigint;
    paymentRef: `0x${string}`;
    idHash: `0x${string}`;
    /** EVM: `0x` token address. Tron: TRC20 base58 or hex per portal quote. */
    token: string;
    amount: bigint;
    cancelBefore: bigint;
    claimBefore: bigint;
    refundAfter: bigint;
  };

  // ── Solana ────────────────────────────────────────────────────────────────
  /** Solana: program ID (base58). Required and independently pinned by the client. */
  programId?: string;
  /** Solana: order parameters (idHash computed server-side, times are unix seconds as strings). */
  solanaOrder?: {
    cancelBefore: string;
    claimBefore: string;
    refundAfter: string;
    idHash: string;
  };

}

/**
 * Persisted intent state returned by `hfi_pay_get_intent`.
 * Mirrors the backend `RpcIntent` struct in `hfi-pay-rpc`.
 */
export interface RpcIntent {
  intent_id: string;
  amount: number;
  chain: string;
  mint_hex?: string | null;
  blinded_binding: string;
  binding_epoch: number;
  deposit_address: string;
  status: string;
  expiry: number;
  created_at: number;
  claim_nonce: number;
  /** On-chain claim destination (32-byte AccountId hex). Set after direct_deposit or manual claim. */
  owner_hex?: string | null;
}

export interface RetryOptions {
  /** Max attempts including the first. Default: 1 (no retry). */
  maxAttempts?: number;
  /** Base delay between retries in ms. Default: 300. Doubles on each attempt. */
  baseDelayMs?: number;
  /** Jitter fraction 0–1 applied to delay. Default: 0.2. */
  jitter?: number;
}

export interface HfiPayClientConfig {
  /** e.g. `https://hfi.network/api/intent/quote` */
  quoteUrl: string;
  /**
   * Explicit `POST /api/intent/quote` URL (Tron + Send-page shape).
   * If omitted for Tron, derived as `{portalBaseUrl}/api/intent/quote`.
   */
  intentQuoteUrl?: string;
  /**
   * Base URL of the HFI Pay portal (without trailing slash).
   * Used for Tron intent quote derivation. If omitted, derived from `quoteUrl`.
   * e.g. `https://hfi.network`
   */
  portalBaseUrl?: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: HeadersInit;
  /** Timeout for each quote HTTP request in ms. Default: 10 000. */
  timeoutMs?: number;
  retry?: RetryOptions;
  /**
   * Pinned attested-contract allowlist keyed by `${ecosystem}:${chainId}`.
   * Transaction builders fail closed when the quote contract is not pinned.
   * Example: `{ "evm:8453": ["0x..."] }`.
   */
  trustedAttestedContracts?: Readonly<Record<string, readonly string[]>>;
  /** Pinned Solana program allowlist keyed by cluster name, e.g. `mainnet-beta`. */
  trustedSolanaPrograms?: Readonly<Record<string, readonly string[]>>;
}

export interface PrepareEvmSendParams {
  recipientKind: RecipientKind;
  recipient: string;
  amount: string;
  token: `0x${string}`;
  chainId: number;
  depositContract: `0x${string}`;
}

export interface PrepareSolanaSendParams {
  recipientKind: RecipientKind;
  recipient: string;
  amount: string;
  /** SPL mint base58, or "SOL" for native SOL (not yet supported — use SPL wrapped SOL) */
  mint: string;
  /** Build-reviewed cluster whose configured program must match the quote. */
  cluster: string;
}
