import { describe, expect, it, vi } from "vitest";
import { HfiPayClient } from "../src/client.js";
import type { PaymentQuote } from "../src/types.js";
import type { QuoteRequestBody } from "../src/types.js";

describe("HfiPayClient.prepareEvmTransactions", () => {
  const client = new HfiPayClient({ quoteUrl: "https://example.com/quote" });

  it("builds attested transactions when quote has attested fields", () => {
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1000000",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ecosystem: "evm",
      attestedContract: "0xdeadbeef00000000000000000000000000000002",
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
    expect(deposit.to.toLowerCase()).toBe(quote.attestedContract!.toLowerCase());
  });

  it("throws a readable error when attested order fields are incomplete", () => {
    const quote: PaymentQuote = {
      paymentRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
      amount: "1000000",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ecosystem: "evm",
      attestedContract: "0xdeadbeef00000000000000000000000000000002",
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
      attestedContract: "0xdeadbeef00000000000000000000000000000002" as `0x${string}`,
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
});

describe("HfiPayClient.fetchQuote (Tron)", () => {
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
          amount: "1",
          attestedContract: "0xdeadbeef00000000000000000000000000000002",
          order: {
            chainId: 728126428,
            paymentRef: "0x" + "ab".repeat(32),
            idHash: "0x" + "cd".repeat(32),
            token: "T1",
            amount: "1",
            cancelBefore: "1700000000",
            claimBefore: "1700000600",
            refundAfter: "1700003660",
          },
        }),
    } as unknown as Response);

    const client = new HfiPayClient({
      quoteUrl: "https://testnet.hfi.network/api/portal/v1/quote",
      portalBaseUrl: "https://testnet.hfi.network",
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
    expect(url).toBe("https://testnet.hfi.network/api/intent/quote");
  });
});
