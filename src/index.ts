export { normalizeRecipient, normalizeEmail, type RecipientKind } from "./identifier.js";
export { toBaseUnits } from "./amount.js";
export {
  HfiPayError,
  HfiPayNetworkError,
  HfiPayQuoteError,
  HfiPayTimeoutError,
  HfiPayBuildTxError,
  type HfiPayErrorCode,
} from "./errors.js";
export {
  getNetwork,
  NETWORKS,
  intentQuoteUrlForPortal,
  type NetworkName,
  type HfiPayNetwork,
} from "./config.js";
export {
  fetchPaymentQuote,
  coercePaymentQuote,
  serializeQuoteRequestBody,
} from "./quote.js";
export type {
  ChainVm,
  PaymentQuote,
  RpcIntent,
  QuoteRequestBody,
  HfiPayClientConfig,
  PrepareEvmSendParams,
  PrepareSolanaSendParams,
  RetryOptions,
} from "./types.js";
export { HFI_PAY_DEPOSIT_ABI, HFI_PAY_ATTESTED_V1_ABI, HFI_PAY_FACTORY_ABI, ZERO_ADDRESS } from "./evm/abi.js";
export {
  HFI_PAY_DEPLOYMENT_DOMAIN,
  hfipayClaimDigestEvm,
} from "./evm/claimDigest.js";
export {
  buildEvmApproveRequest,
  buildEvmAttestedDepositRequest,
  buildEvmCancelRequest,
  buildEvmDepositRequest,
  buildEvmBindTx,
  buildEvmRevokePendingTx,
  buildEvmClaimTx,
  buildEvmRefundTx,
  isNativeEvmToken,
  type AttestedOrder,
  type BindingMessage,
  type EvmTxRequest,
} from "./evm/prepareEvmDeposit.js";
export {
  DEFAULT_HFI_PAY_PROGRAM_ID,
  DEPOSIT_NATIVE_DISCRIMINATOR,
  DEPOSIT_SPL_DISCRIMINATOR,
} from "./solana/constants.js";
export {
  vaultAuthorityPda,
  configPda,
  vaultAtaPda,
  vaultMetaPda,
  bindingPda,
  mintPolicyPda,
} from "./solana/pda.js";
export {
  hfipayClaimDigestSvmSpl,
  svmDestinationAuthBytes,
} from "./solana/claimDigest.js";
export { paymentRefHexToBytes } from "./solana/utils.js";
export {
  buildSolanaAttestedDepositTransaction,
  type AttestedSolanaOrder,
} from "./solana/prepareSolanaDeposit.js";
export { HfiPayClient, createHfiPayClient } from "./client.js";
export {
  TRON_ATTESTED_ZERO_RELAY,
  HFI_PAY_ATTESTED_ABI_TRON,
  assertTronAttestedQuote,
  tronAttestedOrderTupleFromQuote,
  type TronAttestedOrderTuple,
} from "./tron/prepareTronAttestedDeposit.js";
export {
  toWagmiSendParams,
  toWagmiSendSequence,
  toWagmiWaitParams,
  type WagmiSendParams,
  type WagmiWaitParams,
} from "./evm/wagmiAdapter.js";
export {
  signAndSendSolanaAttestedDeposit,
  waitForSolanaConfirmation,
  type SolanaWalletLike,
  type SolanaDepositResult,
} from "./solana/walletAdapter.js";
