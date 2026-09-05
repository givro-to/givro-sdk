/** Network presets for Givro deployments. */

// Sandbox/test runs against the mainnet portal with a gvr_test_ API key
// (the key drives simulated settlement); there is no separate testnet portal,
// so the only network targets are local dev and production.
export type NetworkName = "devnet" | "mainnet";

export interface GivroPayNetwork {
  name: NetworkName;
  /** EVM chain IDs this deployment serves. */
  evmChainIds: readonly number[];
  /** Tron chain ID served by this deployment, when Tron is enabled. */
  tronChainId?: number;
  /** Default portal base URL (can be overridden per-client) */
  portalBaseUrl: string;
  /** Default quote service URL (can be overridden per-client) */
  defaultQuoteUrl: string;
  /**
   * Example asset registry, keyed by EVM chain ID. Values are `0x` addresses.
   * Applications must resolve non-native symbols through a reviewed registry
   * before calling `quoteSend`.
   */
  knownTokens: Readonly<Record<number, Readonly<Record<string, string>>>>;
  /** Example Tron asset registry for this deployment. */
  knownTronTokens?: Readonly<Record<string, string>>;
}

const NATIVE = "0x0000000000000000000000000000000000000000";

export const NETWORKS: Record<NetworkName, GivroPayNetwork> = {
  devnet: {
    name: "devnet",
    evmChainIds: [31338],
    tronChainId: 3448148188,
    portalBaseUrl: "http://localhost:3100",
    defaultQuoteUrl: "http://localhost:3100/api/intent/quote",
    knownTokens: {
      31338: { ETH: NATIVE, GO: NATIVE },
    },
    knownTronTokens: { TRX: "native" },
  },
  mainnet: {
    name: "mainnet",
    evmChainIds: [8453, 56],
    tronChainId: 728126428,
    portalBaseUrl: "https://givro.to",
    defaultQuoteUrl: "https://givro.to/api/intent/quote",
    knownTokens: {
      8453: {
        ETH: NATIVE,
        USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        USDT: "0xfde4C96c8593536e31f229ea8f37b2ada2699bb2",
      },
      56: {
        BNB: NATIVE,
        USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        USDT: "0x55d398326f99059fF775485246999027B3197955",
      },
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

/** `POST /api/intent/quote` for the given portal deployment. */
export function intentQuoteUrlForPortal(portalBaseUrl: string): string {
  return `${portalBaseUrl.replace(/\/$/, "")}/api/intent/quote`;
}
