import {
  GivroPayConfigError,
  GivroPayError,
  GivroPayNetworkError,
  GivroPayTimeoutError,
} from "./errors.js";

export type PublicNetworkProfile = "mainnet" | "testnet";

export interface PublicEvmAsset {
  symbol: string;
  address: string;
  decimals: number;
  native?: boolean;
}

export interface PublicSolanaAsset {
  symbol: string;
  /** Registry mint/marker only. The SDK ships no Solana funding path; the portal does not serve Solana. */
  mint: string;
  decimals: number;
  native?: boolean;
}

export interface PublicTronAsset {
  symbol: string;
  contract: string;
  decimals: number;
  native?: boolean;
}

export type PublicSupportedChain =
  | {
      ecosystem: "evm";
      chainId: number;
      network: string;
      label: string;
      attestedContract?: string;
      tokens: PublicEvmAsset[];
    }
  | {
      ecosystem: "solana";
      cluster: string;
      network: string;
      label: string;
      tokens: PublicSolanaAsset[];
    }
  | {
      ecosystem: "tron";
      chainId: number;
      network: string;
      label: string;
      attestedContract?: string;
      tokens: PublicTronAsset[];
    };

export interface PublicSupportedAssetsConfig {
  profile: PublicNetworkProfile;
  version: number;
  chains: PublicSupportedChain[];
}

export interface FetchPublicSupportedAssetsOptions {
  fetchImpl?: typeof fetch;
  headers?: HeadersInit;
  /** Request timeout in milliseconds. Default: 10 seconds. */
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertCommonAsset(value: unknown, addressField: "address" | "mint" | "contract"): void {
  if (!isRecord(value)) throw new GivroPayConfigError("asset entry must be an object");
  if (typeof value.symbol !== "string" || value.symbol.length === 0) {
    throw new GivroPayConfigError("asset symbol must be a non-empty string");
  }
  const address = value[addressField];
  if (typeof address !== "string" || address.length === 0) {
    throw new GivroPayConfigError(`asset ${addressField} must be a non-empty string`);
  }
  if (typeof value.decimals !== "number" || !Number.isInteger(value.decimals) || value.decimals < 0) {
    throw new GivroPayConfigError("asset decimals must be a non-negative integer");
  }
  if (value.native !== undefined && typeof value.native !== "boolean") {
    throw new GivroPayConfigError("asset native flag must be boolean when present");
  }
}

function assertSupportedChain(value: unknown): void {
  if (!isRecord(value)) throw new GivroPayConfigError("chain entry must be an object");
  if (typeof value.network !== "string" || typeof value.label !== "string") {
    throw new GivroPayConfigError("chain network and label must be strings");
  }
  if (!Array.isArray(value.tokens)) throw new GivroPayConfigError("chain tokens must be an array");
  const assertAttestedContract = () => {
    if (value.attestedContract === undefined) return;
    if (
      typeof value.attestedContract !== "string"
      || !/^0x[0-9a-fA-F]{40}$/.test(value.attestedContract)
      || /^0x0{40}$/.test(value.attestedContract)
    ) {
      throw new GivroPayConfigError("attestedContract must be a non-zero canonical 0x address");
    }
  };

  if (value.ecosystem === "evm") {
    if (typeof value.chainId !== "number" || !Number.isSafeInteger(value.chainId) || value.chainId <= 0) {
      throw new GivroPayConfigError("EVM chainId must be a positive integer");
    }
    assertAttestedContract();
    value.tokens.forEach((asset) => assertCommonAsset(asset, "address"));
    return;
  }
  if (value.ecosystem === "tron") {
    if (typeof value.chainId !== "number" || !Number.isSafeInteger(value.chainId) || value.chainId <= 0) {
      throw new GivroPayConfigError("Tron chainId must be a positive integer");
    }
    assertAttestedContract();
    value.tokens.forEach((asset) => assertCommonAsset(asset, "contract"));
    return;
  }
  if (value.ecosystem === "solana") {
    if (typeof value.cluster !== "string" || value.cluster.length === 0) {
      throw new GivroPayConfigError("Solana cluster must be a non-empty string");
    }
    value.tokens.forEach((asset) => assertCommonAsset(asset, "mint"));
    return;
  }
  throw new GivroPayConfigError("chain ecosystem must be evm, tron, or solana");
}

function coercePublicSupportedAssets(value: unknown): PublicSupportedAssetsConfig {
  if (!isRecord(value)) throw new GivroPayConfigError("response must be an object");
  if (value.profile !== "mainnet" && value.profile !== "testnet") {
    throw new GivroPayConfigError("profile must be mainnet or testnet");
  }
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0) {
    throw new GivroPayConfigError("version must be a non-negative integer");
  }
  if (!Array.isArray(value.chains)) throw new GivroPayConfigError("chains must be an array");
  value.chains.forEach(assertSupportedChain);
  return value as unknown as PublicSupportedAssetsConfig;
}

/**
 * Fetch the Portal's authoritative runtime chain/token/deployment discovery.
 *
 * Security boundary: `attestedContract` is the settlement escrow the portal
 * publishes for that chain. It is onboarding/build-time discovery material. Review it independently and pin the approved value in
 * `trustedAttestedContracts`. Never fetch this response next to each quote and
 * dynamically trust the same Portal's address, which would defeat independent
 * settlement-contract pinning.
 */
export async function fetchPublicSupportedAssets(
  portalBaseUrl: string,
  options: FetchPublicSupportedAssetsOptions = {},
): Promise<PublicSupportedAssetsConfig> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (!fetchFn) {
    throw new GivroPayError("NETWORK_ERROR", "fetch is not available; pass fetchImpl");
  }
  const url = `${portalBaseUrl.replace(/\/$/, "")}/api/public/supported-assets`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: options.headers,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new GivroPayTimeoutError(timeoutMs, { cause: err, code: "CONFIG_TIMEOUT" });
    }
    throw new GivroPayError("NETWORK_ERROR", "Givro public configuration request failed", { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new GivroPayNetworkError(response.status, responseBody, { code: "NETWORK_ERROR" });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new GivroPayConfigError("response is not valid JSON", { cause: err });
  }
  return coercePublicSupportedAssets(json);
}
