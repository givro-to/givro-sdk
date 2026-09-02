import { createHmac, timingSafeEqual } from "node:crypto";
import { GivroEnterpriseApiError, GivroPayError, GivroPayTimeoutError } from "./errors.js";

/** Server-only configuration. Never send this object or its API key to a browser. */
export interface GivroEnterpriseClientConfig {
  /** Enterprise API key (`gvr_test_…` or `gvr_live_…`). Keep it server-side. */
  apiKey: string;
  /** Defaults to `https://givro.to`. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
}

export type EnterpriseEcosystem = "evm" | "tron";
export type EnterpriseSettlementMode = "simulated" | "mainnet";
export type EnterpriseFeePayer = "merchant" | "payer";

/**
 * Who collects the payment.
 *
 * `givro_id` is a name Givro issued to one business line (givro.to/@acme.sales).
 * A line identified by one has no mailbox, which is the point: a one-person
 * company can run several collection identities off a single verified email.
 */
export type EnterpriseRecipientKind = "email" | "x" | "givro_id";

/**
 * Which asset the link is denominated in. Exactly one form, because the portal
 * resolves a symbol against the chain's registry and takes an address verbatim
 * — and a chain whose registry does not carry the symbol can only be reached by
 * address.
 */
export type EnterpriseTokenSelector =
  /** Resolved by Givro for `chainId`, e.g. `ETH` or `USDC`. */
  | { token_symbol: string; token_address?: never }
  /** Exact contract address; the zero address for native ETH, `native` for TRX. */
  | { token_address: string; token_symbol?: never };

/** Input accepted by `POST /api/payment-links`. Amount is the server's display amount string. */
export interface CreatePaymentLinkBase {
  recipient: string;
  recipient_kind: EnterpriseRecipientKind;
  amount: string;
  ecosystem: EnterpriseEcosystem;
  chainId: number;
  settlement_mode?: EnterpriseSettlementMode;
  fee_payer?: EnterpriseFeePayer;
  merchant_ref?: string;
  /**
   * How long the link stays payable, in seconds from creation. Omitted leaves
   * the portal's default lifetime in place.
   *
   * A duration, not a deadline: the portal reads `expires_in_seconds` and
   * computes the timestamp itself. An absolute `expires_at` is not a field it
   * knows, so one would be dropped without a word and the link would quietly
   * carry the default lifetime instead of the one the merchant set.
   *
   * Accepted range is 300 (5 minutes) to 7_776_000 (90 days); outside it the
   * portal refuses with `invalid_request`.
   */
  expires_in_seconds?: number;
  /**
   * Where the hosted pay page offers to send the payer once they are done.
   *
   * It is an offer, not a redirect: the page renders a button the payer
   * chooses to press and shows the host it leads to. Nothing about the payment
   * is communicated through it — the payer may never press it, and a browser
   * that lands back on the merchant proves only that a browser landed there.
   * The webhook remains the only account of what was actually paid.
   *
   * Must be an absolute https:// URL with no embedded credentials, at most
   * 2048 characters; otherwise the portal refuses with `invalid_request`.
   */
  return_url?: string;
  message?: string;
}

export type CreatePaymentLinkParams = CreatePaymentLinkBase & EnterpriseTokenSelector;

export type CreateEmailPaymentLinkParams = CreatePaymentLinkParams & {
  payer_email: string;
};

export interface PaymentLinkResponse {
  payment_link_id: string;
  pay_url: string;
  payment_link: Record<string, unknown>;
}

export type EmailPaymentLinkBatchItem = CreateEmailPaymentLinkParams & {
  /** Unique per item; exact retries must retain the same value and request body. */
  idempotency_key: string;
};

export interface EmailPaymentLinkBatchResponse {
  ok: boolean;
  status: "completed" | "partially_failed" | "failed";
  batch_ref: string | null;
  total: number;
  created: number;
  failed: number;
  items: Array<{
    index: number;
    ok: boolean;
    status_code: number;
    code?: string;
    error?: string;
    payment_link?: Record<string, unknown>;
    payment_link_id?: string;
    pay_url?: string;
  }>;
}

export interface ListPaymentLinksParams {
  status?: string;
  search?: string;
  created_from?: number;
  created_to?: number;
  cursor?: string;
  limit?: number;
}

/** One token on an Enterprise `supported_assets` chain or Tron network. */
export interface EnterpriseSupportedToken {
  symbol: string;
  address: string;
  decimals: number;
  native?: boolean;
}

export interface EnterpriseSupportedEvmChain {
  chain_id: number;
  name: string;
  assets: string[];
  tokens: EnterpriseSupportedToken[];
  funding_path_configured?: boolean;
}

export interface EnterpriseSupportedTronNetwork {
  network: string;
  chain_id: number;
  name: string;
  assets: string[];
  tokens: EnterpriseSupportedToken[];
}

/**
 * What `GET /api/enterprise/v1/supported_assets` (and `supported_chains`)
 * actually returns. EVM chains live in `chains`; Tron is alongside in
 * `tron_networks` — folding it into `chains` would break callers that treat
 * that array as EVM-only.
 */
export interface EnterpriseSupportedConfig {
  environment: "test" | "live";
  chains: EnterpriseSupportedEvmChain[];
  tron_networks: EnterpriseSupportedTronNetwork[];
}

/** Default freshness window for `Givro-Signature` timestamps, in seconds. */
export const ENTERPRISE_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verify a delivered Enterprise webhook.
 *
 * The portal signs `HMAC-SHA256(secret, "<t>.<raw body>")` and sends
 * `Givro-Signature: t=<unix-seconds>,v1=<hex>`. Decode the hex *before*
 * comparing lengths: a same-length but malformed `v1` would otherwise make
 * `timingSafeEqual` throw, which is a crash a stranger can trigger.
 *
 * Returns false for a missing secret, a missing/malformed header, a timestamp
 * outside the tolerance window, or a signature that does not match. Never
 * throws on attacker-controlled input.
 */
export function verifyEnterpriseWebhookSignature(p: {
  secret: string;
  header: string;
  rawBody: string;
  nowSec?: number;
  toleranceSeconds?: number;
}): boolean {
  const secret = p.secret.trim();
  const header = p.header.trim();
  if (!secret || !header) return false;
  const parts: Record<string, string> = {};
  for (const field of header.split(",")) {
    const eq = field.indexOf("=");
    if (eq <= 0) continue;
    parts[field.slice(0, eq).trim()] = field.slice(eq + 1).trim();
  }
  const timestamp = Number(parts.t);
  const nowSec = p.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = p.toleranceSeconds ?? ENTERPRISE_WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isFinite(timestamp) || Math.abs(nowSec - timestamp) > tolerance) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${parts.t}.${p.rawBody}`).digest("hex"),
    "hex",
  );
  const given = Buffer.from(String(parts.v1 || ""), "hex");
  return given.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

function nonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new GivroPayError("CONFIG_INVALID", `${name} is required`);
  return trimmed;
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Server-side wrapper for Enterprise Payment Links and management APIs.
 * It deliberately performs no automatic retries for writes: callers own the
 * idempotency key and can safely retry the same body themselves.
 */
export class GivroEnterpriseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(private readonly config: GivroEnterpriseClientConfig) {
    this.apiKey = nonEmpty(config.apiKey, "Enterprise API key");
    this.baseUrl = (config.baseUrl ?? "https://givro.to").replace(/\/$/, "");
  }

  async request<T>(path: string, init: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    idempotencyKey?: string;
  } = {}): Promise<T> {
    if (!path.startsWith("/api/")) throw new GivroPayError("CONFIG_INVALID", "Enterprise API path must start with /api/");
    const fetchImpl = this.config.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) throw new GivroPayError("NETWORK_ERROR", "fetch is not available; pass fetchImpl");

    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers({
      Accept: "application/json",
      "X-API-Key": this.apiKey,
    });
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (init.idempotencyKey !== undefined) headers.set("Idempotency-Key", nonEmpty(init.idempotencyKey, "Idempotency-Key"));

    try {
      const response = await fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const responseBody = parseJson(await response.text());
      if (!response.ok) {
        throw new GivroEnterpriseApiError(response.status, responseBody, {
          requestId: response.headers.get("X-Request-Id") ?? undefined,
        });
      }
      return responseBody as T;
    } catch (error) {
      if (error instanceof GivroEnterpriseApiError || error instanceof GivroPayError) throw error;
      if (controller.signal.aborted) throw new GivroPayTimeoutError(timeoutMs, { code: "NETWORK_TIMEOUT", cause: error });
      throw new GivroPayError("NETWORK_ERROR", "Enterprise API request failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  createPaymentLink(params: CreatePaymentLinkParams, idempotencyKey: string): Promise<PaymentLinkResponse> {
    return this.request("/api/payment-links", { method: "POST", body: params, idempotencyKey });
  }

  createAndEmailPaymentLink(params: CreateEmailPaymentLinkParams, idempotencyKey: string): Promise<PaymentLinkResponse> {
    return this.request("/api/payment-links/email", { method: "POST", body: params, idempotencyKey });
  }

  createEmailPaymentLinkBatch(params: {
    batch_ref?: string;
    items: readonly EmailPaymentLinkBatchItem[];
  }): Promise<EmailPaymentLinkBatchResponse> {
    return this.request("/api/payment-links/email/batch", { method: "POST", body: params });
  }

  listPaymentLinks(params: ListPaymentLinksParams = {}): Promise<{ payment_links: Record<string, unknown>[]; next_cursor: string | null }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return this.request(`/api/payment-links${query.size ? `?${query}` : ""}`);
  }

  getSupportedChains(): Promise<EnterpriseSupportedConfig> {
    return this.request("/api/enterprise/v1/supported_chains");
  }

  getSupportedAssets(): Promise<EnterpriseSupportedConfig> {
    return this.request("/api/enterprise/v1/supported_assets");
  }

  listEvents<T = { events: Record<string, unknown>[] }>(params: Record<string, string | number | undefined> = {}): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return this.request(`/api/enterprise/v1/events${query.size ? `?${query}` : ""}`);
  }
}

export function createGivroEnterpriseClient(config: GivroEnterpriseClientConfig): GivroEnterpriseClient {
  return new GivroEnterpriseClient(config);
}
