import { describe, it, expect } from "vitest";
import { normalizeEmail, normalizeRecipient } from "../src/identifier.js";

describe("normalizeEmail", () => {
  it("lowercases the address", () => {
    expect(normalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  it("preserves plus aliases for non-Gmail providers", () => {
    expect(normalizeEmail("user+alias@example.com")).toBe("user+alias@example.com");
  });

  it("preserves dots for non-Gmail providers", () => {
    expect(normalizeEmail("First.Last@Example.COM")).toBe("first.last@example.com");
  });

  it("strips Gmail plus aliases and dots", () => {
    expect(normalizeEmail("First.Last+Tag@Gmail.COM")).toBe("firstlast@gmail.com");
  });

  it("canonicalizes googlemail.com to gmail.com", () => {
    expect(normalizeEmail("First.Last+Tag@GoogleMail.COM")).toBe("firstlast@gmail.com");
  });

  it("returns lowercased string as-is when no @ present", () => {
    expect(normalizeEmail("notanemail")).toBe("notanemail");
  });

  it("preserves multiple plus signs outside Gmail", () => {
    expect(normalizeEmail("a+b+c@x.io")).toBe("a+b+c@x.io");
  });
});

describe("normalizeRecipient", () => {
  it("email: normalizes via normalizeEmail", () => {
    expect(normalizeRecipient("email", "User+Tag@Example.COM")).toBe("user+tag@example.com");
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

  it("givro_id: strips a leading @ and lowercases, like an X handle", () => {
    // The kind is inside the string the portal HMACs, so a normalization that
    // differs from the portal's yields an idHash no binding matches.
    expect(normalizeRecipient("givro_id", "  @Acme.Sales  ")).toBe("acme.sales");
    expect(normalizeRecipient("givro_id", "ACME")).toBe("acme");
  });

  it("strips a run of @, the way the portal does", () => {
    // One @ left `@@acme` as `@acme` here and `acme` at the portal — the same
    // recipient in two canonical forms, which is what this function exists to
    // prevent.
    expect(normalizeRecipient("givro_id", "@@acme.sales")).toBe("acme.sales");
    expect(normalizeRecipient("x", "@@alice")).toBe("alice");
  });

  it("givro_id: keeps the dot that separates a branch from its root", () => {
    // acme.sales is one identifier, not an email-shaped thing to be rewritten.
    expect(normalizeRecipient("givro_id", "acme.product_b")).toBe("acme.product_b");
  });
});
