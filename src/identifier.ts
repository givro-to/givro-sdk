export type RecipientKind = "email" | "phone" | "x";

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at < 0) return trimmed;
  const localPart = trimmed.slice(0, at);
  let domainPart = trimmed.slice(at + 1);
  let normalizedLocal = localPart;

  // Keep this provider-aware rule aligned with the Portal. Gmail treats
  // googlemail.com as an alias, ignores dots, and ignores +tags. Other mail
  // providers do not universally do so, therefore their local part must be
  // preserved to avoid merging two distinct recipients.
  if (domainPart === "googlemail.com") domainPart = "gmail.com";
  if (domainPart === "gmail.com") {
    const plus = normalizedLocal.indexOf("+");
    if (plus >= 0) normalizedLocal = normalizedLocal.slice(0, plus);
    normalizedLocal = normalizedLocal.replace(/\./g, "");
  }

  return `${normalizedLocal}@${domainPart}`;
}

/** Normalize recipient for quote + binding (email rules; phone/x trimmed/lowercased). */
export function normalizeRecipient(kind: RecipientKind, raw: string): string {
  const t = raw.trim();
  if (kind === "email") return t.includes("@") ? normalizeEmail(t) : t.toLowerCase();
  if (kind === "x") return t.replace(/^@/, "").toLowerCase();
  return t;
}
