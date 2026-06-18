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

  it("returns testnet config with Sepolia chainId", () => {
    const net = getNetwork("testnet");
    expect(net.name).toBe("testnet");
    expect(net.evmChainId).toBe(11155111);
  });

  it("testnet defaultQuoteUrl contains testnet.hfi.network", () => {
    const net = getNetwork("testnet");
    expect(net.defaultQuoteUrl).toContain("testnet.hfi.network");
  });

  it("returns mainnet config with chainId 1", () => {
    const net = getNetwork("mainnet");
    expect(net.name).toBe("mainnet");
    expect(net.evmChainId).toBe(1);
  });

  it("mainnet solanaCluster is mainnet-beta", () => {
    const net = getNetwork("mainnet");
    expect(net.solanaCluster).toBe("mainnet-beta");
  });

  it("mainnet defaultQuoteUrl contains hfi.network", () => {
    const net = getNetwork("mainnet");
    expect(net.defaultQuoteUrl).toContain("hfi.network");
  });

  it("throws on an unknown network name", () => {
    expect(() => getNetwork("unknown" as NetworkName)).toThrow(/unknown hfi pay network/i);
  });

  it("each network in NETWORKS has solanaProgramId set", () => {
    for (const name of Object.keys(NETWORKS) as NetworkName[]) {
      expect(NETWORKS[name].solanaProgramId).toBeTruthy();
      expect(NETWORKS[name].solanaDepositProgramId).toBeTruthy();
    }
  });

  it("intentQuoteUrlForPortal strips trailing slash", () => {
    expect(intentQuoteUrlForPortal("https://testnet.hfi.network/")).toBe(
      "https://testnet.hfi.network/api/intent/quote",
    );
  });
});
