/** Typed error hierarchy for HFI Pay SDK. All errors are instanceof-checkable. */

export type HfiPayErrorCode =
  | "QUOTE_FETCH_FAILED"
  | "QUOTE_INVALID"
  | "QUOTE_TIMEOUT"
  | "BUILD_TX_FAILED"
  | "MISSING_DEPOSIT_CONTRACT"
  | "WRONG_ECOSYSTEM"
  | "INVALID_PAYMENT_REF"
  | "WALLET_NOT_CONNECTED"
  | "SIGN_FAILED"
  | "NETWORK_ERROR";

export class HfiPayError extends Error {
  readonly code: HfiPayErrorCode;

  constructor(code: HfiPayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HfiPayError";
    this.code = code;
  }
}

/** HTTP or network error when calling the quote service. */
export class HfiPayNetworkError extends HfiPayError {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string, options?: ErrorOptions) {
    super(
      "QUOTE_FETCH_FAILED",
      `HFI Pay quote service returned HTTP ${statusCode}: ${responseBody || "(empty)"}`,
      options,
    );
    this.name = "HfiPayNetworkError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/** Quote response was missing required fields or had an invalid shape. */
export class HfiPayQuoteError extends HfiPayError {
  constructor(message: string, options?: ErrorOptions) {
    super("QUOTE_INVALID", `HFI Pay quote invalid: ${message}`, options);
    this.name = "HfiPayQuoteError";
  }
}

/** Quote request timed out before a response was received. */
export class HfiPayTimeoutError extends HfiPayError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super("QUOTE_TIMEOUT", `HFI Pay quote timed out after ${timeoutMs}ms`, options);
    this.name = "HfiPayTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** TX construction failed (bad params, encoding error, etc.). */
export class HfiPayBuildTxError extends HfiPayError {
  constructor(message: string, options?: ErrorOptions) {
    super("BUILD_TX_FAILED", `HFI Pay TX build failed: ${message}`, options);
    this.name = "HfiPayBuildTxError";
  }
}
