import type { ChainVm, PaymentQuote, QuoteRequestBody, RetryOptions } from "./types.js";
import { HfiPayNetworkError, HfiPayQuoteError, HfiPayTimeoutError } from "./errors.js";

function quoteVm(body: QuoteRequestBody): ChainVm {
  return (body.vm ?? body.ecosystem) as ChainVm;
}

/**
 * JSON body for `POST /api/intent/quote` (Send page / Tron). Other VMs use the legacy portal quote shape as-is.
 */
export function serializeQuoteRequestBody(body: QuoteRequestBody): Record<string, unknown> {
  const vm = quoteVm(body);
  if (vm === "tron") {
    const amountHuman = body.amount ?? body.amountWei;
    const out: Record<string, unknown> = {
      identifier: body.identifier,
      identifierKind: body.identifierKind,
      amount: amountHuman,
      amountWei: body.amountWei,
      token: body.token,
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
  return { ...body } as Record<string, unknown>;
}

function isHex32(h: string): h is `0x${string}` {
  const x = h.startsWith("0x") ? h.slice(2) : h;
  return x.length === 64 && /^[0-9a-fA-F]+$/.test(x);
}

function normalizeHex32(value: unknown, fieldName: string): `0x${string}` {
  if (typeof value !== "string" || !isHex32(value)) {
    throw new Error(`quote: invalid ${fieldName} (expected 32-byte hex)`);
  }
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

/** Normalize various JSON shapes into `PaymentQuote`. */
export function coercePaymentQuote(raw: Record<string, unknown>): PaymentQuote {
  const paymentRef = (raw.paymentRef ?? raw.payment_ref) as string | undefined;
  if (!paymentRef || !isHex32(paymentRef)) {
    throw new Error("quote: missing or invalid paymentRef (32-byte hex)");
  }
  const ref = (paymentRef.startsWith("0x") ? paymentRef : `0x${paymentRef}`) as `0x${string}`;
  // Support nested order object (HFI portal response shape)
  const order = (raw.order ?? {}) as Record<string, unknown>;
  // Prefer atomic-unit fields. `raw.amount` can be a human-readable display
  // label on intent quote endpoints and must never override the signed order.
  const amount = String(raw.amountWei ?? order.amountWei ?? order.amount ?? raw.amount ?? "");
  if (!amount) throw new Error("quote: missing amount");
  const token = String(raw.token ?? order.token ?? "");
  if (!token) throw new Error("quote: missing token");
  const ecosystem = (raw.ecosystem ?? order.ecosystem) as string;
  if (ecosystem !== "evm" && ecosystem !== "solana" && ecosystem !== "tron") {
    throw new Error("quote: ecosystem must be evm | solana | tron");
  }
  const chainId = (raw.chainId ?? order.chainId) != null ? Number(raw.chainId ?? order.chainId) : undefined;
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
      throw new Error("quote: attestedOrder missing required fields");
    }
    const orderPaymentRef = normalizeHex32(
      order.paymentRef ?? raw.paymentRef ?? raw.payment_ref,
      "paymentRef",
    );
    const orderIdHash = normalizeHex32(order.idHash, "order.idHash");
    const claimBefore = BigInt(String(order.claimBefore));
    const orderAmountRaw = order.amount ?? order.amountWei;
    if (orderAmountRaw == null) {
      throw new Error("quote: attestedOrder missing amount (or amountWei)");
    }
    attestedOrder = {
      chainId: BigInt(String(order.chainId)),
      paymentRef: orderPaymentRef,
      idHash: orderIdHash,
      token: String(order.token),
      amount: BigInt(String(orderAmountRaw)),
      cancelBefore: order.cancelBefore != null ? BigInt(String(order.cancelBefore)) : claimBefore,
      claimBefore,
      refundAfter: BigInt(String(order.refundAfter)),
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
  if (!fetchFn) throw new Error("fetch is not available; pass fetchImpl");

  const timeoutMs = init.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(quoteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: JSON.stringify(serializeQuoteRequestBody(body)),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new HfiPayTimeoutError(timeoutMs, { cause: err });
    }
    throw err;
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
  const maxAttempts = init?.retry?.maxAttempts ?? 1;
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
