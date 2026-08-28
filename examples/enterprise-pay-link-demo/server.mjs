/**
 * Minimal merchant site demo for Givro Enterprise pay links.
 *
 * Flow:
 *  1. Browser clicks "Pay" → POST /api/create-pay-link (this server)
 *  2. This server calls Givro through the SDK: POST /api/payment-links
 *  3. Response includes pay_url → UI shows link; payer opens it and pays with wallet
 *
 * The Enterprise API is reached through `givro-sdk` rather than raw fetch. When
 * this demo was written the SDK had no server-side client, so it hand-rolled
 * one — and the two drifted: the demo learned that the portal keys tokens by
 * address, and the SDK never did. A demo that does not use the package it ships
 * inside cannot catch that again.
 *
 * The API key stays in this process. It is never returned by /api/config and
 * never reaches the browser.
 *
 * Env: copy .env.example → .env (or export vars in the shell).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import {
  createGivroEnterpriseClient,
  fetchPublicSupportedAssets,
  GivroEnterpriseApiError,
} from "givro-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 3847);
const API_BASE = (process.env.GIVRO_API_BASE || "https://givro.to").replace(/\/+$/, "");
const API_KEY = (process.env.GIVRO_API_KEY || "").trim();
const ENVIRONMENT = (process.env.GIVRO_ENVIRONMENT || "test").trim() === "live" ? "live" : "test";

/** Server-side only. Constructed once; the key never leaves this process. */
const givro = API_KEY ? createGivroEnterpriseClient({ apiKey: API_KEY, baseUrl: API_BASE }) : null;

/** The identifier kinds a pay link can collect under. */
const RECIPIENT_KINDS = new Set(["email", "x", "givro_id"]);

function defaultsFromEnv() {
  return {
    environment: ENVIRONMENT,
    recipient_kind: (process.env.GIVRO_RECIPIENT_KIND || "email").trim(),
    recipient_identifier: (process.env.GIVRO_RECIPIENT_IDENTIFIER || "").trim(),
    amount: (process.env.GIVRO_AMOUNT || "1.00").trim(),
    ecosystem: (process.env.GIVRO_ECOSYSTEM || "evm").trim(),
    chain_id: Number(process.env.GIVRO_CHAIN_ID || (ENVIRONMENT === "live" ? 8453 : 84532)),
    token_address: (process.env.GIVRO_TOKEN_ADDRESS || "").trim(),
    token_symbol: (process.env.GIVRO_TOKEN_SYMBOL || (process.env.GIVRO_TOKEN_ADDRESS ? "" : "ETH")).trim(),
    fee_payer: (process.env.GIVRO_FEE_PAYER || "payer").trim(),
    message: (process.env.GIVRO_MESSAGE || "Demo payment").trim(),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function serveStatic(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// Chain/token dropdown data, proxied server-side so the browser never needs
// CORS access to the portal or sight of the API key. Two sources are merged:
//  - Enterprise supported_assets (needs the API key): authoritative for the
//    key's environment — a test key lists testnet chains the public registry
//    of a mainnet portal does not carry. EVM chains, symbol-only tokens.
//  - Public registry: token metadata (addresses/decimals/native) and tron
//    chains, which pay links also accept.
// Cached briefly to respect the endpoints' rate limits.
let assetsCache = { at: 0, data: null };
const ASSETS_CACHE_MS = 5 * 60_000;

/** Either source may be unavailable; a missing one degrades the list, not the page. */
async function orNull(promise) {
  return promise.then((value) => value, () => null);
}

async function fetchSupportedAssets() {
  const now = Date.now();
  if (assetsCache.data && now - assetsCache.at < ASSETS_CACHE_MS) return assetsCache.data;

  const [registry, enterprise] = await Promise.all([
    orNull(fetchPublicSupportedAssets(API_BASE)),
    givro ? orNull(givro.getSupportedAssets()) : null,
  ]);

  // Pay links take a numeric chain_id, so only evm/tron registry chains apply.
  const registryChains = (registry && Array.isArray(registry.chains) ? registry.chains : []).filter(
    (c) => (c.ecosystem === "evm" || c.ecosystem === "tron") && Number.isInteger(c.chainId),
  );
  const registryByChainId = new Map(registryChains.map((c) => [c.chainId, c]));

  const EVM_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const chains = [];
  if (enterprise && Array.isArray(enterprise.chains)) {
    for (const chain of enterprise.chains) {
      if (!Number.isInteger(chain.chain_id)) continue;
      const registryChain = registryByChainId.get(chain.chain_id);
      // Newer portals return full token metadata; older ones only `assets`
      // symbol lists, which we enrich as best we can (the deployed
      // /api/payment-links validator requires a token address).
      const tokens = Array.isArray(chain.tokens) && chain.tokens.length > 0
        ? chain.tokens
        : (Array.isArray(chain.assets) ? chain.assets : []).map((symbol) => {
            const meta = registryChain?.tokens?.find((t) => t.symbol === symbol);
            if (meta) return { symbol, ...meta };
            if (symbol === "ETH") return { symbol, address: EVM_ZERO_ADDRESS, native: true };
            return { symbol };
          });
      chains.push({
        ecosystem: "evm",
        chainId: chain.chain_id,
        label: chain.name || registryChain?.label || `Chain ${chain.chain_id}`,
        tokens,
      });
    }
  }
  // The enterprise list is authoritative for what this key's environment
  // accepts (/api/payment-links rejects other chain_ids with
  // environment_chain_mismatch). Registry chains are only added when they
  // can actually be used: all of them when no key is configured, and tron
  // mainnet alongside a live key. A test key gets testnet chains only.
  const enterpriseListed = chains.length > 0;
  for (const chain of registryChains) {
    if (chains.some((c) => c.chainId === chain.chainId)) continue;
    if (!enterpriseListed) { chains.push(chain); continue; }
    if (chain.ecosystem === "tron" && ENVIRONMENT === "live") chains.push(chain);
  }

  if (chains.length === 0) {
    const err = new Error(`failed to load supported assets from ${API_BASE}`);
    err.status = 502;
    throw err;
  }
  assetsCache = { at: now, data: { ok: true, environment: ENVIRONMENT, chains } };
  return assetsCache.data;
}

async function createEnterprisePayLink(input) {
  if (!givro) {
    const err = new Error("GIVRO_API_KEY is not set. Copy .env.example to .env and paste your Enterprise API key.");
    err.status = 500;
    err.code = "missing_api_key";
    throw err;
  }

  const defaults = defaultsFromEnv();
  let tokenAddress = String(input.token_address || "").trim();
  let tokenSymbol = String(input.token_symbol || "").trim();
  if (!tokenAddress && !tokenSymbol) {
    tokenAddress = defaults.token_address;
    tokenSymbol = defaults.token_symbol;
  }
  const recipientKind = String(input.recipient_kind || defaults.recipient_kind).trim();
  if (!RECIPIENT_KINDS.has(recipientKind)) {
    const err = new Error(`recipient_kind must be one of ${[...RECIPIENT_KINDS].join(", ")}`);
    err.status = 400;
    throw err;
  }
  const recipient = String(input.recipient_identifier || defaults.recipient_identifier).trim();
  if (!recipient) {
    const err = new Error("recipient_identifier is required (merchant receiving email, X handle, or Givro ID)");
    err.status = 400;
    throw err;
  }

  const merchantRef = String(input.merchant_ref || `demo_${Date.now()}`).slice(0, 128);
  const params = {
    recipient,
    recipient_kind: recipientKind,
    amount: String(input.amount || defaults.amount).trim(),
    ecosystem: input.ecosystem || defaults.ecosystem,
    chainId: Number(input.chain_id ?? defaults.chain_id),
    // Exactly one: the portal resolves a symbol against the chain's registry
    // and takes an address verbatim, so a chain whose registry does not carry
    // the symbol is reachable only by address.
    ...(tokenAddress ? { token_address: tokenAddress } : { token_symbol: tokenSymbol }),
    fee_payer: input.fee_payer || defaults.fee_payer,
    merchant_ref: merchantRef,
    message: String(input.message || defaults.message).slice(0, 280),
    // A duration, not a deadline — see CreatePaymentLinkBase. Omitted leaves
    // the portal's default lifetime in place.
    ...(input.expires_in_seconds === undefined
      ? {}
      : { expires_in_seconds: Number(input.expires_in_seconds) }),
  };

  // Owned by the caller, never derived from the body: two payers buying the
  // same thing for the same amount must not collapse into one payment link.
  const idempotencyKey = String(input.idempotency_key || `demo_${merchantRef}_${randomUUID()}`).slice(0, 160);

  try {
    const json = await givro.createPaymentLink(params, idempotencyKey);
    return {
      ok: true,
      pay_url: json.pay_url,
      payment_link: json.payment_link,
      payment_link_id: json.payment_link_id,
      request_sent: params,
      idempotency_key: idempotencyKey,
    };
  } catch (error) {
    if (error instanceof GivroEnterpriseApiError) {
      // The portal's own code and message — "environment_chain_mismatch" says
      // far more than "HTTP 400", and the SDK already extracted it.
      const err = new Error(error.message);
      err.status = error.statusCode;
      err.code = error.errorCode;
      err.details = { request_id: error.requestId, body: error.responseBody };
      throw err;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/config") {
    const d = defaultsFromEnv();
    sendJson(res, 200, {
      ok: true,
      api_base: API_BASE,
      environment: d.environment,
      has_api_key: Boolean(API_KEY),
      defaults: {
        ...d,
        // never return the key
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/supported-assets") {
    try {
      sendJson(res, 200, await fetchSupportedAssets());
    } catch (error) {
      sendJson(res, error.status && Number.isInteger(error.status) ? error.status : 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    // Givro lifecycle webhook receiver. Verify Givro-Signature
    // (t=<unix-seconds>,v1=<hex> of HMAC-SHA256(secret, timestamp + "." + rawBody))
    // before trusting the payload; reconcile idempotently by payload.id.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const secret = (process.env.GIVRO_WEBHOOK_SECRET || "").trim();
    const header = String(req.headers["givro-signature"] || "");
    let verified = false;
    if (secret && header) {
      const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
      const timestamp = Number(parts.t);
      const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
      const given = String(parts.v1 || "");
      verified = Number.isFinite(timestamp)
        && Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= 300
        && given.length === expected.length
        && timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
    }
    let payload = {};
    try { payload = JSON.parse(rawBody); } catch { /* keep raw log below */ }
    console.log(`[webhook] ${verified ? "VERIFIED" : (secret ? "SIGNATURE MISMATCH" : "UNVERIFIED (set GIVRO_WEBHOOK_SECRET)")} id=${payload.id ?? "?"} type=${payload.type ?? "?"} payment_link_id=${payload.payment_link_id ?? "?"} status=${payload.current_status ?? payload.payment_link?.status ?? "?"}`);
    if (secret && !verified) {
      sendJson(res, 400, { ok: false, error: "signature verification failed" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/create-pay-link") {
    try {
      const input = await readJsonBody(req);
      const result = await createEnterprisePayLink(input);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.status && Number.isInteger(error.status) ? error.status : 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        details: error.details,
        code: error.code,
      });
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log("");
  console.log("Givro Enterprise pay-link demo");
  console.log(`  open  http://127.0.0.1:${PORT}`);
  console.log(`  api   ${API_BASE}`);
  console.log(`  env   ${ENVIRONMENT}`);
  console.log(`  key   ${API_KEY ? "set" : "MISSING — set GIVRO_API_KEY in .env"}`);
  console.log("");
});
