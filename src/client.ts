import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { Address } from "viem";
import { normalizeRecipient, type RecipientKind } from "./identifier.js";
import { fetchPaymentQuote } from "./quote.js";
import { DEFAULT_HFI_PAY_PROGRAM_ID } from "./solana/constants.js";
import { paymentRefHexToBytes } from "./solana/utils.js";
import {
  buildSolanaAttestedDepositTransaction,
} from "./solana/prepareSolanaDeposit.js";
import type { ChainVm, HfiPayClientConfig, PaymentQuote, QuoteRequestBody } from "./types.js";
import { tronAttestedOrderTupleFromQuote } from "./tron/prepareTronAttestedDeposit.js";
import {
  buildEvmApproveRequest,
  buildEvmAttestedDepositRequest,
  isNativeEvmToken,
} from "./evm/prepareEvmDeposit.js";

/** Derive the portal base URL from the quote URL when not explicitly configured. */
function derivePortalBaseUrl(config: HfiPayClientConfig): string {
  if (config.portalBaseUrl) return config.portalBaseUrl.replace(/\/$/, "");
  try {
    const u = new URL(config.quoteUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

export class HfiPayClient {
  constructor(private readonly config: HfiPayClientConfig) {}

  private assertAttestedOrderComplete(q: PaymentQuote): asserts q is PaymentQuote & {
    attestedContract: Address;
    attestedOrder: NonNullable<PaymentQuote["attestedOrder"]>;
  } {
    if (!q.attestedContract || !q.attestedOrder) {
      throw new Error("attested quote missing attestedContract/attestedOrder");
    }
    const o = q.attestedOrder;
    if (!o.paymentRef || !o.idHash || !o.token) {
      throw new Error("attested quote missing order.paymentRef/idHash/token");
    }
    if (q.token.toLowerCase() !== o.token.toLowerCase()) {
      throw new Error("attested quote token mismatch: quote.token must match order.token");
    }
  }

  async fetchQuote(body: QuoteRequestBody): Promise<PaymentQuote> {
    // Normalize: `vm` takes precedence over `ecosystem`; both are forwarded.
    const normalized: QuoteRequestBody = {
      ...body,
      ecosystem: (body.vm ?? body.ecosystem) as ChainVm,
    };
    const vm = normalized.vm ?? normalized.ecosystem;
    let quoteUrl = this.config.quoteUrl;
    if (vm === "tron") {
      if (this.config.intentQuoteUrl) {
        quoteUrl = this.config.intentQuoteUrl;
      } else {
        const base = derivePortalBaseUrl(this.config);
        if (!base) {
          throw new Error(
            "fetchQuote(tron): set portalBaseUrl or intentQuoteUrl in HfiPayClientConfig",
          );
        }
        quoteUrl = `${base}/api/intent/quote`;
      }
    }
    return fetchPaymentQuote(quoteUrl, normalized, {
      fetchImpl: this.config.fetchImpl,
      headers: this.config.defaultHeaders,
      timeoutMs: this.config.timeoutMs,
      retry: this.config.retry,
    });
  }

  /**
   * Full quote request from human input.
   *
   * @param params.vm         Target chain VM: "evm" | "solana" | "tron".
   *                          Alias: `ecosystem` (deprecated, same effect).
   * @param params.chainId    EVM chain ID or Tron chain id, e.g. 31337 or 1.
   * @param params.token      Token address (0x…) or well-known symbol ("GO", "ETH", "USDC"); Tron TRC20 base58.
   * @param params.amount     Smallest-unit amount as a decimal string (wei / raw).
   *                          Use `toBaseUnits(humanAmount, decimals)` to convert first.
   * @param params.amountHuman Optional human amount for `POST /api/intent/quote` (Tron / Send page). Defaults to `amount`.
   * @param params.turnstile  Cloudflare token for browser quotes; omit for partner `X-API-Key` requests.
   * @param params.recipient  Recipient address in `recipientKind` format.
   * @param params.recipientKind "email" | "phone" | "x"
   */
  async quoteSend(params: {
    recipientKind: RecipientKind;
    recipient: string;
    amount: string;
    token: string;
    /** Preferred. Target VM / ecosystem. */
    vm?: ChainVm;
    /** Deprecated alias for `vm`. */
    ecosystem?: ChainVm;
    chainId?: number;
    cancelWindowSec?: number;
    /** Human-readable amount label for intent quote (e.g. Tron). */
    amountHuman?: string;
    turnstile?: string;
    senderXUid?: string;
    senderWalletAddr?: string;
    senderWalletEcosystem?: "evm" | "solana" | "tron";
  }): Promise<PaymentQuote> {
    const vm = (params.vm ?? params.ecosystem) as ChainVm | undefined;
    if (!vm) throw new Error("quoteSend: vm (or ecosystem) is required");
    const identifier = normalizeRecipient(params.recipientKind, params.recipient);
    return this.fetchQuote({
      identifier,
      identifierKind: params.recipientKind,
      amountWei: params.amount,
      amount: params.amountHuman ?? params.amount,
      token: params.token,
      vm,
      ecosystem: vm,
      chainId: params.chainId,
      cancelWindowSec: params.cancelWindowSec,
      turnstile: params.turnstile,
      senderXUid: params.senderXUid,
      senderWalletAddr: params.senderWalletAddr,
      senderWalletEcosystem: params.senderWalletEcosystem,
    });
  }

  /**
   * Tron: order tuple for `HfiPayAttested` `depositErc20WithOrder` / `depositNativeWithOrder` (TronWeb).
   */
  tronAttestedOrderTuple(quote: PaymentQuote): ReturnType<typeof tronAttestedOrderTupleFromQuote> {
    return tronAttestedOrderTupleFromQuote(quote);
  }

  /**
   * EVM: returns approve (ERC-20 only) + deposit txs for wagmi `sendTransaction` / WalletConnect.
   *
   * Requires attested fields (`attestedContract`, `attestedOrder`) and builds a
   * permissionless attested deposit (no portal signature required).
   */
  prepareEvmTransactions(params: {
    quote: PaymentQuote;
    depositContract?: Address;
    /** Relay node address to receive origin fee share. Omit for no relay. */
    originRelayAddress?: Address;
  }): { approve: ReturnType<typeof buildEvmApproveRequest> | null; deposit: ReturnType<typeof buildEvmAttestedDepositRequest> } {
    const q = params.quote;
    if (q.ecosystem !== "evm") throw new Error("quote ecosystem must be evm");
    const isAttested = Boolean(q.attestedContract && q.attestedOrder);

    if (isAttested) {
      this.assertAttestedOrderComplete(q);
      const attestedContract = q.attestedContract as Address;
      const o = q.attestedOrder;
      const orderToken = o.token as Address;
      const deposit = buildEvmAttestedDepositRequest({
        depositContract: attestedContract,
        order: { ...o, token: orderToken },
        originRelayAddress: params.originRelayAddress,
      });
      if (isNativeEvmToken(orderToken)) {
        return { approve: null, deposit };
      }
      const approve = buildEvmApproveRequest({
        token: orderToken,
        depositContract: attestedContract,
        amount: q.attestedOrder.amount,
      });
      return { approve, deposit };
    }

    throw new Error("attested EVM quote required: quote must include attestedContract and attestedOrder");
  }

  /**
   * Solana: build a versioned deposit transaction from a quote.
   *
   * Uses permissionless attested flow from `solanaOrder` (no portal signature).
   */
  async prepareSolanaTransaction(
    connection: Connection,
    params: {
      quote: PaymentQuote;
      payer: PublicKey;
      recentBlockhash?: string;
      /** Relay node pubkey for off-chain fee attribution. Omit for no relay. */
      originRelayAddress?: string;
    },
  ): Promise<import("@solana/web3.js").VersionedTransaction> {
    const q = params.quote;
    if (q.ecosystem !== "solana") throw new Error("quote ecosystem must be solana");

    const programId = new PublicKey(q.programId ?? DEFAULT_HFI_PAY_PROGRAM_ID);
    const { blockhash } =
      params.recentBlockhash != null
        ? { blockhash: params.recentBlockhash }
        : await connection.getLatestBlockhash("confirmed");

    if (q.solanaOrder) {
      return buildSolanaAttestedDepositTransaction(connection, {
        programId,
        payer: params.payer,
        order: {
          paymentRef: paymentRefHexToBytes(q.paymentRef),
          idHash: paymentRefHexToBytes(q.solanaOrder.idHash),
          mint: new PublicKey(q.token),
          amount: BigInt(q.amount),
          cancelBefore: BigInt(q.solanaOrder.cancelBefore),
          claimBefore: BigInt(q.solanaOrder.claimBefore),
          refundAfter: BigInt(q.solanaOrder.refundAfter),
        },
        originRelayAddress: params.originRelayAddress ? new PublicKey(params.originRelayAddress) : undefined,
        recentBlockhash: blockhash,
      });
    }

    throw new Error("prepareSolanaTransaction: solanaOrder missing from quote");
  }

}

export function createHfiPayClient(config: HfiPayClientConfig): HfiPayClient {
  return new HfiPayClient(config);
}
