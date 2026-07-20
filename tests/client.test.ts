import { describe, expect, it, vi } from "vitest";
import { GivroPayClient } from "../src/client.js";
import { GivroPayBuildTxError, GivroPayQuoteError } from "../src/errors.js";
import type { PaymentQuote } from "../src/types.js";
import type { QuoteRequestBody } from "../src/types.js";

describe("GivroPayClient.prepareEvmTransactions", () => {
  const attestedContract = "0xdeadbeef00000000000000000000000000000002";
  const client = new GivroPayClient({
    quoteUrl: "https://example.com/quote",
    trustedAttestedContracts: { "evm:11155111": [attestedContract] },
  });

  it("builds attested transactions when quote has attested fields", () => {
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1000000",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ecosystem: "evm",
      chainId: 11155111,
      attestedContract,
      attestedOrder: {
        chainId: 11155111n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        idHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amount: 1000000n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    };
    const { approve, deposit } = client.prepareEvmTransactions({ quote });
    expect(approve).not.toBeNull();
    expect(BigInt(`0x${approve!.data.slice(-64)}`)).toBe(quote.attestedOrder!.amount);
    expect(deposit.to.toLowerCase()).toBe(quote.attestedContract!.toLowerCase());
  });

  it("throws a readable error when attested order fields are incomplete", () => {
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1000000",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ecosystem: "evm",
      chainId: 11155111,
      attestedContract,
      attestedOrder: {
        chainId: 11155111n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        idHash: "" as `0x${string}`,
        token: "" as `0x${string}`,
        amount: 1000000n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    };
    expect(() => client.prepareEvmTransactions({ quote })).toThrow(/attested quote missing order/i);
  });

  it("throws a readable error when attested quote is missing idHash", () => {
    const quote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1000000",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ecosystem: "evm" as const,
      chainId: 11155111,
      attestedContract: attestedContract as `0x${string}`,
      attestedOrder: {
        chainId: 11155111n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
        amount: 1000000n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    } as unknown as PaymentQuote;
    expect(() => client.prepareEvmTransactions({ quote })).toThrow(/idHash/i);
  });

  it("rejects legacy/basic EVM quotes on the default transaction builder", () => {
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1000000",
      token: "0x0000000000000000000000000000000000000000",
      ecosystem: "evm",
      chainId: 11155111,
      depositContract: "0xdeadbeef00000000000000000000000000000001",
    };
    expect(() => client.prepareEvmTransactions({ quote })).toThrow(GivroPayBuildTxError);
  });

  it("rejects attested quotes when top-level token differs from order token", () => {
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1000000",
      token: "0x0000000000000000000000000000000000000000",
      ecosystem: "evm",
      chainId: 11155111,
      attestedContract,
      attestedOrder: {
        chainId: 11155111n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        idHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amount: 1000000n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    };
    expect(() => client.prepareEvmTransactions({ quote })).toThrow(/token mismatch/i);
  });

  it("rejects quotes that point at an untrusted settlement contract", () => {
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1000000",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ecosystem: "evm",
      chainId: 11155111,
      attestedContract: "0xdeadbeef00000000000000000000000000000003",
      attestedOrder: {
        chainId: 11155111n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        idHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amount: 1000000n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    };
    expect(() => client.prepareEvmTransactions({ quote })).toThrow(GivroPayQuoteError);
  });

  it("rejects a zero settlement contract even when it is pinned", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const zeroPinnedClient = new GivroPayClient({
      quoteUrl: "https://example.com/quote",
      trustedAttestedContracts: { "evm:11155111": [zero] },
    });
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1",
      token: zero,
      ecosystem: "evm",
      chainId: 11155111,
      attestedContract: zero,
      attestedOrder: {
        chainId: 11155111n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        idHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
        token: zero,
        amount: 1n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    };
    expect(() => zeroPinnedClient.prepareEvmTransactions({ quote }))
      .toThrow(/canonical non-zero address/i);
  });

  it("rejects top-level and on-chain order amount mismatches", () => {
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "999999",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ecosystem: "evm",
      chainId: 11155111,
      attestedContract,
      attestedOrder: {
        chainId: 11155111n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        idHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amount: 1000000n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    };
    expect(() => client.prepareEvmTransactions({ quote })).toThrow(/amount mismatch/i);
  });
});

describe("GivroPayClient.fetchQuote (Tron)", () => {
  it("posts to /api/intent/quote derived from portalBaseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
      json: () =>
        Promise.resolve({
          paymentRef: "0x" + "ab".repeat(32),
          ecosystem: "tron",
          chainId: 728126428,
          token: "T1",
          amount: "1000000",
          attestedContract: "0xdeadbeef00000000000000000000000000000002",
          order: {
            chainId: 728126428,
            paymentRef: "0x" + "ab".repeat(32),
            idHash: "0x" + "cd".repeat(32),
            token: "T1",
            amount: "1000000",
            cancelBefore: "1700000000",
            claimBefore: "1700000600",
            refundAfter: "1700003660",
          },
        }),
    } as unknown as Response);

    const client = new GivroPayClient({
      quoteUrl: "https://sandbox.example.com/api/intent/quote",
      portalBaseUrl: "https://sandbox.example.com",
      fetchImpl: mockFetch,
    });

    const body: QuoteRequestBody = {
      identifier: "u@x.co",
      identifierKind: "email",
      amountWei: "1000000",
      token: "T1",
      vm: "tron",
      chainId: 728126428,
      turnstile: "",
    };
    await client.fetchQuote(body);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandbox.example.com/api/intent/quote");
  });

  it("canonicalizes TRX before sending and accepts the canonical native response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({
        paymentRef: "0x" + "ab".repeat(32),
        ecosystem: "tron",
        chainId: 728126428,
        token: "native",
        amountWei: "1000000",
        amount: "1",
      }),
    } as unknown as Response);
    const client = new GivroPayClient({
      quoteUrl: "https://example.com/api/intent/quote",
      fetchImpl: mockFetch,
    });
    await client.fetchQuote({
      identifier: "u@x.co",
      identifierKind: "email",
      amountWei: "1000000",
      amount: "1",
      token: "TRX",
      vm: "tron",
      chainId: 728126428,
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).token).toBe("native");
  });

  it("matches canonical Tron hex contract pins case-insensitively", () => {
    const pinned = new GivroPayClient({
      quoteUrl: "https://example.com/api/intent/quote",
      trustedAttestedContracts: {
        "tron:728126428": ["0xabcdef00000000000000000000000000000000aa"],
      },
    });
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1",
      token: "native",
      ecosystem: "tron",
      chainId: 728126428,
      attestedContract: "0xABCDEF00000000000000000000000000000000AA",
      attestedOrder: {
        chainId: 728126428n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        idHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
        token: "native",
        amount: 1n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    };
    expect(() => pinned.tronAttestedOrderTuple(quote)).not.toThrow();
  });

  it("rejects a non-canonical Tron settlement pin", () => {
    const base58 = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
    const pinned = new GivroPayClient({
      quoteUrl: "https://example.com/api/intent/quote",
      trustedAttestedContracts: { "tron:728126428": [base58] },
    });
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1",
      token: "native",
      ecosystem: "tron",
      chainId: 728126428,
      attestedContract: base58,
      attestedOrder: {
        chainId: 728126428n,
        paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
        idHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
        token: "native",
        amount: 1n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    };
    expect(() => pinned.tronAttestedOrderTuple(quote))
      .toThrow(/canonical non-zero address/i);
  });
});

describe("GivroPayClient.fetchQuote native token aliases", () => {
  it("canonicalizes ETH and matches a zero-address EVM response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({
        paymentRef: "0x" + "ab".repeat(32),
        ecosystem: "evm",
        chainId: 8453,
        token: "0x0000000000000000000000000000000000000000",
        amountWei: "1",
      }),
    } as unknown as Response);
    const client = new GivroPayClient({ quoteUrl: "https://example.com/quote", fetchImpl: mockFetch });
    await expect(client.fetchQuote({
      identifier: "u@x.co",
      identifierKind: "email",
      amountWei: "1",
      token: "ETH",
      vm: "evm",
      chainId: 8453,
    })).resolves.toMatchObject({ token: "0x0000000000000000000000000000000000000000" });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).token).toBe("0x0000000000000000000000000000000000000000");
  });

  it("canonicalizes SOL and matches the legacy default-pubkey response marker", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({
        paymentRef: "0x" + "ab".repeat(32),
        ecosystem: "solana",
        token: "11111111111111111111111111111111",
        amountWei: "1",
      }),
    } as unknown as Response);
    const client = new GivroPayClient({ quoteUrl: "https://example.com/quote", fetchImpl: mockFetch });
    await expect(client.fetchQuote({
      identifier: "u@x.co",
      identifierKind: "email",
      amountWei: "1",
      token: "SOL",
      vm: "solana",
    })).resolves.toMatchObject({ token: "native" });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).token).toBe("native");
  });
});
