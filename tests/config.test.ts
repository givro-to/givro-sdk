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

  it("returns testnet config with Base Sepolia chainId", () => {
    const net = getNetwork("testnet");
    expect(net.name).toBe("testnet");
    expect(net.evmChainId).toBe(84532);
    expect(net.solanaCluster).toBeUndefined();
    expect(net.solanaProgramId).toBeUndefined();
  });

  it("testnet defaultQuoteUrl contains testnet.hfi.network", () => {
    const net = getNetwork("testnet");
    expect(net.defaultQuoteUrl).toContain("testnet.hfi.network");
  });

  it("returns the current Base + Tron mainnet-pilot config", () => {
    const net = getNetwork("mainnet");
    expect(net.name).toBe("mainnet");
    expect(net.evmChainId).toBe(8453);
    expect(net.tronChainId).toBe(728126428);
    expect(net.solanaCluster).toBeUndefined();
    expect(net.solanaProgramId).toBeUndefined();
  });

  it("mainnet defaultQuoteUrl contains hfi.network", () => {
    const net = getNetwork("mainnet");
    expect(net.defaultQuoteUrl).toContain("hfi.network");
  });

  it("throws on an unknown network name", () => {
    expect(() => getNetwork("unknown" as NetworkName)).toThrow(/unknown hfi pay network/i);
  });

  it("does not advertise Solana in the mainnet preset before launch review", () => {
    expect(NETWORKS.mainnet.solanaProgramId).toBeUndefined();
    expect(NETWORKS.mainnet.solanaDepositProgramId).toBeUndefined();
  });

  it("intentQuoteUrlForPortal strips trailing slash", () => {
    expect(intentQuoteUrlForPortal("https://testnet.hfi.network/")).toBe(
      "https://testnet.hfi.network/api/intent/quote",
    );
  });
});
