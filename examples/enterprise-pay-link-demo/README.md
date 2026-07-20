# Enterprise Pay Link Demo (minimal merchant checkout)

Simulates: a merchant site clicks **Pay** → calls the Givro Enterprise API to create a **Pay Link** → the payer opens the link → pays on Givro with their own wallet.

```
Merchant demo (this app)
  → POST /api/payment-links  (X-API-Key)
  → pay_url  (https://givro.to/send?...&paymentRequestId=...)
  → Payer opens link, connects wallet, funds payment
```

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
5. (Optional) Configure a webhook for events like `payment.funded` / `payment.claimed`; this demo does not depend on webhooks.

### Related HTTP calls (the Dashboard uses a session internally; registering through the page is enough)

| Step | Method | Path |
|------|--------|------|
| Send registration OTP | POST | `/api/enterprise/register/start` `{ name, email }` |
| Verify registration | POST | `/api/enterprise/register/verify` `{ name, email, code }` |
| Create API key | POST | `/api/enterprise/api-keys` (needs login cookie + `X-HFI-CSRF: 1`) |

Server-side API call (used by this demo):

```http
POST https://givro.to/api/payment-links
X-API-Key: gvr_test_...
Idempotency-Key: <unique-per-business-attempt>
Content-Type: application/json
```

```json
{
  "recipient_kind": "email",
  "recipient_identifier": "merchant@example.com",
  "amount": "1.00",
  "ecosystem": "evm",
  "chain_id": 84532,
  "token_symbol": "ETH",
  "fee_payer": "payer",
  "merchant_ref": "invoice_1001",
  "message": "Demo invoice"
}
```

The token can be passed as `token_symbol` (e.g. `ETH` / `USDC`, resolved by Givro for the chain) or as `token_address` (an exact contract address). Provide either one; the address wins when both are present. The environment comes from the API key, so no `environment` field is needed in the body.

A successful response includes:

- `payment_link` / `payment_link_id`
- `pay_url` ← give this to the payer

To have Givro email the payer instead, use:

`POST /api/payment-links/email` (extra field `payer_email`).

---

## B. Run this demo

```bash
cd examples/enterprise-pay-link-demo
cp .env.example .env
# Edit .env: set GIVRO_API_KEY, the receiving email, chain/token, etc.
npm start
# Open http://127.0.0.1:3847 in a browser
```

### `.env` essentials

| Variable | Description |
|----------|-------------|
| `GIVRO_API_KEY` | Enterprise API key (required) |
| `GIVRO_API_BASE` | Defaults to `https://givro.to` |
| `GIVRO_ENVIRONMENT` | `test` or `live`, must match the key |
| `GIVRO_RECIPIENT_IDENTIFIER` | Recipient email / X handle (on-chain claims bind to this identity) |
| `GIVRO_CHAIN_ID` | Must match the key environment: test → 84532 (Base Sepolia), live → 8453 (Base) |
| `GIVRO_TOKEN_SYMBOL` / `GIVRO_TOKEN_ADDRESS` | Token symbol (e.g. `ETH`/`USDC`) or contract address; the address wins |
| `GIVRO_FEE_PAYER` | `payer` or `merchant` |

**Notes:**

- The key environment and `chain_id` must match (a test key cannot use a live Base mainnet asset config, and vice versa).
- If creating a live key returns `approval_required`, finish the approval in the Dashboard before creating it.
- The payer funds a Pay Link with on-chain assets **signed by their own wallet**; Givro never holds funds or debits anyone.

---

## C. Using the page

1. Confirm the badge shows `API key ready`.
2. Adjust the amount / recipient identity.
3. Click **Pay / Create Pay Link**.
4. Click **Open Pay Link** (or copy the `pay_url`).
5. On the Givro `/send` page, connect the wallet, confirm the parameters, and complete funding.

---

## D. Files

| File | Purpose |
|------|---------|
| `server.mjs` | Local HTTP: static page + proxy to the Enterprise API (the key never reaches the browser) |
| `public/index.html` | Simulated merchant checkout UI |
| `.env.example` | Environment variable template |

No third-party npm dependencies; Node 18+ is all you need.
