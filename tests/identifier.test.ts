import { describe, it, expect } from "vitest";
import { normalizeEmail, normalizeRecipient } from "../src/identifier.js";

describe("normalizeEmail", () => {
  it("lowercases the address", () => {
    expect(normalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  it("strips plus alias from local part", () => {
    expect(normalizeEmail("user+alias@example.com")).toBe("user@example.com");
  });

  it("strips plus alias and lowercases", () => {
    expect(normalizeEmail("User+Tag@Example.COM")).toBe("user@example.com");
  });

  it("returns lowercased string as-is when no @ present", () => {
    expect(normalizeEmail("notanemail")).toBe("notanemail");
  });

  it("handles multiple plus signs — strips from first", () => {
    expect(normalizeEmail("a+b+c@x.io")).toBe("a@x.io");
  });
});

describe("normalizeRecipient", () => {
  it("email: normalizes via normalizeEmail", () => {
    expect(normalizeRecipient("email", "User+Tag@Example.COM")).toBe("user@example.com");
  });

  it("email without @: lowercases", () => {
    expect(normalizeRecipient("email", "  SOMEONE  ")).toBe("someone");
  });

  it("x: strips leading @", () => {
    expect(normalizeRecipient("x", "@handle")).toBe("handle");
  });

  it("x: lowercases and leaves no @ prefix", () => {
    expect(normalizeRecipient("x", "@MyHandle")).toBe("myhandle");
  });

  it("x: works without leading @", () => {
    expect(normalizeRecipient("x", "MyHandle")).toBe("myhandle");
  });

  it("phone: preserves as-is (trimmed)", () => {
    expect(normalizeRecipient("phone", "  +1-800-555-0199  ")).toBe("+1-800-555-0199");
  });

  it("phone: does not lowercase", () => {
    // phone values are opaque — returned as trimmed, case preserved
    expect(normalizeRecipient("phone", "+44 7700 900000")).toBe("+44 7700 900000");
  });
});
