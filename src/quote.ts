import type { ChainVm, PaymentQuote, QuoteRequestBody, RetryOptions } from "./types.js";
import { HfiPayError, HfiPayNetworkError, HfiPayQuoteError, HfiPayTimeoutError } from "./errors.js";

const EVM_NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const SOLANA_NATIVE_TOKEN = "native";
const EVM_NATIVE_SYMBOLS_BY_CHAIN: Readonly<Record<number, ReadonlySet<string>>> = {
  1: new Set(["ETH"]),
  10: new Set(["ETH"]),
  56: new Set(["BNB"]),
  97: new Set(["BNB"]),
  137: new Set(["POL"]),
  31337: new Set(["ETH", "GO"]),
  8453: new Set(["ETH"]),
  84532: new Set(["ETH", "GO"]),
  42161: new Set(["ETH"]),
  421614: new Set(["ETH"]),
  43113: new Set(["AVAX"]),
  43114: new Set(["AVAX"]),
  11155111: new Set(["ETH"]),
  11155420: new Set(["ETH"]),
};
const EVM_NATIVE_SYMBOLS = new Set(
  Object.values(EVM_NATIVE_SYMBOLS_BY_CHAIN).flatMap((symbols) => [...symbols]),
);

/** Canonicalize only explicit native aliases; token symbols otherwise remain untouched. */
export function canonicalQuoteToken(vm: ChainVm, token: string, chainId?: number): string {
  const trimmed = token.trim();
  const alias = trimmed.toUpperCase();
  if (vm === "evm") {
    if (
      alias === "NATIVE"
      || trimmed.toLowerCase() === EVM_NATIVE_TOKEN
      || /^0x[eE]{40}$/.test(trimmed)
    ) {
      return EVM_NATIVE_TOKEN;
    }
    if (EVM_NATIVE_SYMBOLS.has(alias)) {
      if (chainId == null || !Number.isSafeInteger(chainId) || chainId <= 0) {
        throw new HfiPayQuoteError(`chainId is required to resolve EVM native symbol ${alias}`);
      }
      if (!EVM_NATIVE_SYMBOLS_BY_CHAIN[chainId]?.has(alias)) {
        throw new HfiPayQuoteError(
          `${alias} is not the native asset for EVM chain ${chainId}; use a reviewed token address`,
        );
      }
      return EVM_NATIVE_TOKEN;
    }
  }
  if (vm === "tron" && (alias === "TRX" || alias === "NATIVE" || trimmed === EVM_NATIVE_TOKEN)) return "native";
  if (vm === "solana" && (alias === "SOL" || alias === "NATIVE" || trimmed === "11111111111111111111111111111111")) {
    return SOLANA_NATIVE_TOKEN;
  }
  return trimmed;
}

function quoteVm(body: QuoteRequestBody): ChainVm {
  const vm = body.vm ?? body.ecosystem;
  if (vm !== "evm" && vm !== "tron" && vm !== "solana") {
    throw new HfiPayQuoteError("vm (or ecosystem) must be evm | solana | tron");
  }
  return vm;
}

/**
 * JSON body for `POST /api/intent/quote` (Send page / Tron). Other VMs use the legacy portal quote shape as-is.
 */
export function serializeQuoteRequestBody(body: QuoteRequestBody): Record<string, unknown> {
  const vm = quoteVm(body);
  const token = canonicalQuoteToken(vm, body.token, body.chainId);
  if (vm === "tron") {
    const amountHuman = body.amount ?? body.amountWei;
    const out: Record<string, unknown> = {
      identifier: body.identifier,
      identifierKind: body.identifierKind,
      amount: amountHuman,
      amountWei: body.amountWei,
      token,
      chainId: body.chainId,
      ecosystem: "tron",
      turnstile: body.turnstile ?? "",
    };
    if (body.cancelWindowSec !== undefined) out.cancelWindowSec = body.cancelWindowSec;
    if (body.senderXUid !== undefined) out.senderXUid = body.senderXUid;
    if (body.senderWalletAddr !== undefined) out.senderWalletAddr = body.senderWalletAddr;
    if (body.senderWalletEcosystem !== undefined) out.senderWalletEcosystem = body.senderWalletEcosystem;
    return out;
  }
  return { ...body, token } as Record<string, unknown>;
}

function isHex32(h: string): h is `0x${string}` {
  const x = h.startsWith("0x") ? h.slice(2) : h;
  return x.length === 64 && /^[0-9a-fA-F]+$/.test(x);
}

function normalizeHex32(value: unknown, fieldName: string): `0x${string}` {
  if (typeof value !== "string" || !isHex32(value)) {
    throw new HfiPayQuoteError(`invalid ${fieldName} (expected 32-byte hex)`);
  }
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

function parseQuoteBigInt(value: unknown, fieldName: string): bigint {
  try {
    return BigInt(String(value));
  } catch (err) {
    throw new HfiPayQuoteError(`invalid ${fieldName} (expected integer)`, { cause: err });
  }
}

/** Normalize various JSON shapes into `PaymentQuote`. */
export function coercePaymentQuote(raw: Record<string, unknown>): PaymentQuote {
  const paymentRef = (raw.paymentRef ?? raw.payment_ref) as string | undefined;
  if (!paymentRef || !isHex32(paymentRef)) {
    throw new HfiPayQuoteError("missing or invalid paymentRef (32-byte hex)");
  }
  const ref = (paymentRef.startsWith("0x") ? paymentRef : `0x${paymentRef}`) as `0x${string}`;
  // Support nested order object (HFI portal response shape)
  const order = (raw.order ?? {}) as Record<string, unknown>;
  // Prefer atomic-unit fields. `raw.amount` can be a human-readable display
  // label on intent quote endpoints and must never override the signed order.
  const amount = String(raw.amountWei ?? order.amountWei ?? order.amount ?? raw.amount ?? "");
  if (!amount) throw new HfiPayQuoteError("missing amount");
  const ecosystem = (raw.ecosystem ?? order.ecosystem) as string;
  if (ecosystem !== "evm" && ecosystem !== "solana" && ecosystem !== "tron") {
    throw new HfiPayQuoteError("ecosystem must be evm | solana | tron");
  }
  const chainIdRaw = raw.chainId ?? order.chainId;
  const chainId = chainIdRaw != null ? Number(chainIdRaw) : undefined;
  if (chainId !== undefined && (!Number.isSafeInteger(chainId) || chainId <= 0)) {
    throw new HfiPayQuoteError("chainId must be a positive integer");
  }
  const rawToken = String(raw.token ?? order.token ?? "");
  if (!rawToken) throw new HfiPayQuoteError("missing token");
  const token = canonicalQuoteToken(ecosystem, rawToken, chainId);
  const dep = raw.depositContract ?? raw.deposit_contract ?? raw.attestedContract;
  const depositContract =
    typeof dep === "string" && dep.startsWith("0x") ? (dep as `0x${string}`) : undefined;
  const attestedContractRaw = raw.attestedContract;
  const attestedContract =
    typeof attestedContractRaw === "string" && attestedContractRaw.length > 0 ? attestedContractRaw : undefined;
  let attestedOrder: PaymentQuote["attestedOrder"] | undefined;
  if (attestedContract) {
    const hasOrderAmount = order.amount != null || order.amountWei != null;
    if (
      order.chainId == null
      || order.token == null
      || !hasOrderAmount
      || order.idHash == null
      || order.claimBefore == null
      || order.refundAfter == null
    ) {
      throw new HfiPayQuoteError("attestedOrder missing required fields");
    }
    const orderPaymentRef = normalizeHex32(
      order.paymentRef ?? raw.paymentRef ?? raw.payment_ref,
      "paymentRef",
    );
    const orderIdHash = normalizeHex32(order.idHash, "order.idHash");
    const claimBefore = parseQuoteBigInt(order.claimBefore, "order.claimBefore");
    const orderAmountRaw = order.amount ?? order.amountWei;
    if (orderAmountRaw == null) {
      throw new HfiPayQuoteError("attestedOrder missing amount (or amountWei)");
    }
    attestedOrder = {
      chainId: parseQuoteBigInt(order.chainId, "order.chainId"),
      paymentRef: orderPaymentRef,
      idHash: orderIdHash,
      token: canonicalQuoteToken(ecosystem, String(order.token), chainId),
      amount: parseQuoteBigInt(orderAmountRaw, "order.amount"),
      cancelBefore: order.cancelBefore != null
        ? parseQuoteBigInt(order.cancelBefore, "order.cancelBefore")
        : claimBefore,
      claimBefore,
      refundAfter: parseQuoteBigInt(order.refundAfter, "order.refundAfter"),
    };
  }
  const programId = typeof raw.programId === "string" ? raw.programId : undefined;

  // ── Solana order fields (server returns under `order` key) ───────────────
  let solanaOrder: PaymentQuote["solanaOrder"] | undefined;
  if (ecosystem === "solana" && order.idHash != null && order.claimBefore != null) {
    solanaOrder = {
      cancelBefore: String(order.cancelBefore ?? order.claimBefore),
      claimBefore: String(order.claimBefore),
      refundAfter: String(order.refundAfter),
      idHash: String(order.idHash),
    };
  }

  return {
    paymentRef: ref,
    amount,
    token,
    ecosystem,
    chainId,
    depositContract,
    attestedContract,
    attestedOrder,
    programId,
    solanaOrder,
  };
}

async function fetchOnce(
  quoteUrl: string,
  body: QuoteRequestBody,
  init: { fetchImpl?: typeof fetch; headers?: HeadersInit; timeoutMs?: number },
): Promise<PaymentQuote> {
  const fetchFn = init.fetchImpl ?? globalThis.fetch;
  if (!fetchFn) throw new HfiPayError("QUOTE_FETCH_FAILED", "fetch is not available; pass fetchImpl");

  const timeoutMs = init.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetchFn(quoteUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(serializeQuoteRequestBody(body)),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new HfiPayTimeoutError(timeoutMs, { cause: err });
    }
    if (err instanceof HfiPayError) throw err;
    throw new HfiPayError("QUOTE_FETCH_FAILED", "HFI Pay quote request failed", { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HfiPayNetworkError(res.status, text);
  }
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new HfiPayQuoteError("response is not valid JSON", { cause: err });
  }
  return coercePaymentQuote(json);
}

export async function fetchPaymentQuote(
  quoteUrl: string,
  body: QuoteRequestBody,
  init?: { fetchImpl?: typeof fetch; headers?: HeadersInit; timeoutMs?: number; retry?: RetryOptions },
): Promise<PaymentQuote> {
  // Turnstile tokens are single-use. Never replay the same browser challenge
  // during an automatic HTTP retry; the caller must acquire a fresh token.
  const rawMaxAttempts = init?.retry?.maxAttempts ?? 1;
  const requestedMaxAttempts = Number.isFinite(rawMaxAttempts)
    ? Math.max(1, Math.floor(rawMaxAttempts))
    : 1;
  const maxAttempts = body.turnstile !== undefined ? 1 : requestedMaxAttempts;
  const baseDelayMs = init?.retry?.baseDelayMs ?? 300;
  const jitter = init?.retry?.jitter ?? 0.2;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      const jitterMs = delay * jitter * (Math.random() * 2 - 1);
      await new Promise((r) => setTimeout(r, Math.max(0, delay + jitterMs)));
    }
    try {
      return await fetchOnce(quoteUrl, body, {
        fetchImpl: init?.fetchImpl,
        headers: init?.headers,
        timeoutMs: init?.timeoutMs,
      });
    } catch (err) {
      lastErr = err;
      if (err instanceof HfiPayTimeoutError) continue;
      if (err instanceof HfiPayNetworkError && err.statusCode >= 500) continue;
      throw err;
    }
  }
  throw lastErr;
}
