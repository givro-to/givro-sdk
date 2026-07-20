import { describe, it, expect } from "vitest";
import { paymentRefHexToBytes } from "../src/solana/utils.js";
import { signAndSendSolanaAttestedDeposit, waitForSolanaConfirmation } from "../src/index.js";
import { HfiPayError } from "../src/errors.js";
import type { Connection } from "@solana/web3.js";

const VALID_HEX_NO_PREFIX = "ab".repeat(32); // 64 chars
const VALID_HEX_WITH_PREFIX = "0x" + VALID_HEX_NO_PREFIX;

describe("paymentRefHexToBytes", () => {
  it("accepts a 0x-prefixed 32-byte hex string", () => {
    const bytes = paymentRefHexToBytes(VALID_HEX_WITH_PREFIX);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it("accepts a hex string without 0x prefix", () => {
    const bytes = paymentRefHexToBytes(VALID_HEX_NO_PREFIX);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it("produces identical bytes for 0x-prefixed and non-prefixed inputs", () => {
    const a = paymentRefHexToBytes(VALID_HEX_WITH_PREFIX);
    const b = paymentRefHexToBytes(VALID_HEX_NO_PREFIX);
    expect(a).toEqual(b);
  });

  it("decodes each byte correctly", () => {
    const bytes = paymentRefHexToBytes("0x" + "00".repeat(31) + "ff");
    expect(bytes[0]).toBe(0x00);
    expect(bytes[31]).toBe(0xff);
  });

  it("throws when hex is too short (not 32 bytes)", () => {
    expect(() => paymentRefHexToBytes("0x" + "ab".repeat(16))).toThrow();
  });

  it("throws when hex is too long", () => {
    expect(() => paymentRefHexToBytes("0x" + "ab".repeat(33))).toThrow();
  });

  it("throws when string is empty", () => {
    expect(() => paymentRefHexToBytes("")).toThrow();
  });

  it("throws when string contains non-hex characters", () => {
    expect(() => paymentRefHexToBytes("zz".repeat(32))).toThrow();
  });
});

describe("waitForSolanaConfirmation", () => {
  it("returns the confirmed slot", async () => {
    const connection = {
      getSignatureStatus: async () => ({
        context: { slot: 99 },
        value: { slot: 42, confirmations: 1, err: null, confirmationStatus: "confirmed" },
      }),
    } as unknown as Connection;
    await expect(waitForSolanaConfirmation(connection, "signature", 50)).resolves.toEqual({ slot: 42 });
  });

  it("rejects a failed transaction even if the RPC also reports confirmed", async () => {
    const connection = {
      getSignatureStatus: async () => ({
        context: { slot: 99 },
        value: {
          slot: 42,
          confirmations: 1,
          err: { InstructionError: [0, "Custom"] },
          confirmationStatus: "confirmed",
        },
      }),
    } as unknown as Connection;
    await expect(waitForSolanaConfirmation(connection, "signature", 50)).rejects.toThrow(/failed/i);
  });

  it("wraps confirmation RPC failures in a typed network error", async () => {
    const connection = {
      getSignatureStatus: async () => { throw new Error("rpc down"); },
    } as unknown as Connection;
    try {
      await waitForSolanaConfirmation(connection, "signature", 50);
      throw new Error("expected confirmation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(HfiPayError);
      expect((err as HfiPayError).code).toBe("NETWORK_ERROR");
    }
  });
});

describe("signAndSendSolanaAttestedDeposit", () => {
  it("fails with a typed wallet error when sendTransaction is unavailable", async () => {
    try {
      await signAndSendSolanaAttestedDeposit({}, {} as Connection, {} as never);
      throw new Error("expected wallet validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(HfiPayError);
      expect((err as HfiPayError).code).toBe("WALLET_NOT_CONNECTED");
    }
  });
});
