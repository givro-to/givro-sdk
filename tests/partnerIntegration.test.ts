import { describe, expect, it, vi } from "vitest";
import {
  createHfiPayClient,
  toWagmiSendSequence,
} from "../src/index.js";

function okJson(json: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve(json),
  } as unknown as Response;
}

describe("partner integration flow", () => {
  it("fetches an EVM partner quote and prepares the wagmi ERC-20 send sequence", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okJson({
      paymentRef: "0x" + "ab".repeat(32),
      ecosystem: "evm",
      chainId: 8453,
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "2500000",
      attestedContract: "0xdeadbeef00000000000000000000000000000002",
      order: {
        chainId: 8453,
        paymentRef: "0x" + "ab".repeat(32),
        idHash: "0x" + "cd".repeat(32),
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "2500000",
        cancelBefore: "1710000000",
        claimBefore: "1710000600",
        refundAfter: "1710604800",
      },
    }));
    const client = createHfiPayClient({
      quoteUrl: "https://partner.hfi.network/api/portal/v1/quote",
      fetchImpl: mockFetch,
      defaultHeaders: { "X-API-Key": "partner_test_key" },
    });

    const quote = await client.quoteSend({
      recipientKind: "email",
      recipient: " Alice+Partner@Example.COM ",
      amount: "2500000",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      vm: "evm",
      chainId: 8453,
      senderWalletAddr: "0x1111111111111111111111111111111111111111",
      senderWalletEcosystem: "evm",
    });
    const txs = client.prepareEvmTransactions({ quote });
    const wagmiSteps = toWagmiSendSequence(txs);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe("https://partner.hfi.network/api/portal/v1/quote");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("partner_test_key");
    expect(body.identifier).toBe("alice@example.com");
    expect(body.identifierKind).toBe("email");
    expect(body.amountWei).toBe("2500000");
    expect(body.ecosystem).toBe("evm");
    expect(body.senderWalletAddr).toBe("0x1111111111111111111111111111111111111111");

    expect(wagmiSteps).toHaveLength(2);
    expect(wagmiSteps[0].to.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(wagmiSteps[0].value).toBe(0n);
    expect(wagmiSteps[1].to.toLowerCase()).toBe("0xdeadbeef00000000000000000000000000000002");
    expect(wagmiSteps[1].value).toBe(0n);
  });

  it("fetches a Tron partner quote through the intent endpoint and prepares the TronWeb order tuple", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okJson({
      paymentRef: "0x" + "ef".repeat(32),
      ecosystem: "tron",
      chainId: 728126428,
      token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      amount: "12500000",
      attestedContract: "0x00000000000000000000000000000000000000aa",
      order: {
        chainId: 728126428,
        paymentRef: "0x" + "ef".repeat(32),
        idHash: "0x" + "12".repeat(32),
        token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        amountWei: "12500000",
        cancelBefore: "1710000000",
        claimBefore: "1710000600",
        refundAfter: "1710604800",
      },
    }));
    const client = createHfiPayClient({
      quoteUrl: "https://partner.hfi.network/api/portal/v1/quote",
      portalBaseUrl: "https://partner.hfi.network/",
      fetchImpl: mockFetch,
      defaultHeaders: { "X-API-Key": "partner_test_key" },
    });

    const quote = await client.quoteSend({
      recipientKind: "x",
      recipient: "@HFI_USER",
      amount: "12500000",
      amountHuman: "12.5",
      token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      vm: "tron",
      chainId: 728126428,
      senderWalletAddr: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      senderWalletEcosystem: "tron",
    });
    const tuple = client.tronAttestedOrderTuple(quote);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe("https://partner.hfi.network/api/intent/quote");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("partner_test_key");
    expect(body.identifier).toBe("hfi_user");
    expect(body.identifierKind).toBe("x");
    expect(body.amount).toBe("12.5");
    expect(body.amountWei).toBe("12500000");
    expect(body.ecosystem).toBe("tron");
    expect(body.senderWalletEcosystem).toBe("tron");

    expect(tuple.paymentRef).toBe("0x" + "ef".repeat(32));
    expect(tuple.idHash).toBe("0x" + "12".repeat(32));
    expect(tuple.amount).toBe("12500000");
    expect(tuple.token).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(tuple.claimBefore).toBe("1710000600");
  });
});
