# givro-sdk

**License:** MIT  
**Package:** TypeScript / ESM SDK  
**Supported settlement VMs:** EVM, Tron, and Solana helpers  
**Status:** Mainnet pilot; production availability is determined by the Givro Portal configuration for each `vm` / `ecosystem`, `chainId`, and token.

TypeScript SDK for [Givro.Network](https://givro.to) — build identifier-routed crypto payment integrations. The current public rollout enables email and X handle flows; phone remains a typed integration target and must not be presented as live unless the active Portal configuration explicitly enables it. The SDK routes requests by `vm` / `ecosystem` (`"evm"`, `"tron"`, or `"solana"`) and forwards `chainId` to the quote service where applicable. The client library does not hard-code a single EVM network; actual production support is controlled by the Givro Portal deployment and its enabled chains/tokens.

## Network Scope

The current verified mainnet pilot is Base + Tron. The production-launch target
for the SDK and integrator surfaces is:

- Ethereum, Base, Arbitrum One, OP Mainnet (Optimism), Polygon PoS, BNB Smart
  Chain, and Avalanche C-Chain;
- Solana mainnet;
- Tron mainnet.

SDK support means the library can represent and prepare the relevant ecosystem
flow; it does not by itself mean a network is live. Integrators must use the
Portal's enabled network/token configuration and must not expose a target
network before its contract/program, quote, indexing, wallet, and complete
claim/cancel/refund lifecycle are production-approved. Native assets are
first-class per network; token support is an explicit per-network allowlist.

### Discover the active runtime registry

Use the public registry during onboarding or a controlled build/configuration
step to discover the Portal's active chains, assets, and advertised settlement
contracts:

```typescript
import { fetchPublicSupportedAssets } from "givro-sdk";

const runtime = await fetchPublicSupportedAssets("https://givro.to");
console.table(runtime.chains);
```

`attestedContract` is discovery material, not an automatic trust root. Review
the discovered address independently, then commit the approved value to your
application configuration and pass that pinned value through
`trustedAttestedContracts`. Never fetch the registry beside each quote and
dynamically trust an address returned by the same Portal that issued the quote.
The current public response does not include a Solana `programId`, so this
helper is not a Solana Program pin source. Obtain the Program ID through an
independent release channel, audit it, and pin it in `trustedSolanaPrograms`.
The registry's native-SOL marker is also not sufficient by itself to prove that
the quote, transaction builder, and deployed native-SOL instruction are aligned.
Wrapped SOL is an SPL token mint, not a substitute for the native-SOL marker.

## Install

```bash
npm install givro-sdk viem @solana/web3.js @solana/spl-token
# Required only when following the wagmi example below:
npm install wagmi @tanstack/react-query
```

The root package currently exports EVM and Solana helpers from one ESM entry,
so `viem`, `@solana/web3.js`, and `@solana/spl-token` are required peers even
when an application uses only one settlement VM.

## Quick start — EVM (viem / wagmi)

EVM native symbols are resolved together with `chainId` and fail closed: for
example, `ETH` is accepted on Base while `BNB` is accepted on BNB Smart Chain.
A missing chain ID or a symbol that belongs to another chain is rejected. Token
contracts and settlement contracts must come from independently reviewed,
chain-specific registries; settlement pins must be canonical non-zero `0x`
addresses.

```typescript
import { createGivroPayClient } from "givro-sdk";
import { sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { REVIEWED_HFI_CONTRACTS } from "./hfi-reviewed-deployments.js";

const client = createGivroPayClient({
  quoteUrl: "https://givro.to/api/intent/quote",
  trustedAttestedContracts: {
    "evm:8453": [REVIEWED_HFI_CONTRACTS.base],
  },
});

// Obtain a fresh token from the Turnstile widget immediately before quoting.
const turnstileToken = await getFreshTurnstileToken();

// 1. Get a consumer-browser quote (includes attested order fields)
const quote = await client.quoteSend({
  recipientKind: "email",
  recipient: "alice@example.com",
  amount: "10000000000000000", // base units string (0.01 ETH in wei)
  amountHuman: "0.01",
  token: "0x0000000000000000000000000000000000000000", // native ETH
  vm: "evm",
  chainId: 8453, // EVM chain ID enabled by your Givro Portal deployment
  turnstile: turnstileToken,
});

// 2. Build send transactions
const { approve, deposit } = client.prepareEvmTransactions({
  quote,
});

// 3. Send (wagmi helpers)
import { toWagmiSendParams } from "givro-sdk";

if (approve) {
  const approveTx = await sendTransaction(wagmiConfig, toWagmiSendParams(approve));
  await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });
}
const depositTx = await sendTransaction(wagmiConfig, toWagmiSendParams(deposit));
await waitForTransactionReceipt(wagmiConfig, { hash: depositTx });
```

### ERC-20 token

Same flow — `approve` will be non-null when the token is not native and grants
the exact deposit amount by default:

```typescript
const quote = await client.quoteSend({
  recipientKind: "email",
  recipient: "alice@example.com",
  amount: "50000000", // base units string (e.g. 50 USDC with 6 decimals)
  amountHuman: "50",
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // example ERC-20 token address
  vm: "evm",
  chainId: 8453,
  turnstile: await getFreshTurnstileToken(),
});
const { approve, deposit } = client.prepareEvmTransactions({
  quote,
});
// approve.to = token contract, deposit.to = attested/deposit contract from quote
```

For `recipientKind: "x"`, the sender must also be signed in with X. Supply the
current sender session as `X-X-Session` through `defaultHeaders`. Do not place an
enterprise API key on this endpoint: production consumer quotes reject
`X-API-Key`; server-side enterprise integrations use the Payment Links API.
Turnstile tokens are single-use: the SDK disables automatic HTTP retry whenever
`turnstile` is present. After a failed consumer quote, obtain a fresh Turnstile
token and let the user retry; never replay the previous request token.

## Quick start — Tron

The SDK exposes Tron quote normalization and the order tuple needed by TronWeb
to call `GivroPayAttested.depositNativeWithOrder` or
`depositErc20WithOrder`. The following covers both TRX and TRC-20 funding,
including exact approval and mined-receipt confirmation.

```typescript
import {
  createGivroPayClient,
  GIVRO_PAY_ATTESTED_ABI_TRON,
  TRON_ATTESTED_ZERO_RELAY,
  toBaseUnits,
} from "givro-sdk";
import { REVIEWED_HFI_CONTRACTS } from "./hfi-reviewed-deployments.js";

const client = createGivroPayClient({
  quoteUrl: "https://givro.to/api/intent/quote",
  portalBaseUrl: "https://givro.to",
  trustedAttestedContracts: {
    "tron:728126428": [REVIEWED_HFI_CONTRACTS.tron],
  },
});

const tronWeb = window.tronWeb;
if (!tronWeb?.defaultAddress?.base58) throw new Error("Connect TronLink first");

function toTronBase58(address: string): string {
  if (address === "native") address = "0x" + "0".repeat(40);
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

  // Native TRX is returned as the canonical Solidity ABI zero address.
  const quotedOrder = client.tronAttestedOrderTuple(quote);
  const order = { ...quotedOrder, token: toTronBase58(quotedOrder.token) };
  const settlementBase58 = toTronBase58(quote.attestedContract!);
  const originRelay = toTronBase58(TRON_ATTESTED_ZERO_RELAY);
  const settlement = await tronWeb.contract(GIVRO_PAY_ATTESTED_ABI_TRON, settlementBase58);

  let fundingTxId: string;
  if (quote.token === "native") {
    fundingTxId = await settlement
      .depositNativeWithOrder(order, originRelay)
      .send({ callValue: order.amount, feeLimit: 150_000_000 });
  } else {
    const tokenBase58 = toTronBase58(quote.token);
    const token = await tronWeb.contract().at(tokenBase58);
    const owner = tronWeb.defaultAddress.base58;
    const required = BigInt(order.amount);
    const allowance = BigInt(String(await token.allowance(owner, settlementBase58).call()));
    if (allowance !== required) {
      // USDT-style tokens may reject a non-zero -> non-zero allowance change.
      if (allowance > 0n) {
        const resetTxId = await token.approve(settlementBase58, "0")
          .send({ feeLimit: 100_000_000 });
        await waitForTronConfirmation(resetTxId);
      }
      const approveTxId = await token.approve(settlementBase58, order.amount)
        .send({ feeLimit: 100_000_000 }); // exact amount, never unlimited
      await waitForTronConfirmation(approveTxId);
    }
    fundingTxId = await settlement
      .depositErc20WithOrder(order, originRelay)
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

## Solana Status

Solana is part of the production-launch target. Solana SDK helpers are retained
in the package and use the same `vm` / `ecosystem` routing model. Treat Solana
production availability as a Portal configuration question: do not present
Solana as live for a deployment unless that Portal has enabled and verified the
Solana program, mint registry, quote, wallet, indexing, and lifecycle support.
The following example is for a local development Portal only.

```typescript
import { createGivroPayClient } from "givro-sdk";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { REVIEWED_HFI_PROGRAMS } from "./hfi-reviewed-deployments.js";

const client = createGivroPayClient({
  quoteUrl: "http://localhost:3100/api/intent/quote",
  trustedSolanaPrograms: {
    devnet: [REVIEWED_HFI_PROGRAMS.devnet],
  },
});

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

const quote = await client.quoteSend({
  recipientKind: "email",
  recipient: "bob@example.com",
  amount: "5000000",
  amountHuman: "5",
  token: "<USDC-MINT-ADDRESS>",
  ecosystem: "solana",
  turnstile: await getFreshTurnstileToken(),
});

// wallet = Solana wallet adapter (e.g. @solana/wallet-adapter-react useWallet())
const tx = await client.prepareSolanaTransaction(connection, {
  quote,
  payer: wallet.publicKey,
  cluster: "devnet",
});
const signature = await wallet.sendTransaction(tx, connection);

console.log("Solana signature:", signature);
```

Before signing any transaction returned by
`POST /api/intent/build-solana-tx`, decode it locally and verify the pinned
Program ID, payer, mint/native marker, exact amount, every account's signer and
writable flags, every instruction, and the absence of unexpected instructions.
An unsigned transaction is not inherently safe: the same Portal that created
the quote must not be the sole authority for what the wallet signs.

## Claim, cancel, and refund safety boundary

For eligible payments, the quote and funding transaction commit the claim,
cancel, and unclaimed-refund timing together with the authorized destination.
The application must display and verify those exact values before signing; it
must not assume that every payment is cancellable or refundable. Network fees,
unsupported assets, incorrect user inputs, contract defects, and wallet or
network failures can still cause loss.

When the active contract exposes sender cancellation, use `quote.paymentRef`
and the contract-specific cancel method only within the committed window. Do
not hard-code a five- or ten-minute window in an integration.

## Client config

```typescript
const client = createGivroPayClient({
  quoteUrl: "https://givro.to/api/intent/quote",
  timeoutMs: 10_000,          // request timeout (default 10s)
  retry: { maxAttempts: 3, baseDelayMs: 400 },  // non-Turnstile requests only
  defaultHeaders: { "X-My-App": "v1" },
  fetchImpl: globalThis.fetch, // custom fetch (e.g. node-fetch in Node 16)
  trustedAttestedContracts: {
    "evm:8453": [REVIEWED_HFI_CONTRACTS.base],
    "tron:728126428": [REVIEWED_HFI_CONTRACTS.tron],
  },
});
```

### `prepareEvmTransactions` behavior

- **Attested quote required** (`attestedContract + attestedOrder`): SDK builds `deposit*WithOrder` tx and uses `attestedContract` as spender for ERC-20 approve.
- **Exact allowance by default**: ERC-20 approval is limited to the quoted deposit amount; the SDK does not request an unlimited allowance.
- **Pinned deployment required**: the quote contract must appear in `trustedAttestedContracts` for the quote ecosystem and chain.
- **Legacy/basic quote**: `prepareEvmTransactions` rejects it. The package root does not export a legacy funding builder because it cannot enforce the configured deployment trust root.

### Amount units (important)

`quoteSend({ amount })` expects a **base-unit string**:

- ETH: wei (`1 ETH = 10^18 wei`)
- USDC: 6 decimals (`1 USDC = 10^6`)

```typescript
import { toBaseUnits } from "givro-sdk";

const amountWei = toBaseUnits("0.01", 18); // ETH
const amountUsdc = toBaseUnits("50", 6);   // USDC
```

## Key exports

| Export | Description |
|---|---|
| `createGivroPayClient(config)` | Create a client instance |
| `GivroPayClient` | Client class |
| `fetchPaymentQuote(url, body, opts)` | Low-level quote fetch |
| `fetchPublicSupportedAssets(portalBaseUrl, opts)` | Typed runtime chain/token/contract discovery for onboarding and review |
| `isNativeEvmToken(address)` | True for 0x000… / 0xeee… |
| `toWagmiSendParams(tx)` | Convert tx to wagmi sendTransaction args |
| `toWagmiSendSequence({ approve, deposit })` | Returns the ordered wagmi transaction array |
| `client.prepareSolanaTransaction(connection, params)` | Validate a pinned Program and build a Solana transaction |
| `signAndSendSolanaAttestedDeposit(wallet, connection, params)` | Build and send from independently reviewed Solana parameters |
| `waitForSolanaConfirmation(connection, signature, timeoutMs?)` | Wait for confirmed/finalized Solana status |
| `normalizeRecipient(kind, value)` | Normalize email / x / phone |
| `GivroPayError`, `GivroPayNetworkError`, etc. | Typed error classes |
| `getNetwork(name)` | Get network config (devnet / mainnet) |

## Error handling

```typescript
import { GivroPayError, GivroPayNetworkError, GivroPayQuoteError } from "givro-sdk";

try {
  const quote = await client.quoteSend({ ... });
} catch (e) {
  if (e instanceof GivroPayQuoteError) {
    console.error("Quote failed:", e.code, e.message);
  } else if (e instanceof GivroPayNetworkError) {
    console.error("HTTP error:", e.statusCode, e.message);
  } else if (e instanceof GivroPayError) {
    console.error("Givro error:", e.code, e.message);
  }
}
```

## Build

```bash
npm run build   # outputs to dist/
```

## License

MIT
