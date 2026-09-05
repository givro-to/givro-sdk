import { GivroPayBuildTxError } from "../errors.js";
import type { PaymentQuote } from "../types.js";
import { GIVRO_PAY_ESCROW_ABI, ZERO_ADDRESS } from "../evm/escrow.js";

/**
 * The Tron escrow runs the same bytecode as the EVM escrow, so it shares the
 * ABI. TronWeb's `contract(abi, address)` takes the address in base58 and
 * accepts base58 or `41…` hex wherever the ABI expects an `address`.
 */
export { GIVRO_PAY_ESCROW_ABI as GIVRO_PAY_ESCROW_ABI_TRON };

/** The order struct TronWeb passes into `depositNativeWithOrder` / `depositErc20WithOrder`. */
export interface TronEscrowOrderTuple {
  chainId: string;
  paymentRef: string;
  intentId: string;
  blindedBinding: string;
  bindingEpoch: string;
  claimAuthorization: 0 | 1;
  /** Zero address for TRX; otherwise the TRC20 contract as the portal returned it (base58). */
  token: string;
  amount: string;
  cancelBefore: string;
  claimBefore: string;
  refundAfter: string;
}

export interface TronDepositCall {
  /** Escrow as `0x` hex; convert with `tronWeb.address.fromHex("41" + escrow.slice(2))`. */
  escrow: `0x${string}`;
  functionName: "depositNativeWithOrder" | "depositErc20WithOrder";
  order: TronEscrowOrderTuple;
  mandateCommit: `0x${string}`;
  /** `callValue` for the native deposit; `"0"` for a TRC20 deposit. */
  callValue: string;
}

/** Build the escrow call a Tron wallet signs for `quote`. */
export function tronDepositCallFromQuote(quote: PaymentQuote): TronDepositCall {
  if (quote.ecosystem !== "tron") {
    throw new GivroPayBuildTxError("Tron quote ecosystem must be tron");
  }
  const o = quote.order;
  const native = o.token.toLowerCase() === "native";
  return {
    escrow: quote.attestedContract,
    functionName: native ? "depositNativeWithOrder" : "depositErc20WithOrder",
    order: {
      chainId: o.chainId.toString(),
      paymentRef: o.paymentRef,
      intentId: o.intentId,
      blindedBinding: o.blindedBinding,
      bindingEpoch: o.bindingEpoch.toString(),
      claimAuthorization: o.claimAuthorization,
      token: native ? ZERO_ADDRESS : o.token,
      amount: o.amount.toString(),
      cancelBefore: o.cancelBefore.toString(),
      claimBefore: o.claimBefore.toString(),
      refundAfter: o.refundAfter.toString(),
    },
    mandateCommit: quote.mandateCommit,
    callValue: native ? o.amount.toString() : "0",
  };
}
