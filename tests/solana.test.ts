import { describe, it, expect } from "vitest";
import { paymentRefHexToBytes } from "../src/solana/utils.js";

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
