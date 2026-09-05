import type { Address } from "viem";
import {
  buildEvmErc20Deposit,
  buildEvmNativeDeposit,
  isNativeEvmToken,
  type EvmTxRequest,
} from "./evm/escrow.js";
import { GivroPayBuildTxError, GivroPayQuoteError } from "./errors.js";
import { normalizeRecipient, type RecipientKind } from "./identifier.js";
import { canonicalQuoteToken, fetchPaymentQuote } from "./quote.js";
import { tronDepositCallFromQuote, type TronDepositCall } from "./tron/deposit.js";
import type { ChainVm, GivroPayClientConfig, PaymentQuote, QuoteRequestBody } from "./types.js";

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

function isCanonicalNonZeroHexAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/i.test(address);
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

  /**
   * The escrow named by the quote must be one the integrator pinned for that
   * chain. The same pin covers EVM and Tron: both put the settlement contract
   * in `attestedContract` as a canonical `0x` address.
   */
  private assertTrustedAttestedContract(q: PaymentQuote): void {
    const key = `${q.ecosystem}:${q.chainId}`;
    const trusted = this.config.trustedAttestedContracts?.[key] ?? [];
    const quoted = q.attestedContract;
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

  private assertQuoteMatchesRequest(q: PaymentQuote, request: QuoteRequestBody): void {
    const vm = (request.vm ?? request.ecosystem) as ChainVm | undefined;
    if (!vm || q.ecosystem !== vm) throw new GivroPayQuoteError("ecosystem does not match request");
    if (request.chainId != null && q.chainId !== request.chainId) {
      throw new GivroPayQuoteError("chainId does not match request");
    }
    if (!this.tokensEqual(vm, request.token, q.order.token, q.chainId)) {
      throw new GivroPayQuoteError("token does not match request");
    }
    if (q.order.amount.toString() !== request.amountWei) {
      throw new GivroPayQuoteError("amount does not match request");
    }
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
   * @param params.vm         Target chain VM: "evm" | "tron". Alias: `ecosystem`.
   * @param params.chainId    EVM or Tron chain ID.
   * @param params.token      Token contract address, or a native symbol such as ETH/BNB/TRX.
   * @param params.amount     Smallest-unit amount as a decimal string (wei / sun / raw).
   *                          Use `toBaseUnits(humanAmount, decimals)` to convert first.
   * @param params.amountHuman Optional human amount for `POST /api/intent/quote`. Defaults to `amount`.
   * @param params.turnstile  Fresh Cloudflare Turnstile token for consumer browser quotes.
   *                          Production consumer quote endpoints reject API-key authentication.
   * @param params.recipient  Recipient in `recipientKind` format.
   * @param params.recipientKind "email" | "x" | "givro_id" (phone is typed but not served).
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
    /** Human-readable amount label for the intent quote. */
    amountHuman?: string;
    turnstile?: string;
    /** @deprecated Current Portal derives the X sender from `X-X-Session`. */
    senderXUid?: string;
    senderWalletAddr?: string;
    senderWalletEcosystem?: ChainVm;
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
   * EVM: returns approve (ERC-20 only) + deposit txs for wagmi `sendTransaction` / WalletConnect.
   * The quote's escrow must be pinned in `trustedAttestedContracts`.
   */
  prepareEvmTransactions(params: { quote: PaymentQuote }): { approve: EvmTxRequest | null; deposit: EvmTxRequest } {
    const q = params.quote;
    if (q.ecosystem !== "evm") throw new GivroPayBuildTxError("quote ecosystem must be evm");
    this.assertTrustedAttestedContract(q);
    const escrow = q.attestedContract as Address;
    const order = { ...q.order, token: q.order.token as Address };
    if (isNativeEvmToken(order.token)) {
      return {
        approve: null,
        deposit: buildEvmNativeDeposit({ escrow, order, mandateCommit: q.mandateCommit }),
      };
    }
    return buildEvmErc20Deposit({ escrow, order, mandateCommit: q.mandateCommit });
  }

  /**
   * Tron: the escrow call a TronWeb wallet signs. The quote's escrow must be
   * pinned in `trustedAttestedContracts` under `tron:<chainId>`.
   */
  tronDepositCall(quote: PaymentQuote): TronDepositCall {
    if (quote.ecosystem !== "tron") throw new GivroPayBuildTxError("quote ecosystem must be tron");
    this.assertTrustedAttestedContract(quote);
    return tronDepositCallFromQuote(quote);
  }
}

export function createGivroPayClient(config: GivroPayClientConfig): GivroPayClient {
  return new GivroPayClient(config);
}
