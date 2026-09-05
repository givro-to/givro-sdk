import { describe, it, expect } from "vitest";
import { getNetwork, NETWORKS, intentQuoteUrlForPortal } from "../src/config.js";
import type { NetworkName } from "../src/config.js";

describe("getNetwork", () => {
  it("returns the local devnet preset", () => {
    const net = getNetwork("devnet");
    expect(net.name).toBe("devnet");
    expect(net.evmChainIds).toEqual([31338]);
    expect(net.defaultQuoteUrl).toContain("localhost");
  });

  it("returns the mainnet preset: Base, BNB Smart Chain and Tron", () => {
    const net = getNetwork("mainnet");
    expect(net.name).toBe("mainnet");
    expect(net.evmChainIds).toEqual([8453, 56]);
    expect(net.tronChainId).toBe(728126428);
    expect(net.defaultQuoteUrl).toContain("givro.to");
    expect(Object.keys(net.knownTokens[8453]!)).toEqual(["ETH", "USDC", "USDT"]);
    expect(Object.keys(net.knownTokens[56]!)).toEqual(["BNB", "USDC", "USDT"]);
  });

  it("throws on an unknown network name", () => {
    expect(() => getNetwork("unknown" as NetworkName)).toThrow(/unknown givro network/i);
  });

  it("intentQuoteUrlForPortal strips trailing slash", () => {
    expect(intentQuoteUrlForPortal("https://sandbox.example.com/")).toBe(
      "https://sandbox.example.com/api/intent/quote",
    );
  });

  it("lists every preset", () => {
    expect(Object.keys(NETWORKS)).toEqual(["devnet", "mainnet"]);
  });
});
