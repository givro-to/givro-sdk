// End-to-end against a running portal, driving the demo the way a browser
// does. Nothing is mocked: the demo server is spawned as its own process, its
// HTTP routes are called, and every pay link it returns is fetched back from
// the portal as a payer would see it.
//
// This suite exists because the demo and the SDK had drifted apart. The demo
// was written three weeks before `GivroEnterpriseClient` existed, so it
// hand-rolled its own client — and learned things the SDK never did (the portal
// keys tokens by address; `givro_id` is a recipient kind). Hermetic tests could
// not have found that: each half agreed with itself. Only the portal can say
// which one is right, and only the demo running on top of the SDK makes the
// disagreement fail a test.
//
//   # 1. seed an org and a test key in the local portal
//   docker exec hfi-api-local npx tsx /app/scripts/seed-enterprise-api-key.ts
//
//   # 2. run, with the key that printed
//   GIVRO_E2E_PORTAL_URL=http://127.0.0.1:3001 \
//   GIVRO_E2E_ENTERPRISE_API_KEY=gvr_test_… \
//   GIVRO_E2E_CHAIN_ID=31338 \
//   GIVRO_E2E_TOKEN_ADDRESS=0xbded0d2bf404bdcba897a74e6657f1f12e5c6fb6 \
//   npx vitest run tests/e2e/enterprisePayLink.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORTAL = process.env.GIVRO_E2E_PORTAL_URL;
const API_KEY = process.env.GIVRO_E2E_ENTERPRISE_API_KEY;
const CHAIN_ID = Number(process.env.GIVRO_E2E_CHAIN_ID ?? 0);
// The chain's own registry decides this; the local stack's USDC by default.
const TOKEN_ADDRESS = process.env.GIVRO_E2E_TOKEN_ADDRESS ?? "";
const DEMO_PORT = Number(process.env.GIVRO_E2E_DEMO_PORT ?? 38470);

const live = Boolean(PORTAL && API_KEY && CHAIN_ID > 0);
const describeLive = live ? describe : describe.skip;

const demoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples/enterprise-pay-link-demo",
);
const demoUrl = `http://127.0.0.1:${DEMO_PORT}`;

let demo: ChildProcess | null = null;
let demoStderr = "";

async function demoJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${demoUrl}${pathname}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** What the payer's browser gets when it opens a pay_url. */
async function resolvePayLink(paymentLinkId: string): Promise<any> {
  const res = await fetch(`${PORTAL}/api/hosted-payment-links/${paymentLinkId}`);
  return res.json();
}

function createPayLink(body: Record<string, unknown>) {
  return demoJson("/api/create-pay-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The demo's own defaults are irrelevant here and its `.env` may hold a real
 * key pointed at production, so every variable the demo reads is set
 * explicitly. `loadDotEnv` only fills what the environment has not already set,
 * so these win over the file.
 */
function demoEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(DEMO_PORT),
    GIVRO_API_BASE: PORTAL,
    GIVRO_API_KEY: API_KEY,
    GIVRO_ENVIRONMENT: "test",
    GIVRO_RECIPIENT_KIND: "email",
    GIVRO_RECIPIENT_IDENTIFIER: "merchant@example.com",
    GIVRO_AMOUNT: "1.00",
    GIVRO_ECOSYSTEM: "evm",
    GIVRO_CHAIN_ID: String(CHAIN_ID),
    GIVRO_TOKEN_SYMBOL: TOKEN_ADDRESS ? "" : "USDC",
    GIVRO_TOKEN_ADDRESS: TOKEN_ADDRESS,
    GIVRO_FEE_PAYER: "payer",
    GIVRO_MESSAGE: "e2e invoice",
  };
}

describeLive("the enterprise pay-link demo, running on the SDK", () => {
  beforeAll(async () => {
    demo = spawn(process.execPath, ["server.mjs"], { cwd: demoDir, env: demoEnv() });
    demo.stderr?.on("data", (chunk) => { demoStderr += String(chunk); });

    // The import of `givro-sdk` resolves against the demo's node_modules, so a
    // missing `npm install` (or an unbuilt dist/) fails here rather than as a
    // confusing timeout below.
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (demo.exitCode !== null) {
        throw new Error(
          `demo server exited with ${demo.exitCode}. Did you run \`npm run build\` in givro-sdk `
          + `and \`npm install\` in examples/enterprise-pay-link-demo?\n${demoStderr}`,
        );
      }
      try {
        const res = await fetch(`${demoUrl}/api/config`);
        if (res.ok) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`demo server never came up\n${demoStderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 30_000);

  afterAll(() => {
    demo?.kill("SIGTERM");
  });

  it("serves the merchant page and reports the key without ever revealing it", async () => {
    const { status, body } = await demoJson("/api/config");
    expect(status).toBe(200);
    expect(body.has_api_key).toBe(true);
    expect(body.environment).toBe("test");
    // The whole reason the demo has a server at all. A key in this payload
    // would be a key in the page source.
    expect(JSON.stringify(body)).not.toContain(API_KEY!);

    const page = await fetch(demoUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Merchant Checkout Demo");
  });

  it("lists chains the key's environment can actually be billed on", async () => {
    const { status, body } = await demoJson("/api/supported-assets");
    expect(status).toBe(200);
    const chain = body.chains.find((c: any) => c.chainId === CHAIN_ID);
    // A chain outside the key's environment comes back from /api/payment-links
    // as environment_chain_mismatch, so offering one is offering a dead end.
    expect(chain, `chain ${CHAIN_ID} was not offered`).toBeTruthy();
    expect(chain.tokens.length).toBeGreaterThan(0);
    // The portal keys tokens by address. A symbol-only entry cannot be turned
    // into a link on a chain whose registry does not carry that symbol.
    expect(chain.tokens.some((t: any) => t.address || t.contract)).toBe(true);
  });

  it("creates a pay link a payer can open", async () => {
    const merchantRef = `e2e_${Date.now()}`;
    const { status, body } = await createPayLink({
      amount: "3.25",
      recipient_identifier: "merchant@example.com",
      recipient_kind: "email",
      chain_id: CHAIN_ID,
      ecosystem: "evm",
      ...(TOKEN_ADDRESS ? { token_address: TOKEN_ADDRESS } : { token_symbol: "USDC" }),
      fee_payer: "payer",
      message: "e2e invoice",
      merchant_ref: merchantRef,
    });

    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.pay_url).toContain(body.payment_link_id);

    // Not just "the API said ok": what the payer's browser resolves has to be
    // the link the merchant asked for.
    const resolved = await resolvePayLink(body.payment_link_id);
    expect(resolved.ok).toBe(true);
    expect(resolved.payment_link.recipient_identifier).toBe("merchant@example.com");
    expect(resolved.payment_link.amount_label).toBe("3.25");
    expect(resolved.payment_link.status).toBe("active");
  });

  it("collects for a business line addressed by a Givro ID", async () => {
    // The kind the SDK could not express: `recipient_kind` was typed email|x,
    // so the one merchant shape that needs no mailbox had no way through it.
    const { status, body } = await createPayLink({
      amount: "2.50",
      recipient_identifier: "acme.sales",
      recipient_kind: "givro_id",
      chain_id: CHAIN_ID,
      ecosystem: "evm",
      ...(TOKEN_ADDRESS ? { token_address: TOKEN_ADDRESS } : { token_symbol: "USDC" }),
      merchant_ref: `e2e_givro_${Date.now()}`,
    });

    expect(status, JSON.stringify(body)).toBe(200);
    const resolved = await resolvePayLink(body.payment_link_id);
    // The kind reaches the payer intact. Folded into "email" it would fail the
    // portal's email regex, or hash into an idHash no business line holds.
    expect(resolved.payment_link.identifier_kind).toBe("givro_id");
    expect(resolved.payment_link.recipient_identifier).toBe("acme.sales");
  });

  it("expires the link when the merchant says to, not on the default lifetime", async () => {
    // The bug this file was written to catch, and did not: the SDK typed the
    // field as `expires_at`, an absolute timestamp the portal has never read.
    // Both halves agreed with themselves — the unit test asserted the field was
    // forwarded, and the portal quietly applied its 30-day default. Only a link
    // read back from the portal can tell the difference.
    const before = Math.floor(Date.now() / 1000);
    const { status, body } = await createPayLink({
      amount: "1.50",
      recipient_identifier: "merchant@example.com",
      recipient_kind: "email",
      chain_id: CHAIN_ID,
      ecosystem: "evm",
      ...(TOKEN_ADDRESS ? { token_address: TOKEN_ADDRESS } : { token_symbol: "USDC" }),
      merchant_ref: `e2e_ttl_${Date.now()}`,
      expires_in_seconds: 600,
    });

    expect(status, JSON.stringify(body)).toBe(200);
    const expiresAt = Number(body.payment_link.expires_at);
    // A window wide enough for a slow round trip and far narrower than the
    // portal's default lifetime, which is what a dropped field would produce.
    expect(expiresAt).toBeGreaterThanOrEqual(before + 540);
    expect(expiresAt).toBeLessThanOrEqual(before + 660);
  });

  it("returns the same link for a repeated idempotency key", async () => {
    const request = {
      amount: "4.00",
      recipient_identifier: "merchant@example.com",
      recipient_kind: "email",
      chain_id: CHAIN_ID,
      ecosystem: "evm",
      ...(TOKEN_ADDRESS ? { token_address: TOKEN_ADDRESS } : { token_symbol: "USDC" }),
      merchant_ref: `e2e_idem_${Date.now()}`,
      idempotency_key: `e2e_idem_${Date.now()}_${Math.floor(process.hrtime()[1])}`,
    };

    const first = await createPayLink(request);
    const second = await createPayLink(request);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // A retried checkout must not bill twice. The key is the caller's, never
    // derived from the body — two payers buying the same thing for the same
    // amount are two payments.
    expect(second.body.payment_link_id).toBe(first.body.payment_link_id);
  });

  it("passes the portal's own refusal through instead of a bare status line", async () => {
    const { status, body } = await createPayLink({
      amount: "1.00",
      recipient_identifier: "merchant@example.com",
      recipient_kind: "email",
      // Base mainnet: a real chain, and one a test key may not bill on.
      chain_id: 8453,
      ecosystem: "evm",
      token_symbol: "USDC",
      merchant_ref: `e2e_badchain_${Date.now()}`,
    });

    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.ok).toBe(false);
    // "environment_chain_mismatch" tells the merchant what to change;
    // "HTTP 400" does not. The SDK extracts it, the demo forwards it.
    expect(body.code || body.error).toBeTruthy();
    expect(String(body.error)).not.toBe("Givro Enterprise API returned HTTP 400");
  });

  it("refuses a recipient kind the portal does not route", async () => {
    const { status, body } = await createPayLink({
      amount: "1.00",
      recipient_identifier: "+15555550100",
      recipient_kind: "phone",
      chain_id: CHAIN_ID,
      ecosystem: "evm",
      token_symbol: "USDC",
    });
    // Refused by the demo before a request is spent on it: phone would
    // otherwise be silently reinterpreted as an email by the portal's default.
    expect(status).toBe(400);
    expect(String(body.error)).toContain("recipient_kind");
  });
});
