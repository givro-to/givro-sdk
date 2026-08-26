import { describe, expect, it, vi } from "vitest";
import {
  createGivroEnterpriseClient,
  GivroEnterpriseApiError,
} from "../src/index.js";

function response(status: number, body: unknown, requestId = "req_test"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "X-Request-Id": requestId }),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const link = {
  payment_link_id: "epr_test_123",
  pay_url: "https://givro.to/pay/business/epr_test_123",
  payment_link: { status: "active" },
};

describe("GivroEnterpriseClient", () => {
  it("creates a server-side payment link with explicit idempotency", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, link));
    const client = createGivroEnterpriseClient({ apiKey: "gvr_test_secret", fetchImpl });

    await expect(client.createPaymentLink({
      recipient: "merchant@example.com",
      recipient_kind: "email",
      amount: "10.00",
      ecosystem: "evm",
      chainId: 84532,
      token_symbol: "USDC",
      settlement_mode: "simulated",
    }, "invoice_1001_v1")).resolves.toEqual(link);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://givro.to/api/payment-links");
    const headers = new Headers(init.headers);
    expect(headers.get("X-API-Key")).toBe("gvr_test_secret");
    expect(headers.get("Idempotency-Key")).toBe("invoice_1001_v1");
    expect(JSON.parse(String(init.body))).toMatchObject({ ecosystem: "evm", chainId: 84532, token_symbol: "USDC" });
  });

  it("does not retry a failed write and preserves the Enterprise error details", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(409, { error: "idempotency key was already used with a different request body" }));
    const client = createGivroEnterpriseClient({ apiKey: "gvr_test_secret", fetchImpl });

    await expect(client.createAndEmailPaymentLink({
      payer_email: "payer@example.com",
      recipient: "merchant@example.com",
      recipient_kind: "email",
      amount: "10.00",
      ecosystem: "evm",
      chainId: 84532,
      token_symbol: "USDC",
    }, "invoice_1001_v1")).rejects.toMatchObject({
      name: "GivroEnterpriseApiError",
      statusCode: 409,
      requestId: "req_test",
    } satisfies Partial<GivroEnterpriseApiError>);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses the authenticated Enterprise registry and serializes list filters", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { payment_links: [], next_cursor: null }));
    const client = createGivroEnterpriseClient({ apiKey: "gvr_live_secret", baseUrl: "https://api.example/", fetchImpl });

    await client.listPaymentLinks({ status: "active", limit: 25 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example/api/payment-links?status=active&limit=25");
    expect(new Headers(init.headers).get("X-API-Key")).toBe("gvr_live_secret");
  });
});

describe("enterprise API errors", () => {
  it("surfaces the code and message the server actually sent", () => {
    // Body captured verbatim from a running portal. The nested shape is what
    // made the previous extraction fall through to a bare status line.
    const err = new GivroEnterpriseApiError(401, {
      request_id: "req_3f8b9d5d438025d2917c474196f41fc1",
      error: { code: "invalid_api_key", message: "Invalid or missing API key" },
    }, { requestId: "req_3f8b9d5d438025d2917c474196f41fc1" });
    expect(err.errorCode).toBe("invalid_api_key");
    expect(err.message).toContain("Invalid or missing API key");
    expect(err.message).not.toBe("Givro Enterprise API returned HTTP 401");
    expect(err.requestId).toBe("req_3f8b9d5d438025d2917c474196f41fc1");
  });

  it("still falls back when the server sends no structured error", () => {
    const err = new GivroEnterpriseApiError(500, "gateway exploded");
    expect(err.message).toBe("Givro Enterprise API returned HTTP 500");
    expect(err.errorCode).toBeUndefined();
  });
});
