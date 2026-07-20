import { describe, it, expect, vi, beforeEach } from "vitest";
import { coercePaymentQuote, fetchPaymentQuote, serializeQuoteRequestBody } from "../src/quote.js";
import { HfiPayError, HfiPayNetworkError, HfiPayQuoteError } from "../src/errors.js";
import type { QuoteRequestBody } from "../src/types.js";

const VALID_REF = "0x" + "ab".repeat(32);
const VALID_RAW = {
  paymentRef: VALID_REF,
  amount: "1000000",
  token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  ecosystem: "evm" as const,
  chainId: 1,
  depositContract: "0xDeAdBeEf00000000000000000000000000000001",
};

const QUOTE_BODY: QuoteRequestBody = {
  identifier: "user@example.com",
  identifierKind: "email",
  amountWei: "1000000",
  token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  ecosystem: "evm",
  chainId: 1,
};

// Helper: build a minimal Response-like object for the mock fetch
function makeResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  } as unknown as Response;
}

describe("coercePaymentQuote", () => {
  it("normalizes a fully valid raw object", () => {
    const q = coercePaymentQuote(VALID_RAW);
    expect(q.paymentRef).toBe(VALID_REF);
    expect(q.amount).toBe("1000000");
    expect(q.token).toBe(VALID_RAW.token);
    expect(q.ecosystem).toBe("evm");
    expect(q.chainId).toBe(1);
    expect(q.depositContract).toBe(VALID_RAW.depositContract);
  });

  it("accepts payment_ref (snake_case) as alias for paymentRef", () => {
    const raw = { ...VALID_RAW, paymentRef: undefined, payment_ref: VALID_REF };
    const q = coercePaymentQuote(raw as Record<string, unknown>);
    expect(q.paymentRef).toBe(VALID_REF);
  });

  it("adds 0x prefix when paymentRef lacks it", () => {
    const raw = { ...VALID_RAW, paymentRef: "ab".repeat(32) };
    const q = coercePaymentQuote(raw);
    expect(q.paymentRef.startsWith("0x")).toBe(true);
  });

  it("accepts deposit_contract (snake_case) alias", () => {
    const raw = { ...VALID_RAW, depositContract: undefined, deposit_contract: VALID_RAW.depositContract };
    const q = coercePaymentQuote(raw as Record<string, unknown>);
    expect(q.depositContract).toBe(VALID_RAW.depositContract);
  });

  it("works for solana ecosystem", () => {
    const raw = { ...VALID_RAW, ecosystem: "solana" as const, programId: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS" };
    const q = coercePaymentQuote(raw);
    expect(q.ecosystem).toBe("solana");
    expect(q.programId).toBe(raw.programId);
  });

  it("parses attested EVM quote fields for send flow", () => {
    const raw = {
      paymentRef: VALID_REF,
      ecosystem: "evm" as const,
      token: VALID_RAW.token,
      amount: "1000000",
      attestedContract: "0xDeAdBeEf00000000000000000000000000000002",
      order: {
        chainId: 11155111,
        idHash: "0x" + "cd".repeat(32),
        token: VALID_RAW.token,
        amount: "1000000",
        claimBefore: "1710000000",
        refundAfter: "1710003600",
      },
    };
    const q = coercePaymentQuote(raw as Record<string, unknown>);
    expect(q.attestedContract).toBe(raw.attestedContract);
    expect(q.attestedOrder).toBeDefined();
    expect(q.attestedOrder?.paymentRef).toBe(VALID_REF);
    expect(q.attestedOrder?.chainId).toBe(11155111n);
    expect(q.attestedOrder?.cancelBefore).toBe(q.attestedOrder?.claimBefore);
  });

  it("throws when attested quote is missing order.idHash", () => {
    const raw = {
      paymentRef: VALID_REF,
      ecosystem: "evm" as const,
      token: VALID_RAW.token,
      amount: "1000000",
      attestedContract: "0xDeAdBeEf00000000000000000000000000000002",
      order: {
        chainId: 11155111,
        token: VALID_RAW.token,
        amount: "1000000",
        claimBefore: "1710000000",
        refundAfter: "1710003600",
      },
    };
    expect(() => coercePaymentQuote(raw as Record<string, unknown>)).toThrow(/missing required fields/);
  });

  it("throws when paymentRef is missing", () => {
    const raw = { ...VALID_RAW, paymentRef: undefined };
    expect(() => coercePaymentQuote(raw as Record<string, unknown>)).toThrow(/paymentRef/);
  });

  it("throws when paymentRef is wrong length", () => {
    const raw = { ...VALID_RAW, paymentRef: "0xdeadbeef" };
    expect(() => coercePaymentQuote(raw)).toThrow(/paymentRef/);
  });

  it("throws when amount is missing", () => {
    const raw = { ...VALID_RAW, amount: undefined };
    expect(() => coercePaymentQuote(raw as Record<string, unknown>)).toThrow(/amount/);
  });

  it("throws when token is missing", () => {
    const raw = { ...VALID_RAW, token: undefined };
    expect(() => coercePaymentQuote(raw as Record<string, unknown>)).toThrow(/token/);
  });

  it("throws when ecosystem is invalid", () => {
    const raw = { ...VALID_RAW, ecosystem: "bitcoin" as "evm" };
    expect(() => coercePaymentQuote(raw)).toThrow(/ecosystem must be evm \| solana \| tron/);
  });

  it("parses Tron attested quote (TRC20 base58 token)", () => {
    const raw = {
      paymentRef: VALID_REF,
      ecosystem: "tron" as const,
      chainId: 728126428,
      token: "TXYZabc",
      amount: "1000000",
      attestedContract: "0xDeAdBeEf00000000000000000000000000000002",
      order: {
        chainId: 728126428,
        paymentRef: VALID_REF,
        idHash: "0x" + "cd".repeat(32),
        token: "TXYZabc",
        amount: "1000000",
        cancelBefore: "1710000000",
        claimBefore: "1710000600",
        refundAfter: "1710003660",
      },
    };
    const q = coercePaymentQuote(raw as Record<string, unknown>);
    expect(q.ecosystem).toBe("tron");
    expect(q.attestedContract).toBe(raw.attestedContract);
    expect(q.attestedOrder?.token).toBe("TXYZabc");
    expect(q.attestedOrder?.amount).toBe(1000000n);
  });

  it("canonicalizes explicit native aliases in quote responses", () => {
    expect(coercePaymentQuote({ ...VALID_RAW, token: "ETH" }).token)
      .toBe("0x0000000000000000000000000000000000000000");
    expect(coercePaymentQuote({ ...VALID_RAW, ecosystem: "tron", token: "TRX" }).token)
      .toBe("native");
    expect(coercePaymentQuote({ ...VALID_RAW, ecosystem: "solana", token: "SOL" }).token)
      .toBe("native");
    expect(coercePaymentQuote({ ...VALID_RAW, token: "USDC" }).token).toBe("USDC");
  });

  it("rejects an EVM native symbol that does not match the quoted chain", () => {
    expect(() => coercePaymentQuote({ ...VALID_RAW, token: "BNB" }))
      .toThrow(/not the native asset for EVM chain 1/i);
  });

  it("accepts order.amountWei alias for attested amount", () => {
    const raw = {
      paymentRef: VALID_REF,
      ecosystem: "tron" as const,
      token: "TToken",
      amount: "1",
      attestedContract: "0xDeAdBeEf00000000000000000000000000000002",
      order: {
        chainId: 1,
        idHash: "0x" + "cd".repeat(32),
        token: "TToken",
        amountWei: "999",
        claimBefore: "1710000600",
        refundAfter: "1710003660",
      },
    };
    const q = coercePaymentQuote(raw as Record<string, unknown>);
    expect(q.attestedOrder?.amount).toBe(999n);
  });
});

describe("fetchPaymentQuote", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("returns a coerced quote on 200 OK", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, VALID_RAW));
    const q = await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, {
      fetchImpl: mockFetch,
    });
    expect(q.paymentRef).toBe(VALID_REF);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("calls the correct URL with POST", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, VALID_RAW));
    await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch });
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/quote");
    expect(opts.method).toBe("POST");
  });

  it("throws HfiPayNetworkError on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(400, "bad request"));
    await expect(
      fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch }),
    ).rejects.toBeInstanceOf(HfiPayNetworkError);
  });

  it("HfiPayNetworkError carries statusCode", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(422, "unprocessable"));
    try {
      await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch });
    } catch (err) {
      expect(err).toBeInstanceOf(HfiPayNetworkError);
      expect((err as HfiPayNetworkError).statusCode).toBe(422);
    }
  });

  it("throws HfiPayQuoteError when response JSON is invalid shape", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { not: "a quote" }));
    await expect(
      fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch }),
    ).rejects.toBeInstanceOf(HfiPayQuoteError);
  });

  it("wraps network-level failures in a typed quote error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    try {
      await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch });
      throw new Error("expected fetchPaymentQuote to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HfiPayError);
      expect((err as HfiPayError).code).toBe("QUOTE_FETCH_FAILED");
    }
  });

  it("retries on 5xx and succeeds on second attempt", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(503, "service unavailable"))
      .mockResolvedValueOnce(makeResponse(200, VALID_RAW));
    const q = await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, {
      fetchImpl: mockFetch,
      retry: { maxAttempts: 2, baseDelayMs: 0 },
    });
    expect(q.paymentRef).toBe(VALID_REF);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx client errors", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(400, "bad request"));
    await expect(
      fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, {
        fetchImpl: mockFetch,
        retry: { maxAttempts: 3, baseDelayMs: 0 },
      }),
    ).rejects.toBeInstanceOf(HfiPayNetworkError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not automatically replay a single-use Turnstile token", async () => {
    mockFetch.mockResolvedValue(makeResponse(503, "service unavailable"));
    await expect(
      fetchPaymentQuote("https://example.com/quote", { ...QUOTE_BODY, turnstile: "single-use" }, {
        fetchImpl: mockFetch,
        retry: { maxAttempts: 3, baseDelayMs: 0 },
      }),
    ).rejects.toBeInstanceOf(HfiPayNetworkError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("also disables retry when the caller explicitly supplies an empty development Turnstile value", async () => {
    mockFetch.mockResolvedValue(makeResponse(503, "service unavailable"));
    await expect(
      fetchPaymentQuote("https://example.com/quote", { ...QUOTE_BODY, turnstile: "" }, {
        fetchImpl: mockFetch,
        retry: { maxAttempts: 3, baseDelayMs: 0 },
      }),
    ).rejects.toBeInstanceOf(HfiPayNetworkError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes only explicit native aliases when serializing", () => {
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, token: "ETH" }).token)
      .toBe("0x0000000000000000000000000000000000000000");
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" }).token)
      .toBe("0x0000000000000000000000000000000000000000");
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 56, token: "BNB" }).token)
      .toBe("0x0000000000000000000000000000000000000000");
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 137, token: "POL" }).token)
      .toBe("0x0000000000000000000000000000000000000000");
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 43114, token: "AVAX" }).token)
      .toBe("0x0000000000000000000000000000000000000000");
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 31337, token: "GO" }).token)
      .toBe("0x0000000000000000000000000000000000000000");
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, vm: "tron", ecosystem: "tron", token: "TRX" }).token)
      .toBe("native");
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, vm: "solana", ecosystem: "solana", token: "SOL" }).token)
      .toBe("native");
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, token: "USDC" }).token).toBe("USDC");
  });

  it("fails closed when an EVM native symbol has a missing or mismatched chainId", () => {
    expect(() => serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: undefined, token: "ETH" }))
      .toThrow(/chainId is required/i);
    expect(() => serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 8453, token: "BNB" }))
      .toThrow(/not the native asset/i);
  });

  it("serializes Tron intent quote body with turnstile and human amount", () => {
    const body: QuoteRequestBody = {
      identifier: "a@b.co",
      identifierKind: "email",
      amountWei: "1000000",
      amount: "1.0",
      token: "TTRC20",
      vm: "tron",
      ecosystem: "tron",
      chainId: 728126428,
      turnstile: "ts-token",
    };
    const json = serializeQuoteRequestBody(body);
    expect(json).toMatchObject({
      ecosystem: "tron",
      amount: "1.0",
      amountWei: "1000000",
      turnstile: "ts-token",
    });
  });
});
