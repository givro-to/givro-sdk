import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { Address } from "viem";
import { GivroPayBuildTxError, GivroPayQuoteError } from "./errors.js";
import { normalizeRecipient, type RecipientKind } from "./identifier.js";
import { canonicalQuoteToken, fetchPaymentQuote } from "./quote.js";
import { paymentRefHexToBytes } from "./solana/utils.js";
import {
  buildSolanaAttestedDepositTransaction,
} from "./solana/prepareSolanaDeposit.js";
import type { ChainVm, GivroPayClientConfig, PaymentQuote, QuoteRequestBody } from "./types.js";
import { tronAttestedOrderTupleFromQuote } from "./tron/prepareTronAttestedDeposit.js";
import {
  buildEvmApproveRequest,
  buildEvmAttestedDepositRequest,
  isNativeEvmToken,
} from "./evm/prepareEvmDeposit.js";

/** Derive the portal base URL from the quote URL when not explicitly configured. */
function derivePortalBaseUrl(config: GivroPayClientConfig): string {
  if (config.portalBaseUrl) return config.portalBaseUrl.replace(/\/$/, "");
  try {
    const u = new URL(config.quoteUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

export class GivroPayClient {
  constructor(private readonly config: GivroPayClientConfig) {}

  private tokensEqual(vm: ChainVm, left: string, right: string, chainId?: number): boolean {
    const canonicalLeft = canonicalQuoteToken(vm, left, chainId);
    const canonicalRight = canonicalQuoteToken(vm, right, chainId);
    return vm === "evm"
      ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
      : canonicalLeft === canonicalRight;
  }

  private requestTokenMatches(vm: ChainVm, requested: string, actual: string, chainId?: number): boolean {
    return this.tokensEqual(vm, requested, actual, chainId);
  }

  private assertTrustedAttestedContract(q: PaymentQuote): void {
    if (!q.attestedContract || q.chainId == null) {
      throw new GivroPayQuoteError("missing attestedContract/chainId");
    }
    const key = `${q.ecosystem}:${q.chainId}`;
    const trusted = this.config.trustedAttestedContracts?.[key] ?? [];
    const quoted = q.attestedContract;
    const isCanonicalNonZeroHexAddress = (address: string) => (
      /^0x[0-9a-fA-F]{40}$/.test(address)
      && !/^0x0{40}$/i.test(address)
    );
    if (!isCanonicalNonZeroHexAddress(quoted)) {
      throw new GivroPayQuoteError(`attested contract is not a canonical non-zero address for ${key}`);
    }
    const matches = trusted.some((address) => (
      isCanonicalNonZeroHexAddress(address)
      && address.toLowerCase() === quoted.toLowerCase()
    ));
    if (!matches) {
      throw new GivroPayQuoteError(`attested contract is not trusted for ${key}`);
    }
  }

  private assertTrustedSolanaProgram(q: PaymentQuote, cluster: string): string {
    if (!q.programId) throw new GivroPayQuoteError("Solana quote missing programId");
    const trusted = this.config.trustedSolanaPrograms?.[cluster] ?? [];
    if (!trusted.includes(q.programId)) {
      throw new GivroPayQuoteError(`Solana program is not trusted for ${cluster}`);
    }
    return q.programId;
  }

  private assertSolanaOrderComplete(q: PaymentQuote): asserts q is PaymentQuote & {
    programId: string;
    solanaOrder: NonNullable<PaymentQuote["solanaOrder"]>;
  } {
    if (!q.solanaOrder || !q.programId) throw new GivroPayQuoteError("Solana quote missing programId/solanaOrder");
    if (!/^0x[0-9a-fA-F]{64}$/.test(q.solanaOrder.idHash)) throw new GivroPayQuoteError("Solana quote has invalid idHash");
    if (!/^\d+$/.test(q.amount) || BigInt(q.amount) <= 0n) throw new GivroPayQuoteError("Solana quote has invalid amount");
    if (![q.solanaOrder.cancelBefore, q.solanaOrder.claimBefore, q.solanaOrder.refundAfter].every((value) => /^\d+$/.test(value))) {
      throw new GivroPayQuoteError("Solana quote has invalid lifecycle windows");
    }
    const cancelBefore = BigInt(q.solanaOrder.cancelBefore);
    const claimBefore = BigInt(q.solanaOrder.claimBefore);
    const refundAfter = BigInt(q.solanaOrder.refundAfter);
    if (!(cancelBefore <= claimBefore && claimBefore < refundAfter)) {
      throw new GivroPayQuoteError("Solana quote has invalid lifecycle windows");
    }
  }

  private assertAttestedOrderComplete(q: PaymentQuote): asserts q is PaymentQuote & {
    attestedContract: Address;
    attestedOrder: NonNullable<PaymentQuote["attestedOrder"]>;
  } {
    if (!q.attestedContract || !q.attestedOrder) {
      throw new GivroPayQuoteError("missing attestedContract/attestedOrder");
    }
    const o = q.attestedOrder;
    if (!o.paymentRef || !o.idHash || !o.token) {
      throw new GivroPayQuoteError("attested quote missing order.paymentRef/idHash/token");
    }
    if (!this.tokensEqual(q.ecosystem, q.token, o.token, q.chainId)) {
      throw new GivroPayQuoteError("attested quote token mismatch: quote.token must match order.token");
    }
    if (q.paymentRef.toLowerCase() !== o.paymentRef.toLowerCase()) {
      throw new GivroPayQuoteError("attested quote paymentRef mismatch");
    }
    if (q.chainId == null || BigInt(q.chainId) !== o.chainId) {
      throw new GivroPayQuoteError("attested quote chainId mismatch");
    }
    if (!/^\d+$/.test(q.amount) || BigInt(q.amount) !== o.amount) {
      throw new GivroPayQuoteError("attested quote amount mismatch");
    }
    if (!(o.cancelBefore <= o.claimBefore && o.claimBefore < o.refundAfter)) {
      throw new GivroPayQuoteError("attested quote has invalid lifecycle windows");
    }
  }

  private assertQuoteMatchesRequest(q: PaymentQuote, request: QuoteRequestBody): void {
    const vm = (request.vm ?? request.ecosystem) as ChainVm | undefined;
    if (!vm || q.ecosystem !== vm) throw new GivroPayQuoteError("ecosystem does not match request");
    if (request.chainId != null && q.chainId !== request.chainId) {
      throw new GivroPayQuoteError("chainId does not match request");
    }
    const actualToken = q.attestedOrder?.token ?? q.token;
    if (!this.requestTokenMatches(vm, request.token, actualToken, q.chainId ?? request.chainId)) {
      throw new GivroPayQuoteError("token does not match request");
    }
    const actualAmount = q.attestedOrder?.amount.toString() ?? q.amount;
    if (actualAmount !== request.amountWei) {
      throw new GivroPayQuoteError("amount does not match request");
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
    if (!vm) throw new GivroPayQuoteError("fetchQuote: vm (or ecosystem) is required");
    normalized.token = canonicalQuoteToken(vm, normalized.token, normalized.chainId);
    let quoteUrl = this.config.quoteUrl;
    if (vm === "tron") {
      if (this.config.intentQuoteUrl) {
        quoteUrl = this.config.intentQuoteUrl;
      } else {
        const base = derivePortalBaseUrl(this.config);
        if (!base) {
          throw new GivroPayQuoteError(
            "fetchQuote(tron): set portalBaseUrl or intentQuoteUrl in GivroPayClientConfig",
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
   * @param params.chainId    EVM or Tron chain ID.
   * @param params.token      Token contract/mint address, or a native symbol such as ETH/TRX/SOL.
   * @param params.amount     Smallest-unit amount as a decimal string (wei / raw).
   *                          Use `toBaseUnits(humanAmount, decimals)` to convert first.
   * @param params.amountHuman Optional human amount for `POST /api/intent/quote` (Tron / Send page). Defaults to `amount`.
   * @param params.turnstile  Fresh Cloudflare Turnstile token for consumer browser quotes.
   *                          Production consumer quote endpoints reject API-key authentication.
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
    /** @deprecated Current Portal derives the X sender from `X-X-Session`. */
    senderXUid?: string;
    senderWalletAddr?: string;
    senderWalletEcosystem?: "evm" | "solana" | "tron";
  }): Promise<PaymentQuote> {
    const vm = (params.vm ?? params.ecosystem) as ChainVm | undefined;
    if (!vm) throw new GivroPayQuoteError("quoteSend: vm (or ecosystem) is required");
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
    if (q.ecosystem !== "evm") throw new GivroPayBuildTxError("quote ecosystem must be evm");
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

    throw new GivroPayBuildTxError("attested EVM quote required: quote must include attestedContract and attestedOrder");
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
    if (q.ecosystem !== "solana") throw new GivroPayBuildTxError("quote ecosystem must be solana");

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
        mint: q.token === "native" ? PublicKey.default : new PublicKey(q.token),
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

export function createGivroPayClient(config: GivroPayClientConfig): GivroPayClient {
  return new GivroPayClient(config);
}
