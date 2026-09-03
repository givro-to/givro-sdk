# Enterprise Pay Link Demo (merchant checkout)

A small storefront that takes an order, sends the buyer to Givro to pay, and
lets the **webhook** — not the browser — decide when the order is paid.

```
  [ storefront ]  buyer picks items, presses Pay
        |
        |  POST /api/orders          order created locally, status=awaiting_payment
        |  POST /api/payment-links   merchant_ref = the order id
        v
  [ pay page ]    givro.to/pay/business/epr_...      (opens in its own tab)
        |                                            buyer pays with their wallet
        |  POST /webhook  payment.funded → payment.claimed   (signed)
        v
  [ order page ]  /order/<id>   polls, flips to Paid when the webhook lands
```

The join between the two systems is one field: **`merchant_ref`**. The merchant
puts its own order id there at creation, and every webhook arrives carrying it.

**The browser is never the source of truth.** A buyer who closes the tab, loses
their connection, or never comes back is still a buyer who paid — the webhook
says so and the order updates regardless. `return_url` (below) is a courtesy for
the buyer who *does* come back, not a signal that anything was paid.

---

## A. Register an Enterprise account and create an API key

1. Open the production portal: **https://givro.to/enterprise**
2. **Register**
   - Fill in the organization name + your email
   - Send the OTP → get the code from your inbox → Verify
3. Sign in and open the Dashboard.
4. Open the **API Keys** tab:
   - **Pick the `test` environment first** (recommended; `live` keys may need owner dual approval)
   - Any label works, e.g. `pay-link-demo`
   - Scopes must include at least `payments:write` and `payments:read`
   - The full key (`gvr_test_...` or `gvr_live_...`) is **shown only once** after creation → copy and store it immediately
5. Open the **Webhooks** tab and add an endpoint pointing at this demo's
   `POST /webhook`. **Required** — without it nothing ever moves an order off
   `awaiting_payment`. Copy the signing secret (`whsec_...`) it gives you.

   Givro only delivers to a **public `https://` endpoint on port 443** — no
   localhost, no private IPs. While developing, put a tunnel in front:

   ```bash
   ngrok http 3847
   ```

   Register `https://<your-tunnel>/webhook` as the endpoint, and set the same
   origin as `GIVRO_PUBLIC_ORIGIN` in `.env` so pay links can carry a
   `return_url` back to the order page.

### Related HTTP calls (the Dashboard uses a session internally; registering through the page is enough)

| Step | Method | Path |
|------|--------|------|
| Send registration OTP | POST | `/api/enterprise/register/start` `{ name, email }` |
| Verify registration | POST | `/api/enterprise/register/verify` `{ name, email, code }` |
| Create API key | POST | `/api/enterprise/api-keys` (needs login cookie + `X-HFI-CSRF: 1`) |

Server-side call this demo makes (through `givro-sdk`, not raw `fetch`):

```javascript
await givro.createPaymentLink({
  recipient: "merchant@example.com",
  recipient_kind: "email",          // email | x | givro_id
  amount: "1.00",
  ecosystem: "evm",
  chainId: 84532,                   // camelCase — the portal also accepts chain_id
  token_symbol: "ETH",              // or token_address, exactly one
  fee_payer: "payer",
  merchant_ref: "invoice_1001",
  return_url: "https://shop.example.com/order/invoice_1001",
  message: "Demo invoice",
}, "invoice_1001_v1");
```

The token is `token_symbol` (resolved by Givro for the chain) or `token_address` (an exact contract). Provide either one; the address wins when both are present. The environment comes from the API key, so no `environment` field is needed in the body. The portal accepts `recipient_identifier` / `chain_id` as aliases; the SDK types the canonical `recipient` / `chainId`.

A successful response includes:

- `payment_link` / `payment_link_id`
- `pay_url` ← give this to the payer

To have Givro email the payer instead, use:

`POST /api/payment-links/email` (extra field `payer_email`).

---

## B. Run this demo

The demo calls the Enterprise API through `givro-sdk` (the package it ships
inside), so the SDK has to be built first:

```bash
cd ../..            # givro-sdk root
npm install && npm run build

cd examples/enterprise-pay-link-demo
npm install         # links givro-sdk from ../..
cp .env.example .env
# Edit .env: set GIVRO_API_KEY, the receiving identity, and a default
# ecosystem/pinned asset. The demo itself does not ask the buyer to choose a
# chain or token; it declares `accepted_assets` and Givro's hosted pay page
# presents the actual choice.
npm start
# Open http://127.0.0.1:3847 in a browser
```

### `.env` essentials

| Variable | Description |
|----------|-------------|
| `GIVRO_API_KEY` | Enterprise API key (required) |
| `GIVRO_API_BASE` | Defaults to `https://givro.to` |
| `GIVRO_ENVIRONMENT` | `test` or `live`, must match the key |
| `GIVRO_RECIPIENT_KIND` | `email`, `givro_id`, or `x` |
| `GIVRO_RECIPIENT_IDENTIFIER` | Recipient email / Givro ID / X handle (on-chain claims bind to this identity) |
| `GIVRO_CHAIN_ID` | One pinned chain for link creation. It must match the API-key environment and should be one of the accepted stablecoin options on the same ecosystem |
| `GIVRO_TOKEN_SYMBOL` / `GIVRO_TOKEN_ADDRESS` | One pinned asset for link creation. The demo uses it only as the link's lead asset; the hosted Givro pay page offers the full same-ecosystem `accepted_assets` set |
| `GIVRO_FEE_PAYER` | `payer` or `merchant` |
| `GIVRO_WEBHOOK_SECRET` | `whsec_...` from Dashboard → Webhooks. **Required** for orders to update; without it the demo logs events but marks them unverified |
| `GIVRO_PUBLIC_ORIGIN` | Public https origin this demo is reachable on (your tunnel URL). Used to build each pay link's `return_url`. Empty, `http://`, or an unparseable value are ignored — the order still creates, the link simply carries no return URL |

**Notes:**

- The key environment and `chain_id` must match (a test key cannot use a live Base mainnet asset config, and vice versa). Mismatching them is refused with `environment_chain_mismatch`.
- One link cannot mix EVM and Tron accepted assets. `accepted_assets` must stay inside the link's own ecosystem, so an EVM-pinned link can offer Base/BSC stablecoins, while a Tron-pinned link can offer Tron stablecoins.
- `recipient_kind` may be `email`, `x`, or `givro_id`. A **Givro ID** is the name behind `givro.to/@acme.sales`; it has no mailbox of its own, which is what lets one verified email run several collection identities, each settling to its own wallets.
- If creating a live key returns `approval_required`, finish the approval in the Dashboard before creating it.
- The payer funds a Pay Link with on-chain assets **signed by their own wallet**; Givro never holds funds or debits anyone.

---

## C. Using the demo

1. Open `http://127.0.0.1:3847`. Pick some items — prices are computed on the
   server, never taken from the browser.
2. Press **Pay**. The pay page opens in a new tab; this tab becomes
   `/order/<id>` and starts polling.
3. Pay on the Givro page (or, with a test key, press one of the **sandbox
   scenario** buttons at the bottom of the order page to drive the lifecycle
   without a wallet).
4. Watch the order page flip to **Paid** on its own. The event timeline below it
   is the webhooks arriving.

Scenario buttons and the events each one produces:

| scenario | events |
|---|---|
| `success` | `payment.funded` → `payment.claimed` |
| `failure` | `payment.failed`; the link stays payable, so the order stays `awaiting_payment` and the buyer can retry |
| `cancelled` | `payment.cancelled` |
| `unclaimed_refund` | `payment.funded` → `payment.expired` → `payment.refund_pending` → `payment.refunded` |

Each link allows 20 simulation attempts.

### What the webhook receiver does

`POST /webhook` in `server.mjs` is a full worked example, not a stub:

- **Verifies `Givro-Signature` through `verifyEnterpriseWebhookSignature`**
  (`t=<unix>,v1=<hex>` of `HMAC-SHA256(secret, "<t>.<raw body>")`) against the
  raw body, inside a ±300-second window, before trusting a single field. The
  helper lives in `givro-sdk` so this demo cannot drift from the algorithm the
  portal actually signs.
- **Reconciles idempotently by event id.** Givro retries until it gets a 2xx, so
  the same event arrives more than once as a matter of course. Applying it twice
  is the merchant's bug, not Givro's.
- **Never walks an order backwards.** Statuses are ranked, so a `funded` that
  overtakes a `claimed` in flight cannot un-pay the order.
- **Answers 200 quickly.** Anything else and the event is redelivered on the
  retry schedule.

### Where the payment fields live in the payload

The delivered body wraps the event's own identity around a `data` object:

```jsonc
{
  "id": "evt_...",              // event identity — top level
  "type": "payment.claimed",
  "created_at": 1788382591,
  "object_id": "epr_test_...",
  "data": {                     // everything about the payment link
    "payment_link_id": "epr_test_...",
    "merchant_ref": "ord_...",  // ← your order id
    "current_status": "paid",   // sandbox simulation sets this
    "payment_link": { "status": "paid" }  // live settlement sets this
  }
}
```

Reading `payment_link_id` or `current_status` off the top level silently yields
`undefined`, and an order that never updates. Live settlement events omit
`current_status`; take `data.payment_link.status` or map `payload.type`.

## C2. Sending the buyer back (`return_url`)

Pay links accept an optional `return_url`. The pay page renders it as a button
the buyer chooses to press — showing the host it leads to — once the link
reaches a terminal state:

```json
{ "return_url": "https://shop.example.com/order/ord_123" }
```

It must be an absolute `https://` URL, at most 2048 characters, with no embedded
credentials; anything else is refused with `invalid_request`. It is deliberately
**not** an automatic redirect: a pay page that navigated on its own would be an
open redirector wearing Givro's domain, and would push the buyer off a
settlement record they may still want to read.

Treat it as navigation only. A browser arriving at your `return_url` proves that
a browser arrived — nothing about whether money moved. The webhook is the only
account of that, which is why this demo's order page shows the status the
webhook set rather than anything the returning URL claims.

---

## D. Files

| File | Purpose |
|------|---------|
| `server.mjs` | The merchant: catalog, order store, `GivroEnterpriseClient` calls, and the signed webhook receiver (the key never reaches the browser) |
| `public/index.html` | Storefront and checkout |
| `public/order.html` | Order status page — polls, and shows the webhook timeline |
| `.env.example` | Environment variable template |

Orders live in memory, so a server restart clears them. A real merchant puts
them in its own database; nothing else about the flow changes.

Its only application dependency is `givro-sdk` itself, resolved from `../..`.
Build the SDK first (`npm install && npm run build` at the package root): the
root barrel currently loads EVM/Solana helpers, so those peer packages must
be installed there even though this demo never calls them. Node 18+ after that.

---

## E. End-to-end test

`tests/e2e/enterprisePayLink.e2e.test.ts` in the SDK repo spawns this demo as
its own process and drives it against a running portal: it creates pay links,
fetches each one back the way a payer's browser resolves it, and checks
idempotency and error passthrough. It skips unless the environment is set.

```bash
# 1. seed an organization and a test API key in the local portal
docker exec hfi-api-local npx tsx /app/scripts/seed-enterprise-api-key.ts

# 2. run with the key it printed
cd ../..
GIVRO_E2E_PORTAL_URL=http://127.0.0.1:3001 \
GIVRO_E2E_ENTERPRISE_API_KEY=gvr_test_… \
GIVRO_E2E_CHAIN_ID=31338 \
GIVRO_E2E_TOKEN_ADDRESS=0xbded0d2bf404bdcba897a74e6657f1f12e5c6fb6 \
npx vitest run tests/e2e/enterprisePayLink.e2e.test.ts
```

`GIVRO_E2E_TOKEN_ADDRESS` is optional; without it the suite asks for `USDC` by
symbol instead. The demo's own `.env` is ignored — the suite sets every variable
explicitly, so a `.env` holding a production key is never used.
