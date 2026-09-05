import type { ChainVm, EscrowOrder, PaymentQuote, QuoteRequestBody, RetryOptions } from "./types.js";
import { GivroPayError, GivroPayNetworkError, GivroPayQuoteError, GivroPayTimeoutError } from "./errors.js";

const EVM_NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const TRON_NATIVE_TOKEN = "native";
const EVM_NATIVE_SYMBOLS_BY_CHAIN: Readonly<Record<number, ReadonlySet<string>>> = {
  1: new Set(["ETH"]),
  10: new Set(["ETH"]),
  56: new Set(["BNB"]),
  97: new Set(["BNB"]),
  137: new Set(["POL"]),
  31337: new Set(["ETH", "GO"]),
  31338: new Set(["ETH", "GO"]),
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
        throw new GivroPayQuoteError(`chainId is required to resolve EVM native symbol ${alias}`);
      }
      if (!EVM_NATIVE_SYMBOLS_BY_CHAIN[chainId]?.has(alias)) {
        throw new GivroPayQuoteError(
          `${alias} is not the native asset for EVM chain ${chainId}; use a reviewed token address`,
        );
      }
      return EVM_NATIVE_TOKEN;
    }
  }
  if (vm === "tron" && (alias === "TRX" || alias === "NATIVE" || trimmed === EVM_NATIVE_TOKEN)) {
    return TRON_NATIVE_TOKEN;
  }
  return trimmed;
}

function quoteVm(body: QuoteRequestBody): ChainVm {
  const vm = body.vm ?? body.ecosystem;
  if (vm !== "evm" && vm !== "tron") {
    throw new GivroPayQuoteError("vm (or ecosystem) must be evm | tron");
  }
  return vm;
}

/** JSON body for `POST /api/intent/quote`. */
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
    throw new GivroPayQuoteError(`invalid ${fieldName} (expected 32-byte hex)`);
  }
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

function parseQuoteBigInt(value: unknown, fieldName: string): bigint {
  try {
    return BigInt(String(value));
  } catch (err) {
    throw new GivroPayQuoteError(`invalid ${fieldName} (expected integer)`, { cause: err });
  }
}

function isCanonicalNonZeroAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
}

/**
 * Normalize the portal's quote JSON into `PaymentQuote`.
 *
 * The settlement material lives under `intentBlinded` in the wire format:
 * the escrow, the mandate commitment, and the eleven-field order the escrow
 * stores. A quote without it cannot be funded and is refused here, rather than
 * producing a transaction that only fails once broadcast.
 */
export function coercePaymentQuote(raw: Record<string, unknown>): PaymentQuote {
  const paymentRef = (raw.paymentRef ?? raw.payment_ref) as string | undefined;
  if (!paymentRef || !isHex32(paymentRef)) {
    throw new GivroPayQuoteError("missing or invalid paymentRef (32-byte hex)");
  }
  const ref = (paymentRef.startsWith("0x") ? paymentRef : `0x${paymentRef}`) as `0x${string}`;

  const ecosystem = raw.ecosystem as string;
  if (ecosystem !== "evm" && ecosystem !== "tron") {
    throw new GivroPayQuoteError("ecosystem must be evm | tron");
  }
  const chainIdRaw = raw.chainId;
  const chainId = chainIdRaw != null ? Number(chainIdRaw) : NaN;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new GivroPayQuoteError("chainId must be a positive integer");
  }

  const blob = raw.intentBlinded;
  if (blob == null || typeof blob !== "object") {
    throw new GivroPayQuoteError("quote carries no settlement material (intentBlinded)");
  }
  const material = blob as Record<string, unknown>;
  const escrow = material.escrow;
  if (!isCanonicalNonZeroAddress(escrow)) {
    throw new GivroPayQuoteError("intentBlinded.escrow must be a canonical non-zero 0x address");
  }
  const published = raw.attestedContract;
  if (typeof published === "string" && published.length > 0 && published.toLowerCase() !== escrow.toLowerCase()) {
    // Both name where the money goes. If they ever disagree, one of them is the
    // address the integrator pinned and the other is where funds would land.
    throw new GivroPayQuoteError("attestedContract disagrees with intentBlinded.escrow");
  }

  const src = (material.order ?? {}) as Record<string, unknown>;
  const claimAuthorization = Number(src.claimAuthorization ?? 0);
  if (claimAuthorization !== 0 && claimAuthorization !== 1) {
    throw new GivroPayQuoteError("intentBlinded.order.claimAuthorization must be 0 or 1");
  }
  const orderPaymentRef = normalizeHex32(src.paymentRef ?? ref, "intentBlinded.order.paymentRef");
  if (orderPaymentRef.toLowerCase() !== ref.toLowerCase()) {
    throw new GivroPayQuoteError("intentBlinded.order.paymentRef disagrees with paymentRef");
  }
  const orderChainId = parseQuoteBigInt(src.chainId ?? chainId, "intentBlinded.order.chainId");
  if (orderChainId !== BigInt(chainId)) {
    throw new GivroPayQuoteError("intentBlinded.order.chainId disagrees with chainId");
  }
  const orderToken = canonicalQuoteToken(ecosystem, String(src.token ?? raw.token ?? ""), chainId);
  if (!orderToken) throw new GivroPayQuoteError("missing token");
  const topToken = raw.token != null ? canonicalQuoteToken(ecosystem, String(raw.token), chainId) : orderToken;
  const tokensAgree = ecosystem === "evm"
    ? topToken.toLowerCase() === orderToken.toLowerCase()
    : topToken === orderToken;
  if (!tokensAgree) throw new GivroPayQuoteError("token disagrees with intentBlinded.order.token");

  const order: EscrowOrder = {
    chainId: orderChainId,
    paymentRef: orderPaymentRef,
    intentId: normalizeHex32(src.intentId, "intentBlinded.order.intentId"),
    blindedBinding: normalizeHex32(src.blindedBinding, "intentBlinded.order.blindedBinding"),
    bindingEpoch: parseQuoteBigInt(src.bindingEpoch ?? "1", "intentBlinded.order.bindingEpoch"),
    claimAuthorization: claimAuthorization as 0 | 1,
    token: orderToken,
    amount: parseQuoteBigInt(src.amount, "intentBlinded.order.amount"),
    cancelBefore: parseQuoteBigInt(src.cancelBefore, "intentBlinded.order.cancelBefore"),
    claimBefore: parseQuoteBigInt(src.claimBefore, "intentBlinded.order.claimBefore"),
    refundAfter: parseQuoteBigInt(src.refundAfter, "intentBlinded.order.refundAfter"),
  };
  if (order.amount <= 0n) throw new GivroPayQuoteError("intentBlinded.order.amount must be positive");
  if (!(order.cancelBefore <= order.claimBefore && order.claimBefore < order.refundAfter)) {
    throw new GivroPayQuoteError("intentBlinded.order has invalid lifecycle windows");
  }
  const topAmount = raw.amountWei != null ? String(raw.amountWei) : undefined;
  if (topAmount !== undefined && (!/^\d+$/.test(topAmount) || BigInt(topAmount) !== order.amount)) {
    throw new GivroPayQuoteError("amountWei disagrees with intentBlinded.order.amount");
  }

  return {
    paymentRef: ref,
    amount: order.amount.toString(),
    token: orderToken,
    ecosystem,
    chainId,
    attestedContract: escrow,
    // Zero is legal and meaningful: it marks a vault that cannot settle
    // unattended and must be claimed with the recipient's own signature.
    mandateCommit: normalizeHex32(material.mandateCommit ?? `0x${"0".repeat(64)}`, "intentBlinded.mandateCommit"),
    order,
  };
}

async function fetchOnce(
  quoteUrl: string,
  body: QuoteRequestBody,
  init: { fetchImpl?: typeof fetch; headers?: HeadersInit; timeoutMs?: number },
): Promise<PaymentQuote> {
  const fetchFn = init.fetchImpl ?? globalThis.fetch;
  if (!fetchFn) throw new GivroPayError("QUOTE_FETCH_FAILED", "fetch is not available; pass fetchImpl");

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
      throw new GivroPayTimeoutError(timeoutMs, { cause: err });
    }
    if (err instanceof GivroPayError) throw err;
    throw new GivroPayError("QUOTE_FETCH_FAILED", "Givro quote request failed", { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GivroPayNetworkError(res.status, text);
  }
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new GivroPayQuoteError("response is not valid JSON", { cause: err });
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
      if (err instanceof GivroPayTimeoutError) continue;
      if (err instanceof GivroPayNetworkError && err.statusCode >= 500) continue;
      throw err;
    }
  }
  throw lastErr;
}
