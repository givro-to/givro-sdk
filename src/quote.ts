import type { ChainVm, PaymentQuote, QuoteRequestBody, RetryOptions } from "./types.js";
import { GivroPayError, GivroPayNetworkError, GivroPayQuoteError, GivroPayTimeoutError } from "./errors.js";

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
  if (vm === "tron" && (alias === "TRX" || alias === "NATIVE" || trimmed === EVM_NATIVE_TOKEN)) return "native";
  if (vm === "solana" && (alias === "SOL" || alias === "NATIVE" || trimmed === "11111111111111111111111111111111")) {
    return SOLANA_NATIVE_TOKEN;
  }
  return trimmed;
}

function quoteVm(body: QuoteRequestBody): ChainVm {
  const vm = body.vm ?? body.ecosystem;
  if (vm !== "evm" && vm !== "tron" && vm !== "solana") {
    throw new GivroPayQuoteError("vm (or ecosystem) must be evm | solana | tron");
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

/** Normalize various JSON shapes into `PaymentQuote`. */
/**
 * Parse the v2 settlement material a v2 quote carries. The portal still returns
 * the legacy `order` block alongside it for older readers, but on a v2 chain
 * that block is not fundable: `attestedContract` points at the v2 escrow, which
 * has no v1 selector and no fallback, so v1 calldata built from it reverts.
 * `coercePaymentQuote` therefore refuses to derive the v1 fields from a v2
 * quote at all -- a caller on the v1 path gets `undefined` and a thrown build
 * error, rather than a transaction that only fails once broadcast.
 */
function coerceIntentBlinded(
  raw: Record<string, unknown>,
  ecosystem: ChainVm,
  chainId: number | undefined,
): PaymentQuote["intentBlinded"] | undefined {
  const blob = raw.intentBlinded;
  if (blob == null || typeof blob !== "object") return undefined;
  const src = blob as Record<string, unknown>;
  const escrow = typeof src.escrow === "string" ? src.escrow : "";
  if (!escrow) throw new GivroPayQuoteError("intentBlinded.escrow is required");
  const order = (src.order ?? {}) as Record<string, unknown>;
  if (order.intentId == null || order.blindedBinding == null) {
    throw new GivroPayQuoteError("intentBlinded.order missing intentId or blindedBinding");
  }
  const claimAuthorization = Number(order.claimAuthorization ?? 0);
  if (claimAuthorization !== 0 && claimAuthorization !== 1) {
    throw new GivroPayQuoteError("intentBlinded.order.claimAuthorization must be 0 or 1");
  }
  return {
    escrow,
    // Zero is legal and meaningful: it marks a vault that cannot settle
    // unattended and must be claimed with the recipient's own signature.
    mandateCommit: normalizeHex32(src.mandateCommit ?? `0x${"0".repeat(64)}`, "intentBlinded.mandateCommit"),
    order: {
      chainId: parseQuoteBigInt(order.chainId, "intentBlinded.order.chainId"),
      paymentRef: normalizeHex32(order.paymentRef, "intentBlinded.order.paymentRef"),
      intentId: normalizeHex32(order.intentId, "intentBlinded.order.intentId"),
      blindedBinding: normalizeHex32(order.blindedBinding, "intentBlinded.order.blindedBinding"),
      bindingEpoch: parseQuoteBigInt(order.bindingEpoch ?? "1", "intentBlinded.order.bindingEpoch"),
      claimAuthorization: claimAuthorization as 0 | 1,
      token: canonicalQuoteToken(ecosystem, String(order.token ?? ""), chainId),
      amount: parseQuoteBigInt(order.amount, "intentBlinded.order.amount"),
      cancelBefore: parseQuoteBigInt(order.cancelBefore, "intentBlinded.order.cancelBefore"),
      claimBefore: parseQuoteBigInt(order.claimBefore, "intentBlinded.order.claimBefore"),
      refundAfter: parseQuoteBigInt(order.refundAfter, "intentBlinded.order.refundAfter"),
    },
  };
}

export function coercePaymentQuote(raw: Record<string, unknown>): PaymentQuote {
  const paymentRef = (raw.paymentRef ?? raw.payment_ref) as string | undefined;
  if (!paymentRef || !isHex32(paymentRef)) {
    throw new GivroPayQuoteError("missing or invalid paymentRef (32-byte hex)");
  }
  const ref = (paymentRef.startsWith("0x") ? paymentRef : `0x${paymentRef}`) as `0x${string}`;
  // Support nested order object (Givro portal response shape)
  const order = (raw.order ?? {}) as Record<string, unknown>;
  // Prefer atomic-unit fields. `raw.amount` can be a human-readable display
  // label on intent quote endpoints and must never override the signed order.
  const amount = String(raw.amountWei ?? order.amountWei ?? order.amount ?? raw.amount ?? "");
  if (!amount) throw new GivroPayQuoteError("missing amount");
  const ecosystem = (raw.ecosystem ?? order.ecosystem) as string;
  if (ecosystem !== "evm" && ecosystem !== "solana" && ecosystem !== "tron") {
    throw new GivroPayQuoteError("ecosystem must be evm | solana | tron");
  }
  const chainIdRaw = raw.chainId ?? order.chainId;
  const chainId = chainIdRaw != null ? Number(chainIdRaw) : undefined;
  if (chainId !== undefined && (!Number.isSafeInteger(chainId) || chainId <= 0)) {
    throw new GivroPayQuoteError("chainId must be a positive integer");
  }
  const rawToken = String(raw.token ?? order.token ?? "");
  if (!rawToken) throw new GivroPayQuoteError("missing token");
  const token = canonicalQuoteToken(ecosystem, rawToken, chainId);
  const intentBlinded = coerceIntentBlinded(raw, ecosystem, chainId);
  const declaredVersion = raw.protocolVersion != null ? Number(raw.protocolVersion) : undefined;
  if (declaredVersion != null && declaredVersion !== 1 && declaredVersion !== 2) {
    throw new GivroPayQuoteError(`unsupported protocolVersion ${String(raw.protocolVersion)}`);
  }
  const protocolVersion: 1 | 2 = intentBlinded || declaredVersion === 2 ? 2 : 1;
  if (protocolVersion === 2 && !intentBlinded) {
    throw new GivroPayQuoteError("quote declares protocolVersion 2 but carries no intentBlinded material");
  }

  const dep = raw.depositContract ?? raw.deposit_contract ?? raw.attestedContract;
  const depositContract =
    protocolVersion === 1 && typeof dep === "string" && dep.startsWith("0x")
      ? (dep as `0x${string}`)
      : undefined;
  const attestedContractRaw = raw.attestedContract;
  const attestedContract =
    typeof attestedContractRaw === "string" && attestedContractRaw.length > 0 ? attestedContractRaw : undefined;
  let attestedOrder: PaymentQuote["attestedOrder"] | undefined;
  if (attestedContract && protocolVersion === 1) {
    const hasOrderAmount = order.amount != null || order.amountWei != null;
    if (
      order.chainId == null
      || order.token == null
      || !hasOrderAmount
      || order.idHash == null
      || order.claimBefore == null
      || order.refundAfter == null
    ) {
      throw new GivroPayQuoteError("attestedOrder missing required fields");
    }
    const orderPaymentRef = normalizeHex32(
      order.paymentRef ?? raw.paymentRef ?? raw.payment_ref,
      "paymentRef",
    );
    const orderIdHash = normalizeHex32(order.idHash, "order.idHash");
    const claimBefore = parseQuoteBigInt(order.claimBefore, "order.claimBefore");
    const orderAmountRaw = order.amount ?? order.amountWei;
    if (orderAmountRaw == null) {
      throw new GivroPayQuoteError("attestedOrder missing amount (or amountWei)");
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
    protocolVersion,
    depositContract,
    attestedContract,
    attestedOrder,
    intentBlinded,
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
