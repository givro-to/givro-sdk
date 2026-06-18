/** Convert `paymentRef` from quote (`0x` + 64 hex) to 32 bytes for Solana ix. */
export function paymentRefHexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error("paymentRef must be 32-byte hex");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
