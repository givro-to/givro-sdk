import { describe, expect, it } from "vitest";
import { toBaseUnits } from "../src/amount.js";

describe("toBaseUnits", () => {
  it("converts ETH-like decimals", () => {
    expect(toBaseUnits("0.01", 18)).toBe("10000000000000000");
  });

  it("converts integer amounts", () => {
    expect(toBaseUnits("50", 6)).toBe("50000000");
  });

  it("pads fractional part", () => {
    expect(toBaseUnits("1.2", 6)).toBe("1200000");
  });

  it("rejects too many decimals", () => {
    expect(() => toBaseUnits("1.234", 2)).toThrow(/Too many decimal places/i);
  });

  it("rejects invalid amount format", () => {
    expect(() => toBaseUnits("-1", 18)).toThrow(/Invalid decimal amount/i);
    expect(() => toBaseUnits("1e-3", 18)).toThrow(/Invalid decimal amount/i);
  });
});
