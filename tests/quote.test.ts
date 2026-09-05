import { describe, it, expect, vi, beforeEach } from "vitest";
import { coercePaymentQuote, fetchPaymentQuote, serializeQuoteRequestBody } from "../src/quote.js";
import { GivroPayError, GivroPayNetworkError, GivroPayQuoteError } from "../src/errors.js";
import type { QuoteRequestBody } from "../src/types.js";

const VALID_REF = "0x" + "ab".repeat(32);
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ESCROW = "0xDeAdBeEf00000000000000000000000000000002";

function raw(overrides: Record<string, unknown> = {}, order: Record<string, unknown> = {}) {
  const chainId = (overrides.chainId as number | undefined) ?? 1;
  const token = (overrides.token as string | undefined) ?? USDC;
  return {
    paymentRef: VALID_REF,
    ecosystem: "evm",
    chainId,
    token,
    amountWei: "1000000",
    attestedContract: ESCROW,
    intentBlinded: {
      escrow: ESCROW,
      mandateCommit: "0x" + "00".repeat(32),
      order: {
        chainId,
        paymentRef: VALID_REF,
        intentId: "0x" + "11".repeat(32),
        blindedBinding: "0x" + "22".repeat(32),
        bindingEpoch: "1",
        claimAuthorization: 0,
        token,
        amount: "1000000",
        cancelBefore: "1710000000",
        claimBefore: "1710000600",
        refundAfter: "1710003660",
        ...order,
      },
    },
    ...overrides,
  };
}

const QUOTE_BODY: QuoteRequestBody = {
  identifier: "user@example.com",
  identifierKind: "email",
  amountWei: "1000000",
  token: USDC,
  ecosystem: "evm",
  chainId: 1,
};

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
    const q = coercePaymentQuote(raw());
    expect(q.paymentRef).toBe(VALID_REF);
    expect(q.amount).toBe("1000000");
    expect(q.token).toBe(USDC);
    expect(q.ecosystem).toBe("evm");
    expect(q.chainId).toBe(1);
    expect(q.attestedContract).toBe(ESCROW);
    expect(q.order.amount).toBe(1000000n);
    expect(q.order.cancelBefore).toBe(1710000000n);
  });

  it("accepts payment_ref (snake_case) and a paymentRef without 0x", () => {
    expect(coercePaymentQuote({ ...raw(), paymentRef: undefined, payment_ref: VALID_REF }).paymentRef).toBe(VALID_REF);
    const noPrefix = raw({ paymentRef: "ab".repeat(32) }, { paymentRef: "ab".repeat(32) });
    expect(coercePaymentQuote(noPrefix).paymentRef).toBe(VALID_REF);
  });

  it("takes the escrow from the settlement material when attestedContract is absent", () => {
    const { attestedContract: _a, ...rest } = raw();
    expect(coercePaymentQuote(rest).attestedContract).toBe(ESCROW);
  });

  it("defaults a missing mandateCommit to zero", () => {
    const r = raw();
    delete (r.intentBlinded as Record<string, unknown>).mandateCommit;
    expect(coercePaymentQuote(r).mandateCommit).toBe("0x" + "00".repeat(32));
  });

  it("parses a Tron quote with a base58 TRC20 token", () => {
    const usdt = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    const q = coercePaymentQuote(raw({ ecosystem: "tron", chainId: 728126428, token: usdt }));
    expect(q.ecosystem).toBe("tron");
    expect(q.order.token).toBe(usdt);
    expect(q.order.amount).toBe(1000000n);
  });

  it("canonicalizes explicit native aliases in quote responses", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    expect(coercePaymentQuote(raw({ token: "ETH" }, { token: "ETH" })).token).toBe(zero);
    expect(coercePaymentQuote(raw({ ecosystem: "tron", token: "TRX" }, { token: "TRX" })).token).toBe("native");
    expect(coercePaymentQuote(raw({ token: "USDC" }, { token: "USDC" })).token).toBe("USDC");
  });

  it("rejects an EVM native symbol that does not match the quoted chain", () => {
    expect(() => coercePaymentQuote(raw({ token: "BNB" }, { token: "BNB" })))
      .toThrow(/not the native asset for EVM chain 1/i);
  });

  it.each([
    ["paymentRef", { paymentRef: undefined }, /paymentRef/],
    ["chainId", { chainId: undefined }, /chainId/],
    ["ecosystem", { ecosystem: "solana" }, /ecosystem must be evm \| tron/],
    ["settlement material", { intentBlinded: undefined }, /settlement material/],
    ["escrow", { intentBlinded: { escrow: "0x0000000000000000000000000000000000000000", order: {} } }, /escrow/],
  ])("throws when %s is missing or invalid", (_label, overrides, pattern) => {
    expect(() => coercePaymentQuote({ ...raw(), ...overrides } as Record<string, unknown>)).toThrow(pattern);
  });

  it.each([
    ["intentId", { intentId: undefined }],
    ["blindedBinding", { blindedBinding: "0x1234" }],
    ["amount", { amount: "0" }],
    ["windows", { cancelBefore: "9", claimBefore: "2", refundAfter: "3" }],
    ["claimAuthorization", { claimAuthorization: 5 }],
  ])("throws when the order's %s is invalid", (_label, order) => {
    expect(() => coercePaymentQuote(raw({}, order as Record<string, unknown>))).toThrow(GivroPayQuoteError);
  });

  it("rejects a top-level token or amount that disagrees with the order", () => {
    expect(() => coercePaymentQuote(raw({ amountWei: "5" }))).toThrow(/amountWei disagrees/);
    expect(() => coercePaymentQuote(raw({ token: "0x0000000000000000000000000000000000000000" }, { token: USDC })))
      .toThrow(/token disagrees/);
  });
});

describe("fetchPaymentQuote", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("returns a coerced quote on 200 OK", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, raw()));
    const q = await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch });
    expect(q.paymentRef).toBe(VALID_REF);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("calls the correct URL with POST", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, raw()));
    await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch });
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/quote");
    expect(opts.method).toBe("POST");
  });

  it("throws GivroPayNetworkError on non-2xx response, carrying statusCode", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(422, "unprocessable"));
    try {
      await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GivroPayNetworkError);
      expect((err as GivroPayNetworkError).statusCode).toBe(422);
    }
  });

  it("throws GivroPayQuoteError when response JSON is invalid shape", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { not: "a quote" }));
    await expect(fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch }))
      .rejects.toBeInstanceOf(GivroPayQuoteError);
  });

  it("wraps network-level failures in a typed quote error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    try {
      await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, { fetchImpl: mockFetch });
      throw new Error("expected fetchPaymentQuote to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(GivroPayError);
      expect((err as GivroPayError).code).toBe("QUOTE_FETCH_FAILED");
    }
  });

  it("retries on 5xx and succeeds on second attempt", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(503, "service unavailable"))
      .mockResolvedValueOnce(makeResponse(200, raw()));
    const q = await fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, {
      fetchImpl: mockFetch,
      retry: { maxAttempts: 2, baseDelayMs: 0 },
    });
    expect(q.paymentRef).toBe(VALID_REF);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx client errors", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(400, "bad request"));
    await expect(fetchPaymentQuote("https://example.com/quote", QUOTE_BODY, {
      fetchImpl: mockFetch,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    })).rejects.toBeInstanceOf(GivroPayNetworkError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not automatically replay a single-use Turnstile token, even an empty one", async () => {
    mockFetch.mockResolvedValue(makeResponse(503, "service unavailable"));
    for (const turnstile of ["single-use", ""]) {
      mockFetch.mockClear();
      await expect(fetchPaymentQuote("https://example.com/quote", { ...QUOTE_BODY, turnstile }, {
        fetchImpl: mockFetch,
        retry: { maxAttempts: 3, baseDelayMs: 0 },
      })).rejects.toBeInstanceOf(GivroPayNetworkError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("canonicalizes only explicit native aliases when serializing", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, token: "ETH" }).token).toBe(zero);
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" }).token).toBe(zero);
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 56, token: "BNB" }).token).toBe(zero);
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 137, token: "POL" }).token).toBe(zero);
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 43114, token: "AVAX" }).token).toBe(zero);
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, chainId: 31338, token: "GO" }).token).toBe(zero);
    expect(serializeQuoteRequestBody({ ...QUOTE_BODY, vm: "tron", ecosystem: "tron", token: "TRX" }).token).toBe("native");
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
      identifier: "a@b.co", identifierKind: "email", amountWei: "1000000", amount: "1.0",
      token: "TTRC20", vm: "tron", ecosystem: "tron", chainId: 728126428, turnstile: "ts-token",
    };
    expect(serializeQuoteRequestBody(body)).toMatchObject({
      ecosystem: "tron", amount: "1.0", amountWei: "1000000", turnstile: "ts-token",
    });
  });
});
