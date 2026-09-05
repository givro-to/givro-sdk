import type { RecipientKind } from "./identifier.js";

/** The settlement VM a payment runs on. */
export type ChainVm = "evm" | "tron";

export interface QuoteRequestBody {
  identifier: string;
  identifierKind: RecipientKind;
  /** Smallest units as a decimal string (EVM wei / Tron sun or token raw). */
  amountWei: string;
  /**
   * Human amount label for `POST /api/intent/quote` (e.g. `"10.5"`).
   * When omitted, the SDK sends `amountWei` as `amount` as well.
   */
  amount?: string;
  /**
   * Token identifier. Accepts:
   *  - EVM: checksummed `0x` token address, or the target chain's native symbol.
   *    Native symbols require `chainId` and are rejected when they do not match it.
   *  - Tron: TRC20 contract (base58), or "TRX" for native TRX.
   * Non-native symbols are not independently resolvable by the SDK and must be
   * converted through an application-owned, reviewed asset registry first.
   */
  token: string;
  /** Deprecated alias for `vm`. If both present, `vm` takes precedence. */
  ecosystem?: ChainVm;
  /** Target VM / chain type. */
  vm?: ChainVm;
  /** EVM or Tron chain ID. */
  chainId?: number;
  /**
   * Fresh Cloudflare Turnstile token for consumer-browser
   * `POST /api/intent/quote` requests. Production consumer quotes reject
   * `X-API-Key`; enterprise server integrations must use Payment Links.
   */
  turnstile?: string;
  /** @deprecated Current Portal derives the X sender from `X-X-Session`. */
  senderXUid?: string;
  /** Optional sender wallet. Requires a matching wallet-session Bearer token. */
  senderWalletAddr?: string;
  senderWalletEcosystem?: ChainVm;
  /**
   * Requested cancel window in seconds. Portal clamps values, including 0, to
   * its contract-compatible safety bounds. Omit to use the Portal default
   * (typically 600 seconds).
   */
  cancelWindowSec?: number;
}

/**
 * The order tuple the escrow stores for one payment. Every field is committed
 * on chain at funding; the escrow rejects a `blindedBinding` it has already
 * seen, so no two payments share a recipient tag.
 */
export interface EscrowOrder {
  chainId: bigint;
  paymentRef: `0x${string}`;
  /** Per-payment identifier, bound into every claim digest for this vault. */
  intentId: `0x${string}`;
  /** Fresh per intent. */
  blindedBinding: `0x${string}`;
  bindingEpoch: bigint;
  /** 0 = LazyAttested (first-receipt onboarding), 1 = ZkRegistered. */
  claimAuthorization: 0 | 1;
  /**
   * EVM: `0x` token address, zero for the native asset. Tron: `native` for
   * TRX, otherwise the TRC20 contract as returned by the portal.
   */
  token: string;
  amount: bigint;
  /** 0 waives the payer's cancel window entirely. */
  cancelBefore: bigint;
  claimBefore: bigint;
  refundAfter: bigint;
}

/** A normalized quote from `POST /api/intent/quote` (see `coercePaymentQuote`). */
export interface PaymentQuote {
  paymentRef: `0x${string}`;
  /** Atomic units, decimal string. Always equals `order.amount`. */
  amount: string;
  /** Canonical token: EVM zero address or `0x` address; Tron `native` or base58 contract. */
  token: string;
  ecosystem: ChainVm;
  chainId: number;
  /**
   * The settlement escrow this payment funds into, as a canonical non-zero
   * `0x` address on both EVM and Tron. The portal publishes the same value
   * from `GET /api/public/supported-assets`; pin it at onboarding and pass it
   * through `trustedAttestedContracts` rather than trusting a quote at runtime.
   */
  attestedContract: `0x${string}`;
  /**
   * `keccak256(abi.encode(mandateSigner, salt))` when the recipient already
   * has a payout mandate, or 32 zero bytes when they do not. Zero marks a vault
   * that cannot settle unattended and must be claimed with the recipient's own
   * signature on first receipt.
   */
  mandateCommit: `0x${string}`;
  order: EscrowOrder;
}

export interface RetryOptions {
  /** Max attempts including the first. Default: 1 (no retry). */
  maxAttempts?: number;
  /** Base delay between retries in ms. Default: 300. Doubles on each attempt. */
  baseDelayMs?: number;
  /** Jitter fraction 0–1 applied to delay. Default: 0.2. */
  jitter?: number;
}

export interface GivroPayClientConfig {
  /** e.g. `https://givro.to/api/intent/quote` */
  quoteUrl: string;
  /**
   * Explicit `POST /api/intent/quote` URL for Tron quotes.
   * If omitted, derived as `{portalBaseUrl}/api/intent/quote`.
   */
  intentQuoteUrl?: string;
  /**
   * Base URL of the Givro portal (without trailing slash). If omitted, derived
   * from `quoteUrl`. e.g. `https://givro.to`
   */
  portalBaseUrl?: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: HeadersInit;
  /** Timeout for each quote HTTP request in ms. Default: 10 000. */
  timeoutMs?: number;
  retry?: RetryOptions;
  /**
   * Pinned settlement-escrow allowlist keyed by `${ecosystem}:${chainId}`.
   * Transaction builders fail closed when the quote's escrow is not pinned.
   * Example: `{ "evm:8453": ["0x..."], "tron:728126428": ["0x..."] }`.
   */
  trustedAttestedContracts?: Readonly<Record<string, readonly string[]>>;
}
