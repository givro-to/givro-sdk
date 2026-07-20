/** Network presets for Givro deployments. */

// Sandbox/test runs against the mainnet portal with a gvr_test_ API key
// (the key drives simulated settlement); there is no separate testnet portal,
// so the only network targets are local dev and production.
export type NetworkName = "devnet" | "mainnet";

export interface GivroPayNetwork {
  name: NetworkName;
  /** EVM chain ID for this deployment */
  evmChainId: number;
  /** Optional Solana development cluster. Absence means the preset does not advertise Solana. */
  solanaCluster?: "devnet" | "testnet" | "mainnet-beta";
  /** Optional reviewed hfi-pay Solana program ID for this preset. */
  solanaProgramId?: string;
  /** Optional hfi-pay-deposit Solana program ID for legacy development paths. */
  solanaDepositProgramId?: string;
  /** Optional Tron chain ID enabled by this deployment. */
  tronChainId?: number;
  /** Default portal base URL (can be overridden per-client) */
  portalBaseUrl: string;
  /** Default quote service URL (can be overridden per-client) */
  defaultQuoteUrl: string;
  /**
   * Example asset registry for this network. Values are EVM `0x` addresses.
   * Applications must resolve non-native symbols through a reviewed registry
   * before calling `quoteSend`.
   */
  knownTokens: Record<string, string>;
  /** Example Tron asset registry for this deployment. */
  knownTronTokens?: Record<string, string>;
}

export const NETWORKS: Record<NetworkName, GivroPayNetwork> = {
  devnet: {
    name: "devnet",
    evmChainId: 31337,
    solanaCluster: "devnet",
    solanaProgramId: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
    solanaDepositProgramId: "B8sLQ5g6ABbZyyuyx9hia4kFv8nMo4wCqWXcLcR9XpJZ",
    portalBaseUrl: "http://localhost:3100",
    defaultQuoteUrl: "http://localhost:3100/api/intent/quote",
    knownTokens: {
      GO: "0x0000000000000000000000000000000000000000",
      ETH: "0x0000000000000000000000000000000000000000",
    },
  },
  mainnet: {
    name: "mainnet",
    evmChainId: 8453,
    tronChainId: 728126428,
    portalBaseUrl: "https://givro.to",
    defaultQuoteUrl: "https://givro.to/api/intent/quote",
    knownTokens: {
      ETH: "0x0000000000000000000000000000000000000000",
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      USDT: "0xfde4C96c8593536e31f229ea8f37b2ada2699bb2",
    },
    knownTronTokens: {
      TRX: "native",
      USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    },
  },
};

/** Return a network config by name, or throw if unknown. */
export function getNetwork(name: NetworkName): GivroPayNetwork {
  const n = NETWORKS[name];
  if (!n) throw new Error(`Unknown Givro network: ${name}`);
  return n;
}

/** `POST /api/intent/quote` for the given portal deployment (Send page / Tron). */
export function intentQuoteUrlForPortal(portalBaseUrl: string): string {
  return `${portalBaseUrl.replace(/\/$/, "")}/api/intent/quote`;
}
