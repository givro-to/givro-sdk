/**
 * `givro_id` is a name Givro issued to one enterprise business line
 * (givro.to/@acme.sales). It has no mailbox of its own, so it is never a
 * delivery address — only an identifier the escrow routes by.
 */
export type RecipientKind = "email" | "phone" | "x" | "givro_id";

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
  // The kind is part of the string the portal HMACs into an idHash, so these
  // rules must match it exactly: a different normalization here produces an
  // idHash no binding matches, and the payment funds an escrow nobody can claim.
  //
  // `@+`, not `@`: the portal strips a run of them, so stripping one left
  // `@@acme` as `@acme` here and `acme` there — the same recipient in two
  // canonical forms, which is the one thing this function exists to prevent.
  if (kind === "x" || kind === "givro_id") return t.replace(/^@+/, "").toLowerCase();
  return t;
}
