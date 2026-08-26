// One entry point that routes a quote to the builder its escrow generation
// actually needs.
//
// Integrators should call this rather than picking a builder themselves. The
// two rails share a quote shape but no deposit selector, and the failure mode
// of guessing wrong is quiet: a v2 quote's `attestedContract` is a real,
// non-zero, correctly-checksummed address, so a v1 builder accepts it and
// produces calldata that only reverts once broadcast.
import { GivroPayBuildTxError } from "../errors.js";
import type { PaymentQuote } from "../types.js";
import { buildEvmAttestedDepositRequest, type EvmTxRequest } from "./prepareEvmDeposit.js";
import {
  buildIntentBlindedErc20Deposit,
  buildIntentBlindedNativeDeposit,
  isNativeEvmToken,
  type IntentBlindedOrder,
} from "./prepareIntentBlindedDeposit.js";
import type { Address } from "viem";

export type EvmDepositPlan =
  | { protocolVersion: 1; steps: [EvmTxRequest] }
  /** v2 ERC-20 needs an approve first; both steps must be broadcast in order. */
  | { protocolVersion: 2; steps: [EvmTxRequest] | [EvmTxRequest, EvmTxRequest] };

/**
 * Build the deposit for `quote`, whichever rail it is on.
 *
 * @param escrow The escrow address pinned at onboarding. Required for v2 and
 *   checked against the quote: this is the one place an integrator can catch a
 *   portal that hands out an escrow they never reviewed, so it is not optional.
 */
export function buildEvmDepositFromQuote(params: {
  quote: PaymentQuote;
  pinnedEscrow?: Address;
  /** v1 only: relay node address to receive the origin fee share. */
  originRelayAddress?: Address;
}): EvmDepositPlan {
  const { quote } = params;
  if (quote.ecosystem !== "evm") {
    throw new GivroPayBuildTxError(`quote ecosystem is ${quote.ecosystem}, not evm`);
  }

  if (quote.protocolVersion === 1) {
    if (!quote.depositContract || !quote.attestedOrder) {
      throw new GivroPayBuildTxError("v1 quote is missing depositContract or attestedOrder");
    }
    return {
      protocolVersion: 1,
      steps: [
        buildEvmAttestedDepositRequest({
          depositContract: quote.depositContract,
          order: { ...quote.attestedOrder, token: quote.attestedOrder.token as Address },
          originRelayAddress: params.originRelayAddress,
        }),
      ],
    };
  }

  const material = quote.intentBlinded;
  if (!material) throw new GivroPayBuildTxError("v2 quote carries no intentBlinded material");
  if (!params.pinnedEscrow) {
    throw new GivroPayBuildTxError(
      "pinnedEscrow is required for a v2 quote: pin the escrow at onboarding and pass it here",
    );
  }
  if (material.escrow.toLowerCase() !== params.pinnedEscrow.toLowerCase()) {
    throw new GivroPayBuildTxError(
      `quote escrow ${material.escrow} does not match the pinned escrow ${params.pinnedEscrow}`,
    );
  }

  const order: IntentBlindedOrder = {
    ...material.order,
    token: material.order.token as Address,
  };
  const escrow = params.pinnedEscrow;

  if (isNativeEvmToken(order.token)) {
    return {
      protocolVersion: 2,
      steps: [buildIntentBlindedNativeDeposit({ escrow, order, mandateCommit: material.mandateCommit })],
    };
  }
  const { approve, deposit } = buildIntentBlindedErc20Deposit({
    escrow,
    order,
    mandateCommit: material.mandateCommit,
  });
  return { protocolVersion: 2, steps: [approve, deposit] };
}
