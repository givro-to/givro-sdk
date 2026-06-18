/** Network presets for HFI Pay deployments. */

export type NetworkName = "devnet" | "testnet" | "mainnet";

export interface HfiPayNetwork {
  name: NetworkName;
  /** EVM chain ID for this deployment */
  evmChainId: number;
  /** Solana cluster string for @solana/web3.js clusterApiUrl() */
  solanaCluster: "devnet" | "testnet" | "mainnet-beta";
  /** Deployed hfi-pay Solana program ID */
  solanaProgramId: string;
  /** Deployed hfi-pay-deposit Solana program ID (legacy relay path) */
  solanaDepositProgramId: string;
  /** Default portal base URL (can be overridden per-client) */
  portalBaseUrl: string;
  /** Default quote service URL (can be overridden per-client) */
  defaultQuoteUrl: string;
  /**
   * Well-known token symbols for this network.
   * Values are EVM `0x` addresses.
   * Pass a symbol string to `quoteSend` and the server will resolve it.
   */
  knownTokens: Record<string, string>;
}

export const NETWORKS: Record<NetworkName, HfiPayNetwork> = {
  devnet: {
    name: "devnet",
    evmChainId: 31337,
    solanaCluster: "devnet",
    solanaProgramId: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
    solanaDepositProgramId: "8zsFkQmBTYQxWyeaGdrSjRtH8amuAnjtkqbLMMwowAJL",
    portalBaseUrl: "http://localhost:3100",
    defaultQuoteUrl: "http://localhost:3100/api/portal/v1/quote",
    knownTokens: {
      GO: "0x0000000000000000000000000000000000000000",
      ETH: "0x0000000000000000000000000000000000000000",
    },
  },
  testnet: {
    name: "testnet",
    evmChainId: 11155111, // Sepolia
    solanaCluster: "devnet",
    solanaProgramId: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
    solanaDepositProgramId: "8zsFkQmBTYQxWyeaGdrSjRtH8amuAnjtkqbLMMwowAJL",
    portalBaseUrl: "https://testnet.hfi.network",
    defaultQuoteUrl: "https://testnet.hfi.network/api/portal/v1/quote",
    knownTokens: {
      GO: "0x0000000000000000000000000000000000000000",
      ETH: "0x0000000000000000000000000000000000000000",
    },
  },
  mainnet: {
    name: "mainnet",
    evmChainId: 1,
    solanaCluster: "mainnet-beta",
    solanaProgramId: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
    solanaDepositProgramId: "8zsFkQmBTYQxWyeaGdrSjRtH8amuAnjtkqbLMMwowAJL",
    portalBaseUrl: "https://hfi.network",
    defaultQuoteUrl: "https://hfi.network/api/portal/v1/quote",
    knownTokens: {
      GO: "0x0000000000000000000000000000000000000000",
      ETH: "0x0000000000000000000000000000000000000000",
    },
  },
};

/** Return a network config by name, or throw if unknown. */
export function getNetwork(name: NetworkName): HfiPayNetwork {
  const n = NETWORKS[name];
  if (!n) throw new Error(`Unknown HFI Pay network: ${name}`);
  return n;
}

/** `POST /api/intent/quote` for the given portal deployment (Send page / Tron). */
export function intentQuoteUrlForPortal(portalBaseUrl: string): string {
  return `${portalBaseUrl.replace(/\/$/, "")}/api/intent/quote`;
}
