import { describe, expect, it, vi } from "vitest";
import { createGivroPayClient, toWagmiSendSequence } from "../src/index.js";

const ESCROW = "0xdeadbeef00000000000000000000000000000002";
const REF = "0x" + "ab".repeat(32);

function okJson(json: Record<string, unknown>): Response {
  return { ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve(json) } as unknown as Response;
}

function portalQuote(p: { ecosystem: "evm" | "tron"; chainId: number; token: string; amountWei: string }) {
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
        cancelBefore: "1710000000",
        claimBefore: "1710000600",
        refundAfter: "1710604800",
      },
    },
  };
}

describe("consumer browser integration flow", () => {
  it("fetches an EVM browser quote with Turnstile and prepares the wagmi ERC-20 send sequence", async () => {
    const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const mockFetch = vi.fn().mockResolvedValue(okJson(portalQuote({ ecosystem: "evm", chainId: 8453, token: usdc, amountWei: "2500000" })));
    const client = createGivroPayClient({
      quoteUrl: "https://givro.to/api/intent/quote",
      fetchImpl: mockFetch,
      trustedAttestedContracts: { "evm:8453": [ESCROW] },
    });

    const quote = await client.quoteSend({
      recipientKind: "email",
      recipient: " Alice.Name+Partner@Gmail.COM ",
      amount: "2500000",
      amountHuman: "2.5",
      token: usdc,
      vm: "evm",
      chainId: 8453,
      turnstile: "fresh-turnstile-token",
    });
    const txs = client.prepareEvmTransactions({ quote });
    const wagmiSteps = toWagmiSendSequence(txs);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = new Headers(init.headers);
    expect(url).toBe("https://givro.to/api/intent/quote");
    expect(headers.get("X-API-Key")).toBeNull();
    expect(body.identifier).toBe("alicename@gmail.com");
    expect(body.identifierKind).toBe("email");
    expect(body.amountWei).toBe("2500000");
    expect(body.amount).toBe("2.5");
    expect(body.turnstile).toBe("fresh-turnstile-token");
    expect(body.ecosystem).toBe("evm");

    expect(wagmiSteps).toHaveLength(2);
    expect(wagmiSteps[0].to.toLowerCase()).toBe(usdc.toLowerCase());
    expect(wagmiSteps[0].value).toBe(0n);
    expect(wagmiSteps[1].to.toLowerCase()).toBe(ESCROW);
    expect(wagmiSteps[1].value).toBe(0n);
  });

  it("fetches a Tron X-recipient browser quote with Turnstile and an X session", async () => {
    const usdt = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const mockFetch = vi.fn().mockResolvedValue(okJson(portalQuote({ ecosystem: "tron", chainId: 728126428, token: usdt, amountWei: "12500000" })));
    const client = createGivroPayClient({
      quoteUrl: "https://givro.to/api/intent/quote",
      portalBaseUrl: "https://givro.to/",
      fetchImpl: mockFetch,
      defaultHeaders: { "X-X-Session": "sender-x-session" },
      trustedAttestedContracts: { "tron:728126428": [ESCROW] },
    });

    const quote = await client.quoteSend({
      recipientKind: "x",
      recipient: "@HFI_USER",
      amount: "12500000",
      amountHuman: "12.5",
      token: usdt,
      vm: "tron",
      chainId: 728126428,
      turnstile: "fresh-turnstile-token",
    });
    const call = client.tronDepositCall(quote);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = new Headers(init.headers);
    expect(url).toBe("https://givro.to/api/intent/quote");
    expect(headers.get("X-X-Session")).toBe("sender-x-session");
    expect(headers.get("X-API-Key")).toBeNull();
    expect(body.identifier).toBe("hfi_user");
    expect(body.identifierKind).toBe("x");
    expect(body.amount).toBe("12.5");
    expect(body.amountWei).toBe("12500000");
    expect(body.turnstile).toBe("fresh-turnstile-token");
    expect(body.ecosystem).toBe("tron");

    expect(call.functionName).toBe("depositErc20WithOrder");
    expect(call.escrow).toBe(ESCROW);
    expect(call.order.paymentRef).toBe(REF);
    expect(call.order.amount).toBe("12500000");
    expect(call.order.token).toBe(usdt);
    expect(call.order.claimBefore).toBe("1710000600");
    expect(call.callValue).toBe("0");
  });
});
