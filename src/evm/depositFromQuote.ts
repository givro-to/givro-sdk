import type { Address } from "viem";
import { GivroPayBuildTxError } from "../errors.js";
import type { PaymentQuote } from "../types.js";
import {
  buildEvmErc20Deposit,
  buildEvmNativeDeposit,
  isNativeEvmToken,
  type EvmEscrowOrder,
  type EvmTxRequest,
} from "./escrow.js";

/** ERC-20 needs an approve first; both steps must be broadcast in order. */
export type EvmDepositPlan = { steps: [EvmTxRequest] | [EvmTxRequest, EvmTxRequest] };

/**
 * Build the deposit for an EVM `quote`.
 *
 * @param pinnedEscrow The escrow address pinned at onboarding. Checked against
 *   the quote: this is the one place an integrator can catch a portal that
 *   hands out an escrow they never reviewed, so it is not optional.
 */
export function buildEvmDepositFromQuote(params: {
  quote: PaymentQuote;
  pinnedEscrow: Address;
}): EvmDepositPlan {
  const { quote } = params;
  if (quote.ecosystem !== "evm") {
    throw new GivroPayBuildTxError(`quote ecosystem is ${quote.ecosystem}, not evm`);
  }
  if (!params.pinnedEscrow) {
    throw new GivroPayBuildTxError("pinnedEscrow is required: pin the escrow at onboarding and pass it here");
  }
  if (quote.attestedContract.toLowerCase() !== params.pinnedEscrow.toLowerCase()) {
    throw new GivroPayBuildTxError(
      `quote escrow ${quote.attestedContract} does not match the pinned escrow ${params.pinnedEscrow}`,
    );
  }

  const order: EvmEscrowOrder = { ...quote.order, token: quote.order.token as Address };
  const escrow = params.pinnedEscrow;

  if (isNativeEvmToken(order.token)) {
    return { steps: [buildEvmNativeDeposit({ escrow, order, mandateCommit: quote.mandateCommit })] };
  }
  const { approve, deposit } = buildEvmErc20Deposit({ escrow, order, mandateCommit: quote.mandateCommit });
  return { steps: [approve, deposit] };
}
