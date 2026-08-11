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

/** Input accepted by `POST /api/payment-links`. Amount is the server's display amount string. */
export interface CreatePaymentLinkParams {
  recipient: string;
  recipient_kind: "email" | "x";
  amount: string;
  ecosystem: EnterpriseEcosystem;
  chainId: number;
  token_symbol: string;
  settlement_mode?: EnterpriseSettlementMode;
  fee_payer?: EnterpriseFeePayer;
  merchant_ref?: string;
  message?: string;
}

export interface CreateEmailPaymentLinkParams extends CreatePaymentLinkParams {
  payer_email: string;
}

export interface PaymentLinkResponse {
  payment_link_id: string;
  pay_url: string;
  payment_link: Record<string, unknown>;
}

export interface EmailPaymentLinkBatchItem extends CreateEmailPaymentLinkParams {
  /** Unique per item; exact retries must retain the same value and request body. */
  idempotency_key: string;
}

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

  getSupportedChains<T = Record<string, unknown>>(): Promise<T> {
    return this.request("/api/enterprise/v1/supported_chains");
  }

  getSupportedAssets<T = Record<string, unknown>>(): Promise<T> {
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
