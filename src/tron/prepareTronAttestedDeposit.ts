import type { PaymentQuote } from "../types.js";
import { HFI_PAY_ATTESTED_V1_ABI } from "../evm/abi.js";

/** Relay address meaning “no relay” — same as EVM `address(0)`; TronWeb accepts hex. */
export const TRON_ATTESTED_ZERO_RELAY = "0x0000000000000000000000000000000000000000" as const;

export { HFI_PAY_ATTESTED_V1_ABI as HFI_PAY_ATTESTED_ABI_TRON };

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
    throw new Error("assertTronAttestedQuote: quote ecosystem must be tron");
  }
  if (!quote.attestedContract || !quote.attestedOrder) {
    throw new Error("assertTronAttestedQuote: missing attestedContract or attestedOrder");
  }
  const o = quote.attestedOrder;
  if (!o.paymentRef || !o.idHash || !o.token || o.amount == null) {
    throw new Error("assertTronAttestedQuote: incomplete attestedOrder");
  }
}

/** Build the order struct TronWeb passes into `depositErc20WithOrder` / `depositNativeWithOrder`. */
export function tronAttestedOrderTupleFromQuote(quote: PaymentQuote): TronAttestedOrderTuple {
  assertTronAttestedQuote(quote);
  const o = quote.attestedOrder;
  return {
    chainId: o.chainId.toString(),
    paymentRef: o.paymentRef,
    idHash: o.idHash,
    token: o.token,
    amount: o.amount.toString(),
    cancelBefore: o.cancelBefore.toString(),
    claimBefore: o.claimBefore.toString(),
    refundAfter: o.refundAfter.toString(),
  };
}
