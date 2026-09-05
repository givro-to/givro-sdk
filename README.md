# givro-sdk

**License:** MIT  
**Package:** TypeScript / ESM SDK  
**Supported settlement VMs:** EVM and Tron  
**Status:** Mainnet. Which chains and tokens are live is decided by the Givro Portal configuration for each `vm` / `ecosystem`, `chainId`, and token, never by this library.

TypeScript SDK for [Givro](https://givro.to) — build identifier-routed crypto payment integrations. A sender pays an email address, an X handle, or a Givro ID; the recipient claims from any wallet, and after their first receipt every later payment settles to them unattended. The SDK routes requests by `vm` / `ecosystem` (`"evm"` or `"tron"`) and forwards `chainId` to the quote service. Phone remains a typed identifier kind and must not be presented as live unless the active Portal explicitly enables it.

## Network Scope

Production today serves Base, BNB Smart Chain, and Tron mainnet: the native asset plus USDC and USDT on each EVM chain, and TRX plus USDT on Tron. The enterprise `test` environment settles on Sepolia and Tron Nile.

SDK support means the library can represent and prepare a chain's funding flow; it does not by itself mean a network is live. Read the Portal's enabled network/token configuration and do not expose a chain before it appears there. Native assets are first-class per network; token support is an explicit per-network allowlist.

### Discover the active runtime registry

Use the public registry during onboarding or a controlled build/configuration step to discover the Portal's active chains, assets, and the settlement escrow it publishes for each:

```typescript
import { fetchPublicSupportedAssets } from "givro-sdk";

const runtime = await fetchPublicSupportedAssets("https://givro.to");
console.table(runtime.chains);
```

`attestedContract` is the settlement escrow for that chain. It is discovery material, not an automatic trust root: review the discovered address independently, then commit the approved value to your application configuration and pass that pinned value through `trustedAttestedContracts`. Never fetch the registry beside each quote and dynamically trust an address returned by the same Portal that issued the quote.

## How a payment settles

A quote carries the eleven-field order the escrow stores and the escrow it must be funded into. The order's `blindedBinding` is derived fresh for each intent, so no two payments to the same recipient share an on-chain tag, and the escrow rejects a binding it has already seen.

```typescript
const quote = coercePaymentQuote(raw);
quote.attestedContract; // the escrow, canonical non-zero 0x address (EVM and Tron)
quote.mandateCommit;    // zero on a first receipt; otherwise the recipient's payout mandate commitment
quote.order;            // { chainId, paymentRef, intentId, blindedBinding, bindingEpoch, claimAuthorization, token, amount, cancelBefore, claimBefore, refundAfter }
```

Deposit, cancel and refund are plain escrow calls. Claims are not built by the SDK: the escrow resolves no recipient on its own, so a claim carries either the recipient's signature over `INTENT_CLAIM_TYPES` or a ZK proof, both produced per payment and orchestrated by the Portal's claim endpoints. After the first claim the recipient's payout mandate is on chain, and the Portal's relayer settles later payments without the recipient's involvement.

## Install

```bash
npm install givro-sdk viem
# Required only when following the wagmi example below:
npm install wagmi @tanstack/react-query
```

`viem` is the only required peer dependency.

## Enterprise server integration

`GivroEnterpriseClient` is for a merchant's server only. It creates hosted
Payment Links with an Enterprise API key; it never signs a user's wallet
transaction or takes custody of funds. Do not import it into a browser bundle.

```typescript
import { createGivroEnterpriseClient } from "givro-sdk";

const enterprise = createGivroEnterpriseClient({
  apiKey: process.env.GIVRO_LIVE_API_KEY!,
});

const link = await enterprise.createAndEmailPaymentLink({
  payer_email: "customer@example.com",
  recipient: "merchant@example.com",
  recipient_kind: "email",
  amount: "10.00",
  ecosystem: "evm",
  chainId: 8453,
  token_symbol: "USDC",
  settlement_mode: "mainnet",
  merchant_ref: "invoice_1001",
  return_url: "https://shop.example.com/order/invoice_1001",
}, "invoice_1001");

// Persist link.payment_link_id and reconcile final settlement from signed webhooks.
console.log(link.pay_url);
```

Every create method requires an explicit idempotency key. Reuse it only for an
identical request body. Test keys create simulated Payment Links; live keys
create mainnet links. The server is authoritative for the key's environment,
enabled chain/token pairs, and payment-link fields.

`recipient_kind` is `email`, `x`, or `givro_id`. A **Givro ID** is the name
behind `givro.to/@acme.sales` — an identifier Givro issued to one business
line. It has no mailbox of its own, which is the point: one verified email can
run several collection identities, each settling to its own wallets.

Denominate the link either by `token_symbol`, which Givro resolves against the
chain's registry, or by `token_address` — exactly one. A chain whose registry
does not carry the symbol is reachable only by address.

```typescript
await enterprise.createPaymentLink({
  recipient: "acme.sales",
  recipient_kind: "givro_id",
  amount: "10.00",
  ecosystem: "evm",
  chainId: 8453,
  token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
}, "invoice_1002");
```

Verify inbound webhooks with the same helper the demo uses — do not hand-roll
the HMAC. The portal signs `HMAC-SHA256(secret, "<t>.<raw body>")` and sends
`Givro-Signature: t=<unix-seconds>,v1=<hex>` (the `v1=` tag names the HMAC
scheme, as in Stripe's header):

```typescript
import { verifyEnterpriseWebhookSignature } from "givro-sdk";

if (!verifyEnterpriseWebhookSignature({
  secret: process.env.GIVRO_WEBHOOK_SECRET!,
  header: req.headers["givro-signature"] ?? "",
  rawBody,
})) {
  throw new Error("invalid Givro-Signature");
}
```

`getSupportedAssets()` returns the key's environment: EVM rows in `chains`,
Tron rows in `tron_networks`. Do not treat `chains` as the full catalog.

A worked example is in `examples/enterprise-pay-link-demo` — a merchant
checkout built on this client, with an end-to-end suite that runs it against a
live portal.

## Quick start — EVM (viem / wagmi)

EVM native symbols are resolved together with `chainId` and fail closed: for
example, `ETH` is accepted on Base while `BNB` is accepted on BNB Smart Chain.
A missing chain ID or a symbol that belongs to another chain is rejected. Token
contracts and settlement escrows must come from independently reviewed,
chain-specific registries; settlement pins must be canonical non-zero `0x`
addresses.

```typescript
import { createGivroPayClient, toWagmiSendParams } from "givro-sdk";
import { sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { REVIEWED_ESCROWS } from "./givro-reviewed-deployments.js";

const client = createGivroPayClient({
  quoteUrl: "https://givro.to/api/intent/quote",
  trustedAttestedContracts: {
    "evm:8453": [REVIEWED_ESCROWS.base],
    "evm:56": [REVIEWED_ESCROWS.bsc],
  },
});

// Obtain a fresh token from the Turnstile widget immediately before quoting.
const turnstileToken = await getFreshTurnstileToken();

// 1. Get a consumer-browser quote
const quote = await client.quoteSend({
  recipientKind: "email",
  recipient: "alice@example.com",
  amount: "10000000000000000", // base units string (0.01 ETH in wei)
  amountHuman: "0.01",
  token: "0x0000000000000000000000000000000000000000", // native ETH
  vm: "evm",
  chainId: 8453,
  turnstile: turnstileToken,
});

// 2. Build the funding transactions (approve is null for a native asset)
const { approve, deposit } = client.prepareEvmTransactions({ quote });

// 3. Send (wagmi helpers)
if (approve) {
  const approveTx = await sendTransaction(wagmiConfig, toWagmiSendParams(approve));
  await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });
}
const depositTx = await sendTransaction(wagmiConfig, toWagmiSendParams(deposit));
await waitForTransactionReceipt(wagmiConfig, { hash: depositTx });
```

### ERC-20 token

Same flow — `approve` is non-null when the token is not native and grants
the exact deposit amount by default:

```typescript
const quote = await client.quoteSend({
  recipientKind: "email",
  recipient: "alice@example.com",
  amount: "50000000", // base units string (50 USDC with 6 decimals)
  amountHuman: "50",
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  vm: "evm",
  chainId: 8453,
  turnstile: await getFreshTurnstileToken(),
});
const { approve, deposit } = client.prepareEvmTransactions({ quote });
// approve.to = token contract, deposit.to = the pinned escrow
```

For `recipientKind: "x"`, the sender must also be signed in with X. Supply the
current sender session as `X-X-Session` through `defaultHeaders`. Do not place an
enterprise API key on this endpoint: production consumer quotes reject
`X-API-Key`; server-side enterprise integrations use the Payment Links API.
Turnstile tokens are single-use: the SDK disables automatic HTTP retry whenever
`turnstile` is present. After a failed consumer quote, obtain a fresh Turnstile
token and let the user retry; never replay the previous request token.

To pick the builder yourself, use `buildEvmDepositFromQuote`, which requires the
escrow you pinned and refuses a quote that names a different one. `buildEvmCancelTx`
and `buildEvmRefundTx` build the payer-side cancel (inside the cancel window) and the
permissionless refund (after `refundAfter`).

## Quick start — Tron

The Tron escrow runs the same bytecode as the EVM escrow, so the SDK exposes the
same ABI and the order tuple TronWeb needs to call `depositNativeWithOrder` or
`depositErc20WithOrder`. The following covers both TRX and TRC-20 funding,
including exact approval and mined-receipt confirmation.

```typescript
import {
  createGivroPayClient,
  GIVRO_PAY_ESCROW_ABI_TRON,
  toBaseUnits,
} from "givro-sdk";
import { REVIEWED_ESCROWS } from "./givro-reviewed-deployments.js";

const client = createGivroPayClient({
  quoteUrl: "https://givro.to/api/intent/quote",
  portalBaseUrl: "https://givro.to",
  trustedAttestedContracts: {
    "tron:728126428": [REVIEWED_ESCROWS.tron],
  },
});

const tronWeb = window.tronWeb;
if (!tronWeb?.defaultAddress?.base58) throw new Error("Connect TronLink first");

function toTronBase58(address: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return tronWeb.address.fromHex("41" + address.slice(2));
  }
  if (/^41[0-9a-fA-F]{40}$/.test(address)) {
    return tronWeb.address.fromHex(address);
  }
  return address; // already base58
}

async function waitForTronConfirmation(txId: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const info = await tronWeb.trx.getTransactionInfo(txId);
    if (info?.receipt?.result === "SUCCESS") return info;
    if (info?.receipt?.result && info.receipt.result !== "SUCCESS") {
      throw new Error(`Tron transaction failed: ${txId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for Tron confirmation: ${txId}`);
}

async function sendTron(params: {
  token: "TRX" | string; // TRX alias, or reviewed TRC-20 base58 contract
  amountRaw: string;
  amountHuman: string;
}) {
  const quote = await client.quoteSend({
    recipientKind: "email",
    recipient: "alice@example.com",
    amount: params.amountRaw,
    amountHuman: params.amountHuman,
    token: params.token,
    vm: "tron",
    chainId: 728126428,
    turnstile: await getFreshTurnstileToken(),
  });

  // Native TRX is returned as the Solidity ABI zero address in the tuple.
  const call = client.tronDepositCall(quote);
  const order = { ...call.order, token: toTronBase58(call.order.token) };
  const escrowBase58 = toTronBase58(call.escrow);
  const escrow = await tronWeb.contract(GIVRO_PAY_ESCROW_ABI_TRON, escrowBase58);

  let fundingTxId: string;
  if (call.functionName === "depositNativeWithOrder") {
    fundingTxId = await escrow
      .depositNativeWithOrder(order, call.mandateCommit)
      .send({ callValue: call.callValue, feeLimit: 150_000_000 });
  } else {
    const token = await tronWeb.contract().at(toTronBase58(quote.token));
    const owner = tronWeb.defaultAddress.base58;
    const required = BigInt(order.amount);
    const allowance = BigInt(String(await token.allowance(owner, escrowBase58).call()));
    if (allowance !== required) {
      // USDT-style tokens may reject a non-zero -> non-zero allowance change.
      if (allowance > 0n) {
        const resetTxId = await token.approve(escrowBase58, "0")
          .send({ feeLimit: 100_000_000 });
        await waitForTronConfirmation(resetTxId);
      }
      const approveTxId = await token.approve(escrowBase58, order.amount)
        .send({ feeLimit: 100_000_000 }); // exact amount, never unlimited
      await waitForTronConfirmation(approveTxId);
    }
    fundingTxId = await escrow
      .depositErc20WithOrder(order, call.mandateCommit)
      .send({ feeLimit: 150_000_000 });
  }
  await waitForTronConfirmation(fundingTxId);
  return { fundingTxId, claimUrl: `https://givro.to/claim?ref=${quote.paymentRef}` };
}

await sendTron({ token: "TRX", amountRaw: toBaseUnits("1", 6), amountHuman: "1" });
await sendTron({
  token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  amountRaw: toBaseUnits("10", 6),
  amountHuman: "10",
});
```

## Solana

The Portal does not serve Solana, and the SDK ships no Solana funding path.
`fetchPublicSupportedAssets` still parses a Solana registry entry if a Portal
ever publishes one, but that entry alone does not make Solana fundable.

## Development

```bash
npm install
npm test          # hermetic unit tests
npm run typecheck
npm run build

# Against a running local stack (deploy/local in the main repository):
GIVRO_E2E_PORTAL_URL=http://127.0.0.1:3100 \
GIVRO_E2E_RPC_URL=http://127.0.0.1:8545 \
GIVRO_E2E_CHAIN_ID=31338 npm run test:e2e
```
