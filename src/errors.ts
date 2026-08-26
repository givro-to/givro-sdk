/** Typed error hierarchy for Givro SDK. All errors are instanceof-checkable. */

export type GivroPayErrorCode =
  | "QUOTE_FETCH_FAILED"
  | "QUOTE_INVALID"
  | "QUOTE_TIMEOUT"
  | "CONFIG_TIMEOUT"
  | "NETWORK_TIMEOUT"
  | "CONFIG_INVALID"
  | "BUILD_TX_FAILED"
  | "MISSING_DEPOSIT_CONTRACT"
  | "WRONG_ECOSYSTEM"
  | "INVALID_PAYMENT_REF"
  | "WALLET_NOT_CONNECTED"
  | "SIGN_FAILED"
  | "TRANSACTION_FAILED"
  | "NETWORK_ERROR"
  | "ENTERPRISE_API_ERROR";

export class GivroPayError extends Error {
  readonly code: GivroPayErrorCode;

  constructor(code: GivroPayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GivroPayError";
    this.code = code;
  }
}

/** HTTP error returned by an Givro service endpoint. */
export class GivroPayNetworkError extends GivroPayError {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(
    statusCode: number,
    responseBody: string,
    options?: ErrorOptions & { code?: "QUOTE_FETCH_FAILED" | "NETWORK_ERROR" },
  ) {
    super(
      options?.code ?? "QUOTE_FETCH_FAILED",
      `Givro service returned HTTP ${statusCode}: ${responseBody || "(empty)"}`,
      options,
    );
    this.name = "GivroPayNetworkError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/** Quote response was missing required fields or had an invalid shape. */
export class GivroPayQuoteError extends GivroPayError {
  constructor(message: string, options?: ErrorOptions) {
    super("QUOTE_INVALID", `Givro quote invalid: ${message}`, options);
    this.name = "GivroPayQuoteError";
  }
}

/** Public runtime configuration response was missing required fields. */
export class GivroPayConfigError extends GivroPayError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIG_INVALID", `Givro public configuration invalid: ${message}`, options);
    this.name = "GivroPayConfigError";
  }
}

/** Givro service request timed out before a response was received. */
export class GivroPayTimeoutError extends GivroPayError {
  readonly timeoutMs: number;

  constructor(
    timeoutMs: number,
    options?: ErrorOptions & { code?: "QUOTE_TIMEOUT" | "CONFIG_TIMEOUT" | "NETWORK_TIMEOUT" },
  ) {
    super(options?.code ?? "QUOTE_TIMEOUT", `Givro request timed out after ${timeoutMs}ms`, options);
    this.name = "GivroPayTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** TX construction failed (bad params, encoding error, etc.). */
export class GivroPayBuildTxError extends GivroPayError {
  constructor(message: string, options?: ErrorOptions) {
    super("BUILD_TX_FAILED", `Givro TX build failed: ${message}`, options);
    this.name = "GivroPayBuildTxError";
  }
}

/** HTTP error returned by the server-side Enterprise API. */
export class GivroEnterpriseApiError extends GivroPayError {
  readonly statusCode: number;
  readonly responseBody: unknown;
  readonly requestId?: string;
  /**
   * The server's stable error code (`invalid_api_key`, `rate_limited`, ...)
   * when it sent one. Branch on this rather than on the message text.
   */
  readonly errorCode?: string;

  constructor(
    statusCode: number,
    responseBody: unknown,
    options?: ErrorOptions & { requestId?: string },
  ) {
    const body = responseBody && typeof responseBody === "object" ? responseBody as Record<string, unknown> : undefined;
    // The enterprise API nests its failures as `{ error: { code, message } }`.
    // Reading only the string forms discarded both, leaving the caller with a
    // bare "HTTP 401" while the server had already said `invalid_api_key`.
    const nested = body?.error && typeof body.error === "object"
      ? body.error as Record<string, unknown>
      : undefined;
    const errorCode = typeof nested?.code === "string" ? nested.code : undefined;
    const nestedMessage = typeof nested?.message === "string" ? nested.message : undefined;
    const message = typeof body?.error === "string"
      ? body.error
      : nestedMessage
        ? errorCode ? `${errorCode}: ${nestedMessage}` : nestedMessage
        : typeof body?.message === "string"
          ? body.message
          : `Givro Enterprise API returned HTTP ${statusCode}`;
    super("ENTERPRISE_API_ERROR", message, options);
    this.name = "GivroEnterpriseApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.requestId = options?.requestId;
    this.errorCode = errorCode;
  }
}
