export type RecipientKind = "email" | "phone" | "x";

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at < 0) return trimmed;
  const localPart = trimmed.slice(0, at);
  const domainPart = trimmed.slice(at + 1);
  const plus = localPart.indexOf("+");
  const normalizedLocal = plus >= 0 ? localPart.slice(0, plus) : localPart;
  return `${normalizedLocal}@${domainPart}`;
}

/** Normalize recipient for quote + binding (email rules; phone/x trimmed/lowercased). */
export function normalizeRecipient(kind: RecipientKind, raw: string): string {
  const t = raw.trim();
  if (kind === "email") return t.includes("@") ? normalizeEmail(t) : t.toLowerCase();
  if (kind === "x") return t.replace(/^@/, "").toLowerCase();
  return t;
}
