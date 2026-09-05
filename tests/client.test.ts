import { describe, expect, it, vi } from "vitest";
import { GivroPayClient } from "../src/client.js";
import { GivroPayBuildTxError, GivroPayQuoteError } from "../src/errors.js";
import type { PaymentQuote, QuoteRequestBody } from "../src/types.js";

const REF = ("0x" + "ab".repeat(32)) as `0x${string}`;
const ESCROW = "0xdeadbeef00000000000000000000000000000002";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function quote(overrides: Partial<PaymentQuote> & { token?: string } = {}): PaymentQuote {
  const token = overrides.token ?? USDC;
  const chainId = overrides.chainId ?? 11155111;
  const ecosystem = overrides.ecosystem ?? "evm";
  return {
    paymentRef: REF,
    amount: "1000000",
    token,
    ecosystem,
    chainId,
    attestedContract: ESCROW,
    mandateCommit: ("0x" + "00".repeat(32)) as `0x${string}`,
    order: {
      chainId: BigInt(chainId),
      paymentRef: REF,
      intentId: ("0x" + "11".repeat(32)) as `0x${string}`,
      blindedBinding: ("0x" + "22".repeat(32)) as `0x${string}`,
      bindingEpoch: 1n,
      claimAuthorization: 0,
      token,
      amount: 1000000n,
      cancelBefore: 1n,
      claimBefore: 2n,
      refundAfter: 3n,
    },
    ...overrides,
  };
}

/** A raw portal response for `chainId`, in the wire shape `coercePaymentQuote` reads. */
function rawQuote(p: { ecosystem: "evm" | "tron"; chainId: number; token: string; amountWei: string }) {
  return {
    paymentRef: REF,
    ecosystem: p.ecosystem,
    chainId: p.chainId,
    token: p.token,
    amountWei: p.amountWei,
    attestedContract: ESCROW,
    intentBlinded: {
      escrow: ESCROW,
      mandateCommit: "0x" + "00".repeat(32),
      order: {
        chainId: p.chainId,
        paymentRef: REF,
        intentId: "0x" + "11".repeat(32),
        blindedBinding: "0x" + "22".repeat(32),
        bindingEpoch: "1",
        claimAuthorization: 0,
        token: p.token,
        amount: p.amountWei,
        cancelBefore: "1700000000",
        claimBefore: "1700000600",
        refundAfter: "1700003660",
      },
    },
  };
}

function okJson(json: unknown): Response {
  return { ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve(json) } as unknown as Response;
}

describe("GivroPayClient.prepareEvmTransactions", () => {
  const client = new GivroPayClient({
    quoteUrl: "https://example.com/quote",
    trustedAttestedContracts: { "evm:11155111": [ESCROW] },
  });

  it("builds approve + deposit for an ERC-20 quote against the pinned escrow", () => {
    const { approve, deposit } = client.prepareEvmTransactions({ quote: quote() });
    expect(approve).not.toBeNull();
    expect(BigInt(`0x${approve!.data.slice(-64)}`)).toBe(1000000n);
    expect(deposit.to.toLowerCase()).toBe(ESCROW);
  });

  it("builds a single native deposit carrying the amount as value", () => {
    const native = "0x0000000000000000000000000000000000000000";
    const { approve, deposit } = client.prepareEvmTransactions({ quote: quote({ token: native }) });
    expect(approve).toBeNull();
    expect(deposit.value).toBe(1000000n);
  });

  it("rejects a quote whose escrow is not pinned", () => {
    expect(() => client.prepareEvmTransactions({ quote: quote({ attestedContract: "0xdeadbeef00000000000000000000000000000003" }) }))
      .toThrow(GivroPayQuoteError);
  });

  it("rejects a zero escrow even when it is pinned", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const zeroPinned = new GivroPayClient({
      quoteUrl: "https://example.com/quote",
      trustedAttestedContracts: { "evm:11155111": [zero] },
    });
    expect(() => zeroPinned.prepareEvmTransactions({ quote: quote({ attestedContract: zero }) }))
      .toThrow(/canonical non-zero address/i);
  });

  it("rejects a Tron quote on the EVM builder", () => {
    expect(() => client.prepareEvmTransactions({ quote: quote({ ecosystem: "tron", chainId: 728126428, token: "native" }) }))
      .toThrow(GivroPayBuildTxError);
  });
});

describe("GivroPayClient.fetchQuote", () => {
  it("posts Tron quotes to /api/intent/quote derived from portalBaseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okJson(rawQuote({
      ecosystem: "tron", chainId: 728126428, token: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", amountWei: "1000000",
    })));
    const client = new GivroPayClient({
      quoteUrl: "https://sandbox.example.com/api/intent/quote",
      portalBaseUrl: "https://sandbox.example.com",
      fetchImpl: mockFetch,
    });
    const body: QuoteRequestBody = {
      identifier: "u@x.co", identifierKind: "email", amountWei: "1000000",
      token: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", vm: "tron", chainId: 728126428, turnstile: "",
    };
    await client.fetchQuote(body);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandbox.example.com/api/intent/quote");
  });

  it("canonicalizes TRX before sending and accepts the canonical native response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okJson(rawQuote({
      ecosystem: "tron", chainId: 728126428, token: "native", amountWei: "1000000",
    })));
    const client = new GivroPayClient({ quoteUrl: "https://example.com/api/intent/quote", fetchImpl: mockFetch });
    const q = await client.fetchQuote({
      identifier: "u@x.co", identifierKind: "email", amountWei: "1000000", amount: "1",
      token: "TRX", vm: "tron", chainId: 728126428,
    });
    expect(q.token).toBe("native");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).token).toBe("native");
  });

  it("canonicalizes ETH and matches a zero-address EVM response", async () => {
    const native = "0x0000000000000000000000000000000000000000";
    const mockFetch = vi.fn().mockResolvedValue(okJson(rawQuote({ ecosystem: "evm", chainId: 8453, token: native, amountWei: "1" })));
    const client = new GivroPayClient({ quoteUrl: "https://example.com/quote", fetchImpl: mockFetch });
    await expect(client.fetchQuote({
      identifier: "u@x.co", identifierKind: "email", amountWei: "1", token: "ETH", vm: "evm", chainId: 8453,
    })).resolves.toMatchObject({ token: native });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).token).toBe(native);
  });

  it("rejects a quote whose chain, token or amount differ from the request", async () => {
    const native = "0x0000000000000000000000000000000000000000";
    const client = (json: unknown) => new GivroPayClient({
      quoteUrl: "https://example.com/quote", fetchImpl: vi.fn().mockResolvedValue(okJson(json)),
    });
    const base = { identifier: "u@x.co", identifierKind: "email" as const, amountWei: "1", token: "ETH", vm: "evm" as const, chainId: 8453 };
    await expect(client(rawQuote({ ecosystem: "evm", chainId: 56, token: native, amountWei: "1" })).fetchQuote(base))
      .rejects.toThrow(/chainId does not match/);
    await expect(client(rawQuote({ ecosystem: "evm", chainId: 8453, token: USDC, amountWei: "1" })).fetchQuote(base))
      .rejects.toThrow(/token does not match/);
    await expect(client(rawQuote({ ecosystem: "evm", chainId: 8453, token: native, amountWei: "2" })).fetchQuote(base))
      .rejects.toThrow(/amount does not match/);
  });
});

describe("GivroPayClient.tronDepositCall", () => {
  it("matches canonical Tron hex escrow pins case-insensitively", () => {
    const pinned = new GivroPayClient({
      quoteUrl: "https://example.com/api/intent/quote",
      trustedAttestedContracts: { "tron:728126428": ["0xabcdef00000000000000000000000000000000aa"] },
    });
    const q = quote({
      ecosystem: "tron", chainId: 728126428, token: "native",
      attestedContract: "0xABCDEF00000000000000000000000000000000AA",
    });
    expect(pinned.tronDepositCall(q).escrow).toBe("0xABCDEF00000000000000000000000000000000AA");
  });

  it("rejects a non-canonical Tron settlement pin", () => {
    const base58 = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
    const pinned = new GivroPayClient({
      quoteUrl: "https://example.com/api/intent/quote",
      trustedAttestedContracts: { "tron:728126428": [base58] },
    });
    const q = quote({ ecosystem: "tron", chainId: 728126428, token: "native", attestedContract: base58 as `0x${string}` });
    expect(() => pinned.tronDepositCall(q)).toThrow(/canonical non-zero address/i);
  });
});
