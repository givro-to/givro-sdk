import { describe, it, expect } from "vitest";
import { getNetwork, NETWORKS, intentQuoteUrlForPortal } from "../src/config.js";
import type { NetworkName } from "../src/config.js";

describe("getNetwork", () => {
  it("returns devnet config with correct evmChainId", () => {
    const net = getNetwork("devnet");
    expect(net.name).toBe("devnet");
    expect(net.evmChainId).toBe(31337);
  });

  it("devnet defaultQuoteUrl points to localhost", () => {
    const net = getNetwork("devnet");
    expect(net.defaultQuoteUrl).toContain("localhost");
  });

  it("returns the current Base + Tron mainnet-pilot config", () => {
    const net = getNetwork("mainnet");
    expect(net.name).toBe("mainnet");
    expect(net.evmChainId).toBe(8453);
    expect(net.tronChainId).toBe(728126428);
    expect(net.solanaCluster).toBeUndefined();
    expect(net.solanaProgramId).toBeUndefined();
  });

  it("mainnet defaultQuoteUrl contains givro.to", () => {
    const net = getNetwork("mainnet");
    expect(net.defaultQuoteUrl).toContain("givro.to");
  });

  it("throws on an unknown network name", () => {
    expect(() => getNetwork("unknown" as NetworkName)).toThrow(/unknown givro network/i);
  });

  it("does not advertise Solana in the mainnet preset before launch review", () => {
    expect(NETWORKS.mainnet.solanaProgramId).toBeUndefined();
    expect(NETWORKS.mainnet.solanaDepositProgramId).toBeUndefined();
  });

  it("intentQuoteUrlForPortal strips trailing slash", () => {
    expect(intentQuoteUrlForPortal("https://sandbox.example.com/")).toBe(
      "https://sandbox.example.com/api/intent/quote",
    );
  });
});
