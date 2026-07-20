import type { PaymentQuote } from "../types.js";
import { GIVRO_PAY_ATTESTED_V1_ABI } from "../evm/abi.js";
import { GivroPayBuildTxError } from "../errors.js";

/** Relay address meaning “no relay” — same as EVM `address(0)`; TronWeb accepts hex. */
export const TRON_ATTESTED_ZERO_RELAY = "0x0000000000000000000000000000000000000000" as const;

export { GIVRO_PAY_ATTESTED_V1_ABI as GIVRO_PAY_ATTESTED_ABI_TRON };

/**
 * Order tuple for `depositNativeWithOrder` / `depositErc20WithOrder` on Tron `HfiPayAttested`
 * (Solidity names are historical; Tron uses the same ABI).
 */
export interface TronAttestedOrderTuple {
  chainId: number | string;
  paymentRef: string;
  idHash: string;
  token: string;
  amount: string;
  cancelBefore: number | string;
  claimBefore: number | string;
  refundAfter: number | string;
}

export function assertTronAttestedQuote(
  quote: PaymentQuote,
): asserts quote is PaymentQuote & {
  attestedContract: string;
  attestedOrder: NonNullable<PaymentQuote["attestedOrder"]>;
} {
  if (quote.ecosystem !== "tron") {
    throw new GivroPayBuildTxError("Tron quote ecosystem must be tron");
  }
  if (!quote.attestedContract || !quote.attestedOrder) {
    throw new GivroPayBuildTxError("Tron quote is missing attestedContract or attestedOrder");
  }
  const o = quote.attestedOrder;
  if (!o.paymentRef || !o.idHash || !o.token || o.amount == null) {
    throw new GivroPayBuildTxError("Tron quote has an incomplete attestedOrder");
  }
}

/** Build the order struct TronWeb passes into `depositErc20WithOrder` / `depositNativeWithOrder`. */
export function tronAttestedOrderTupleFromQuote(quote: PaymentQuote): TronAttestedOrderTuple {
  assertTronAttestedQuote(quote);
  const o = quote.attestedOrder;
  const token = o.token.toLowerCase() === "native" ? TRON_ATTESTED_ZERO_RELAY : o.token;
  return {
    chainId: o.chainId.toString(),
    paymentRef: o.paymentRef,
    idHash: o.idHash,
    token,
    amount: o.amount.toString(),
    cancelBefore: o.cancelBefore.toString(),
    claimBefore: o.claimBefore.toString(),
    refundAfter: o.refundAfter.toString(),
  };
}
