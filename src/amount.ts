/**
 * Convert human-readable decimal amount to base units string.
 *
 * Example:
 * - toBaseUnits("0.01", 18) => "10000000000000000"
 * - toBaseUnits("50", 6) => "50000000"
 */
export function toBaseUnits(amount: string, decimals: number): string {
  const raw = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const [whole, frac = ""] = raw.split(".");
  if (frac.length > decimals) {
    throw new Error(`Too many decimal places: got ${frac.length}, max ${decimals}`);
  }

  const fracPadded = frac.padEnd(decimals, "0");
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}
