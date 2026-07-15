import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { Address } from "viem";
import { normalizeRecipient, type RecipientKind } from "./identifier.js";
import { fetchPaymentQuote } from "./quote.js";
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

  private tokensEqual(vm: ChainVm, left: string, right: string): boolean {
    return vm === "evm" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  private requestTokenMatches(vm: ChainVm, requested: string, actual: string): boolean {
    if (this.tokensEqual(vm, requested, actual)) return true;
    const symbol = requested.toUpperCase();
    if (vm === "evm" && ["NATIVE", "ETH", "GO", "POL", "BNB", "AVAX"].includes(symbol)) {
      return isNativeEvmToken(actual as Address);
    }
    if (vm === "tron" && ["NATIVE", "TRX"].includes(symbol)) {
      return actual === "native" || actual === "0x0000000000000000000000000000000000000000";
    }
    if (vm === "solana" && ["NATIVE", "SOL"].includes(symbol)) {
      return actual === PublicKey.default.toBase58();
    }
    return false;
  }

  private assertTrustedAttestedContract(q: PaymentQuote): void {
    if (!q.attestedContract || q.chainId == null) {
      throw new Error("attested quote missing attestedContract/chainId");
    }
    const key = `${q.ecosystem}:${q.chainId}`;
    const trusted = this.config.trustedAttestedContracts?.[key] ?? [];
    const matches = trusted.some((address) =>
      q.ecosystem === "evm"
        ? address.toLowerCase() === q.attestedContract!.toLowerCase()
        : address === q.attestedContract,
    );
    if (!matches) {
      throw new Error(`attested quote contract is not trusted for ${key}`);
    }
  }

  private assertTrustedSolanaProgram(q: PaymentQuote, cluster: string): string {
    if (!q.programId) throw new Error("Solana quote missing programId");
    const trusted = this.config.trustedSolanaPrograms?.[cluster] ?? [];
    if (!trusted.includes(q.programId)) {
      throw new Error(`Solana quote program is not trusted for ${cluster}`);
    }
    return q.programId;
  }

  private assertSolanaOrderComplete(q: PaymentQuote): asserts q is PaymentQuote & {
    programId: string;
    solanaOrder: NonNullable<PaymentQuote["solanaOrder"]>;
  } {
    if (!q.solanaOrder || !q.programId) throw new Error("Solana quote missing programId/solanaOrder");
    if (!/^0x[0-9a-fA-F]{64}$/.test(q.solanaOrder.idHash)) throw new Error("Solana quote has invalid idHash");
    if (!/^\d+$/.test(q.amount) || BigInt(q.amount) <= 0n) throw new Error("Solana quote has invalid amount");
    if (![q.solanaOrder.cancelBefore, q.solanaOrder.claimBefore, q.solanaOrder.refundAfter].every((value) => /^\d+$/.test(value))) {
      throw new Error("Solana quote has invalid lifecycle windows");
    }
    const cancelBefore = BigInt(q.solanaOrder.cancelBefore);
    const claimBefore = BigInt(q.solanaOrder.claimBefore);
    const refundAfter = BigInt(q.solanaOrder.refundAfter);
    if (!(cancelBefore <= claimBefore && claimBefore < refundAfter)) {
      throw new Error("Solana quote has invalid lifecycle windows");
    }
  }

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
    if (!this.tokensEqual(q.ecosystem, q.token, o.token)) {
      throw new Error("attested quote token mismatch: quote.token must match order.token");
    }
    if (q.paymentRef.toLowerCase() !== o.paymentRef.toLowerCase()) {
      throw new Error("attested quote paymentRef mismatch");
    }
    if (q.chainId == null || BigInt(q.chainId) !== o.chainId) {
      throw new Error("attested quote chainId mismatch");
    }
    if (!/^\d+$/.test(q.amount) || BigInt(q.amount) !== o.amount) {
      throw new Error("attested quote amount mismatch");
    }
    if (!(o.cancelBefore <= o.claimBefore && o.claimBefore < o.refundAfter)) {
      throw new Error("attested quote has invalid lifecycle windows");
    }
  }

  private assertQuoteMatchesRequest(q: PaymentQuote, request: QuoteRequestBody): void {
    const vm = (request.vm ?? request.ecosystem) as ChainVm | undefined;
    if (!vm || q.ecosystem !== vm) throw new Error("quote ecosystem does not match request");
    if (request.chainId != null && q.chainId !== request.chainId) {
      throw new Error("quote chainId does not match request");
    }
    const actualToken = q.attestedOrder?.token ?? q.token;
    if (!this.requestTokenMatches(vm, request.token, actualToken)) {
      throw new Error("quote token does not match request");
    }
    const actualAmount = q.attestedOrder?.amount.toString() ?? q.amount;
    if (actualAmount !== request.amountWei) {
      throw new Error("quote amount does not match request");
    }
    if (q.attestedOrder) this.assertAttestedOrderComplete(q);
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
    const quote = await fetchPaymentQuote(quoteUrl, normalized, {
      fetchImpl: this.config.fetchImpl,
      headers: this.config.defaultHeaders,
      timeoutMs: this.config.timeoutMs,
      retry: this.config.retry,
    });
    this.assertQuoteMatchesRequest(quote, normalized);
    return quote;
  }

  /**
   * Full quote request from human input.
   *
   * @param params.vm         Target chain VM: "evm" | "solana" | "tron".
   *                          Alias: `ecosystem` (deprecated, same effect).
   * @param params.chainId    EVM chain ID or Tron chain id, e.g. 31337 or 1.
   * @param params.token      Token contract/mint address, or a native symbol such as ETH/TRX/SOL.
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
    this.assertAttestedOrderComplete(quote);
    this.assertTrustedAttestedContract(quote);
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
      this.assertTrustedAttestedContract(q);
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
      cluster: string;
      recentBlockhash?: string;
      /** Relay node pubkey for off-chain fee attribution. Omit for no relay. */
      originRelayAddress?: string;
    },
  ): Promise<import("@solana/web3.js").VersionedTransaction> {
    const q = params.quote;
    if (q.ecosystem !== "solana") throw new Error("quote ecosystem must be solana");

    this.assertSolanaOrderComplete(q);
    const programId = new PublicKey(this.assertTrustedSolanaProgram(q, params.cluster));
    const { blockhash } =
      params.recentBlockhash != null
        ? { blockhash: params.recentBlockhash }
        : await connection.getLatestBlockhash("confirmed");

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

}

export function createHfiPayClient(config: HfiPayClientConfig): HfiPayClient {
  return new HfiPayClient(config);
}
