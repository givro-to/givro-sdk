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
   *  - EVM: checksummed `0x` token address, or the target chain's native symbol.
   *    Native symbols require `chainId` and are rejected when they do not match it.
   *  - Solana: base58 SPL mint address, or "SOL" / "native" for native SOL quotes.
   *    The public supported-assets response currently does not provide a
   *    trusted Program ID, so discovery alone is not sufficient to enable a
   *    Solana funding path. Wrapped SOL is an SPL mint and must not be treated
   *    as the native-SOL marker.
   *  - Tron: TRC20 contract (base58), or "TRX" for native TRX
   * Non-native symbols are not independently resolvable by the SDK and must be
   * converted through an application-owned, reviewed asset registry first.
   */
  token: string;
  /** Deprecated alias for `vm`. If both present, `vm` takes precedence. */
  ecosystem?: ChainVm;
  /** Target VM / chain type. */
  vm?: ChainVm;
  /** EVM or Tron chain ID. Solana uses cluster/program configuration instead. */
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
  senderWalletEcosystem?: "evm" | "solana" | "tron";
  /**
   * Requested cancel window in seconds. Portal clamps values, including 0, to
   * its contract-compatible safety bounds. Omit to use the Portal default
   * (typically 600 seconds).
   */
  cancelWindowSec?: number;
}

/** Response your Givro quote service should return (fields may be nested; see `coercePaymentQuote`). */
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
   * Attested `HfiPayAttested` contract. EVM and Tron quotes use a canonical,
   * non-zero `0x…` Solidity address; clients must independently pin it.
   */
  attestedContract?: string;
  /** EVM attested flow: canonical order fields for on-chain deposit */
  attestedOrder?: {
    chainId: bigint;
    paymentRef: `0x${string}`;
    idHash: `0x${string}`;
    /** EVM: `0x` token address. Tron native is normalized to the ABI zero address by the tuple helper. */
    token: string;
    amount: bigint;
    cancelBefore: bigint;
    claimBefore: bigint;
    refundAfter: bigint;
  };

  // ── v2 intent-blinded (the rail the portal funds today) ───────────────────
  /**
   * Which escrow generation this quote is for. A v2 quote carries no usable
   * `depositContract` or `attestedOrder`: its `attestedContract` names the v2
   * escrow, whose ABI shares no deposit selector with v1.
   */
  protocolVersion: 1 | 2;
  /** v2 settlement material. Present exactly when `protocolVersion` is 2. */
  intentBlinded?: {
    /** v2 escrow. Pin this at onboarding; do not adopt it from a quote at runtime. */
    escrow: string;
    /**
     * `keccak256(abi.encode(mandateSigner, salt))`, or 32 zero bytes when the
     * recipient has no wallet bound yet. Zero marks a vault that cannot settle
     * unattended and must be claimed with the recipient's own signature.
     */
    mandateCommit: `0x${string}`;
    order: {
      chainId: bigint;
      paymentRef: `0x${string}`;
      intentId: `0x${string}`;
      /** Fresh per intent; the escrow rejects one it has already seen. */
      blindedBinding: `0x${string}`;
      bindingEpoch: bigint;
      /** 0 = LazyAttested (first-receipt), 1 = ZkRegistered. */
      claimAuthorization: 0 | 1;
      token: string;
      amount: bigint;
      cancelBefore: bigint;
      claimBefore: bigint;
      refundAfter: bigint;
    };
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

export interface GivroPayClientConfig {
  /** e.g. `https://givro.to/api/intent/quote` */
  quoteUrl: string;
  /**
   * Explicit `POST /api/intent/quote` URL (Tron + Send-page shape).
   * If omitted for Tron, derived as `{portalBaseUrl}/api/intent/quote`.
   */
  intentQuoteUrl?: string;
  /**
   * Base URL of the Givro portal (without trailing slash).
   * Used for Tron intent quote derivation. If omitted, derived from `quoteUrl`.
   * e.g. `https://givro.to`
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
  /** SPL mint base58. Native SOL additionally requires an independently pinned Program and reviewed marker mapping. */
  mint: string;
  /** Build-reviewed cluster whose configured program must match the quote. */
  cluster: string;
}
