import { describe, expect, it, vi } from "vitest";
import {
  HfiPayConfigError,
  HfiPayTimeoutError,
  HfiPayNetworkError,
  fetchPublicSupportedAssets,
} from "../src/index.js";

function response(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  } as unknown as Response;
}

const CONFIG = {
  profile: "mainnet",
  version: 1,
  chains: [
    {
      ecosystem: "evm",
      chainId: 8453,
      network: "base",
      label: "Base",
      attestedContract: "0x1111111111111111111111111111111111111111",
      tokens: [
        {
          symbol: "ETH",
          address: "0x0000000000000000000000000000000000000000",
          decimals: 18,
          native: true,
        },
      ],
    },
    {
      ecosystem: "tron",
      chainId: 728126428,
      network: "mainnet",
      label: "Tron",
      attestedContract: "0x2222222222222222222222222222222222222222",
      tokens: [{ symbol: "TRX", contract: "native", decimals: 6, native: true }],
    },
  ],
};

describe("fetchPublicSupportedAssets", () => {
  it("returns a typed runtime registry including reviewed contract discovery fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, CONFIG));
    const result = await fetchPublicSupportedAssets("https://hfi.network/", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hfi.network/api/public/supported-assets",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.chains[0]).toMatchObject({
      ecosystem: "evm",
      chainId: 8453,
      attestedContract: "0x1111111111111111111111111111111111111111",
    });
  });

  it("rejects malformed configuration with a typed config error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, {
      ...CONFIG,
      chains: [{ ...CONFIG.chains[0], tokens: [{ symbol: "ETH", decimals: 18 }] }],
    }));
    await expect(fetchPublicSupportedAssets("https://hfi.network", { fetchImpl }))
      .rejects.toBeInstanceOf(HfiPayConfigError);
  });

  it.each([
    "0x1234",
    "0x0000000000000000000000000000000000000000",
    "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
  ])("rejects malformed or zero attestedContract %s", async (attestedContract) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, {
      ...CONFIG,
      chains: [{ ...CONFIG.chains[0], attestedContract }],
    }));
    await expect(fetchPublicSupportedAssets("https://hfi.network", { fetchImpl }))
      .rejects.toBeInstanceOf(HfiPayConfigError);
  });

  it.each([
    "0x1234",
    "0x0000000000000000000000000000000000000000",
    "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
  ])("also rejects an invalid Tron attestedContract %s", async (attestedContract) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, {
      ...CONFIG,
      chains: [{ ...CONFIG.chains[1], attestedContract }],
    }));
    await expect(fetchPublicSupportedAssets("https://hfi.network", { fetchImpl }))
      .rejects.toBeInstanceOf(HfiPayConfigError);
  });

  it("returns a typed HTTP error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(503, "unavailable"));
    await expect(fetchPublicSupportedAssets("https://hfi.network", { fetchImpl }))
      .rejects.toBeInstanceOf(HfiPayNetworkError);
  });

  it("uses a configuration-specific timeout code", async () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchImpl = vi.fn().mockRejectedValue(aborted);
    try {
      await fetchPublicSupportedAssets("https://hfi.network", { fetchImpl });
      throw new Error("expected configuration fetch to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(HfiPayTimeoutError);
      expect((err as HfiPayTimeoutError).code).toBe("CONFIG_TIMEOUT");
    }
  });
});
