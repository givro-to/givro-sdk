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
import { randomUUID } from "node:crypto";
import {
  createGivroEnterpriseClient,
  fetchPublicSupportedAssets,
  GivroEnterpriseApiError,
  verifyEnterpriseWebhookSignature,
} from "givro-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const parsed = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
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
    parsed[key] = value;
  }
  return parsed;
}

function loadDotEnv() {
  // `.env.local` wins over `.env` so a laptop can point at the local portal
  // without rewriting the production key file. The process environment still
  // wins over both — that is how the e2e suite keeps a production `.env` inert.
  const merged = {
    ...parseEnvFile(path.join(__dirname, ".env")),
    ...parseEnvFile(path.join(__dirname, ".env.local")),
  };
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 3847);
const API_BASE = (process.env.GIVRO_API_BASE || "https://givro.to").replace(/\/+$/, "");
const API_KEY = (process.env.GIVRO_API_KEY || "").trim();
const ENVIRONMENT = (process.env.GIVRO_ENVIRONMENT || "test").trim() === "live" ? "live" : "test";
// Origin used to build the pay link's return_url. Public hosts must be
// https://. Loopback http:// is the exception the portal now accepts, so a
// checkout on this machine can send the payer back without a tunnel.
function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function merchantOrigin(raw) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:") return trimmed;
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return trimmed;
    return "";
  } catch {
    return "";
  }
}

function defaultLoopbackOrigin() {
  try {
    return isLoopbackHost(new URL(API_BASE).hostname) ? `http://127.0.0.1:${PORT}` : "";
  } catch {
    return "";
  }
}

const PUBLIC_ORIGIN = merchantOrigin(process.env.GIVRO_PUBLIC_ORIGIN) || defaultLoopbackOrigin();

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
  // Tron is not folded into `chains` — the portal reports it alongside so
  // callers that treat that array as EVM-only keep working. A demo that
  // ignored `tron_networks` could never offer Nile to a test key.
  if (enterprise && Array.isArray(enterprise.tron_networks)) {
    for (const network of enterprise.tron_networks) {
      if (!Number.isInteger(network.chain_id)) continue;
      if (chains.some((c) => c.chainId === network.chain_id)) continue;
      const registryChain = registryByChainId.get(network.chain_id);
      const tokens = Array.isArray(network.tokens) && network.tokens.length > 0
        ? network.tokens.map((token) => ({
            symbol: token.symbol,
            address: token.address,
            contract: token.address,
            decimals: token.decimals,
            ...(token.native === true ? { native: true } : {}),
          }))
        : (registryChain?.tokens ?? []);
      chains.push({
        ecosystem: "tron",
        chainId: network.chain_id,
        label: network.name || registryChain?.label || `Tron ${network.network || network.chain_id}`,
        tokens,
      });
    }
  }

  // The enterprise list is authoritative for what this key's environment
  // accepts (/api/payment-links rejects other chain_ids with
  // environment_chain_mismatch). Registry chains are only added when no
  // key is configured — otherwise a public mainnet Tron row would appear
  // next to a test key and fail at create.
  const enterpriseListed = Boolean(enterprise && (Array.isArray(enterprise.chains) || Array.isArray(enterprise.tron_networks)));
  for (const chain of registryChains) {
    if (chains.some((c) => c.chainId === chain.chainId)) continue;
    if (!enterpriseListed) chains.push(chain);
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
    // Where the pay page offers to send the payer once they are done. An
    // offer, not a proof: the browser coming back says nothing about whether
    // the payment settled, which is what the webhook is for.
    ...(input.return_url ? { return_url: String(input.return_url) } : {}),
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

// ---------------------------------------------------------------------------
// The store.
//
// Prices live here, never in the browser: a checkout that bills whatever the
// page posted is the oldest bug in e-commerce. The order is created first and
// its id becomes the pay link's `merchant_ref`, which is what the webhook
// arrives holding — that one field is the whole join between Givro's payment
// and this merchant's order.
// ---------------------------------------------------------------------------

const CATALOG = [
  { sku: "beans",   name: "Single-Origin Beans",  note: "Ethiopia Yirgacheffe, 340g", price: "18.00", art: "\u2615" },
  { sku: "grinder", name: "Hand Grinder",         note: "Conical burr, 40 clicks",    price: "45.00", art: "\u2699\ufe0f" },
  { sku: "kettle",  name: "Pour-Over Kettle",     note: "Gooseneck, 0.9L",            price: "62.00", art: "\ud83e\uded6" },
];

/** Demo-scale storage. A real merchant puts these in its own database. */
const orders = new Map();
const ordersByPaymentLink = new Map();

/** Cents, so a three-item order does not drift the way floats do. */
function priceCents(decimal) {
  const [whole, frac = ""] = String(decimal).split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

function formatCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// A webhook may be retried, and two events may overtake each other in flight.
// Ranking the statuses lets a late `funded` land after `paid` without walking
// the order backwards.
const ORDER_STATUS_RANK = {
  awaiting_payment: 0,
  funded: 1,
  paid: 2,
  expired: 2,
  cancelled: 2,
  refund_pending: 3,
  refunded: 4,
};

const EVENT_STATUS = {
  "payment.funded": "funded",
  "payment.claimed": "paid",
  "payment.expired": "expired",
  "payment.cancelled": "cancelled",
  // `payment.failed` deliberately maps to nothing. A failed attempt leaves the
  // link payable, so the order stays awaiting payment and the buyer can try
  // again — a declined card does not cancel an order either. It still shows in
  // the timeline, because every event does.
  "payment.refund_pending": "refund_pending",
  "payment.refunded": "refunded",
};

const HOSTED_STATUS = {
  paid: "paid",
  claimed: "paid",
  refunded: "refunded",
  expired: "expired",
  cancelled: "cancelled",
  disabled: "cancelled",
};

/**
 * Local webhooks cannot reach 127.0.0.1 from the portal container (SSRF
 * denylist). The merchant pattern is still the signed webhook; this read is
 * only so a laptop checkout can walk the return button without a tunnel.
 */
async function refreshOrderFromHosted(order) {
  if (!givro || !order.payment_link_id) return order;
  try {
    const res = await fetch(`${API_BASE}/api/hosted-payment-links/${order.payment_link_id}`);
    const json = await res.json().catch(() => ({}));
    const link = json.payment_link && typeof json.payment_link === "object" ? json.payment_link : null;
    if (!link) return order;
    const mapped = HOSTED_STATUS[String(link.status || "").toLowerCase()] || "";
    if (mapped && (ORDER_STATUS_RANK[mapped] ?? -1) > (ORDER_STATUS_RANK[order.status] ?? -1)) {
      order.status = mapped;
    }
  } catch {
    /* webhook remains the account of payment */
  }
  return order;
}

function publicOrder(order) {
  return {
    order_id: order.order_id,
    status: order.status,
    created_at: order.created_at,
    items: order.items,
    total: order.total,
    currency: order.currency,
    pay_url: order.pay_url,
    payment_link_id: order.payment_link_id,
    events: order.events,
    can_simulate: ENVIRONMENT === "test",
  };
}

/** Fold one verified webhook into the order it names. Idempotent by event id. */
function applyWebhookToOrder(payload, data, verified) {
  const ref = String(data.merchant_ref ?? "");
  const linkId = String(data.payment_link_id ?? payload.object_id ?? "");
  const order = orders.get(ref) ?? ordersByPaymentLink.get(linkId);
  if (!order) return null;

  const eventId = String(payload.id ?? "");
  // Givro retries until it gets a 2xx, so the same event id arrives more than
  // once as a matter of course. Reconciling twice is the merchant's bug.
  if (eventId && order.seenEventIds.has(eventId)) return { order, duplicate: true };
  if (eventId) order.seenEventIds.add(eventId);

  const type = String(payload.type ?? "");
  // The event type is what happened, and it wins. The link's status is only
  // where the link ended up, and the two disagree exactly where it matters: a
  // failed attempt leaves the link "active", which is not a thing an order can
  // be. Sandbox events set `current_status`; live settlement events put the
  // same fact on `payment_link.status` — either serves as the fallback for an
  // event type this merchant does not model.
  const next = EVENT_STATUS[type]
    ?? String(data.current_status ?? data.payment_link?.status ?? "");
  order.events.push({
    id: eventId || null,
    type: type || "unknown",
    status: next || null,
    at: Number(payload.created_at) || Math.floor(Date.now() / 1000),
    verified,
  });
  if (next && (ORDER_STATUS_RANK[next] ?? -1) > (ORDER_STATUS_RANK[order.status] ?? -1)) {
    order.status = next;
  }
  return { order, duplicate: false };
}

async function createOrder(input) {
  const requested = Array.isArray(input.items) ? input.items : [];
  const items = [];
  let totalCents = 0;
  for (const line of requested) {
    const product = CATALOG.find((c) => c.sku === String(line.sku ?? ""));
    const quantity = Math.floor(Number(line.quantity ?? 0));
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) continue;
    const lineCents = priceCents(product.price) * quantity;
    totalCents += lineCents;
    items.push({ sku: product.sku, name: product.name, quantity, unit_price: product.price, line_total: formatCents(lineCents) });
  }
  if (items.length === 0) {
    const err = new Error("cart is empty");
    err.status = 400;
    throw err;
  }

  const defaults = defaultsFromEnv();
  const orderId = `ord_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const total = formatCents(totalCents);

  const link = await createEnterprisePayLink({
    amount: total,
    merchant_ref: orderId,
    message: `Order ${orderId}`,
    // Only when this process has a public https origin the portal will accept.
    // http://127.0.0.1 is dropped above so the order still creates.
    ...(PUBLIC_ORIGIN ? { return_url: `${PUBLIC_ORIGIN}/order/${orderId}` } : {}),
    // A checkout that stays open for the portal's default lifetime is a
    // checkout whose price is stale. Thirty minutes is a cart, not an invoice.
    expires_in_seconds: 1800,
  });

  const order = {
    order_id: orderId,
    status: "awaiting_payment",
    created_at: Math.floor(Date.now() / 1000),
    items,
    total,
    currency: defaults.token_symbol || "tokens",
    pay_url: link.pay_url,
    payment_link_id: link.payment_link_id,
    events: [],
    seenEventIds: new Set(),
  };
  orders.set(orderId, order);
  ordersByPaymentLink.set(link.payment_link_id, order);
  return order;
}

async function handleRequest(req, res) {
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
    const header = String(req.headers["givro-signature"] || req.headers["x-givro-signature"] || "");
    // Same helper the SDK ships: HMAC of "<t>.<raw body>", hex v1, ±300s.
    // Hand-rolling this here is how the demo and the SDK last drifted.
    const verified = secret
      ? verifyEnterpriseWebhookSignature({ secret, header, rawBody })
      : false;
    let payload = {};
    try { payload = JSON.parse(rawBody); } catch { /* keep raw log below */ }
    // Envelope: { id, type, api_version, environment, created_at, object_type,
    // object_id, request_id, data }. Everything about the payment link lives
    // in `data` — only the event's own identity is at the top level.
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    console.log(`[webhook] ${verified ? "VERIFIED" : (secret ? "SIGNATURE MISMATCH" : "UNVERIFIED (set GIVRO_WEBHOOK_SECRET)")} id=${payload.id ?? "?"} type=${payload.type ?? "?"} payment_link_id=${data.payment_link_id ?? payload.object_id ?? "?"} status=${data.current_status ?? data.payment_link?.status ?? "?"}`);
    if (secret && !verified) {
      sendJson(res, 400, { ok: false, error: "signature verification failed" });
      return;
    }
    // Only a verified event may move an order. Without a secret configured the
    // demo still reconciles so the flow can be seen end to end, and says so.
    const applied = applyWebhookToOrder(payload, data, verified);
    if (applied) {
      console.log(`[order] ${applied.order.order_id} -> ${applied.order.status}${applied.duplicate ? " (duplicate event ignored)" : ""}`);
    }
    // 200 stops the retry schedule. Anything else and Givro redelivers.
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

  if (req.method === "GET" && url.pathname === "/api/catalog") {
    const d = defaultsFromEnv();
    sendJson(res, 200, { ok: true, currency: d.token_symbol || "tokens", products: CATALOG });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orders") {
    try {
      const order = await createOrder(await readJsonBody(req));
      sendJson(res, 200, { ok: true, ...publicOrder(order) });
    } catch (error) {
      sendJson(res, Number.isInteger(error.status) ? error.status : 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error.code,
        details: error.details,
      });
    }
    return;
  }

  const orderMatch = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9_]+)$/);
  if (req.method === "GET" && orderMatch) {
    const order = orders.get(orderMatch[1]);
    if (!order) {
      sendJson(res, 404, { ok: false, error: "order not found" });
      return;
    }
    await refreshOrderFromHosted(order);
    sendJson(res, 200, { ok: true, ...publicOrder(order) });
    return;
  }

  // Test-environment convenience: drives the portal's sandbox simulator so the
  // whole lifecycle can be walked without a wallet. Sandbox links carry
  // settlement_mode=simulated, which is what makes this endpoint (rather than
  // the API-key-authenticated simulate-paid) the one that applies.
  const simulateMatch = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9_]+)\/simulate$/);
  if (req.method === "POST" && simulateMatch) {
    const order = orders.get(simulateMatch[1]);
    if (!order) {
      sendJson(res, 404, { ok: false, error: "order not found" });
      return;
    }
    if (ENVIRONMENT !== "test") {
      sendJson(res, 403, { ok: false, error: "simulation is only available with a test API key" });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const scenario = String(body.scenario || "success");
      const response = await fetch(`${API_BASE}/api/hosted-payment-links/${order.payment_link_id}/simulate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `${order.order_id}-${scenario}-${Date.now()}`,
        },
        body: JSON.stringify({ scenario }),
      });
      const json = await response.json().catch(() => ({}));
      sendJson(res, response.status, json);
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "GET") {
    // /order/<id> is a page, not a file. The id stays in the URL so the buyer
    // can come back to it — the only way back, until pay links carry a
    // return_url the payer's browser can follow home.
    if (/^\/order\/[A-Za-z0-9_]+$/.test(url.pathname)) {
      req.url = "/order.html";
    }
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("[server] unhandled request error", error);
    if (res.headersSent) res.end();
    else sendJson(res, 500, { ok: false, error: "internal error" });
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("Givro Enterprise pay-link demo");
  console.log(`  open  http://127.0.0.1:${PORT}`);
  console.log(`  api   ${API_BASE}`);
  console.log(`  env   ${ENVIRONMENT}`);
  console.log(`  key   ${API_KEY ? "set" : "MISSING — set GIVRO_API_KEY in .env"}`);
  console.log(`  back  ${PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN}/order/<id>` : "no return_url (set GIVRO_PUBLIC_ORIGIN to a public https origin)"}`);
  console.log("");
});
