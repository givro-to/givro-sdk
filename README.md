# hfi-sdk

**License:** MIT  
**Package:** TypeScript / ESM SDK  
**Supported settlement VMs:** EVM, Tron, and Solana helpers  
**Status:** Mainnet pilot; production availability is determined by the HFI Portal configuration for each `vm` / `ecosystem`, `chainId`, and token.

TypeScript SDK for [HFI.Network](https://hfi.network) — send crypto to an email address, X handle, or phone number. The SDK routes requests by `vm` / `ecosystem` (`"evm"`, `"tron"`, or `"solana"`) and forwards `chainId` to the quote service where applicable. The client library does not hard-code a single EVM network; actual production support is controlled by the HFI Portal deployment and its enabled chains/tokens.

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

## Install

```bash
npm install hfi-sdk
# peer deps (install what you need)
npm install viem                         # EVM
npm install @solana/web3.js @solana/spl-token  # Optional: Solana helpers
```

## Quick start — EVM (viem / wagmi)

```typescript
import { createHfiPayClient } from "hfi-sdk";
import { sendTransaction, waitForTransactionReceipt } from "wagmi/actions";

const client = createHfiPayClient({
  quoteUrl: "https://hfi.network/api/intent/quote",
});

// 1. Get a quote (latest portal quote includes attested order fields)
const quote = await client.quoteSend({
  recipientKind: "email",
  recipient: "alice@example.com",
  amount: "10000000000000000", // base units string (0.01 ETH in wei)
  token: "0x0000000000000000000000000000000000000000", // native ETH
  vm: "evm",
  chainId: 8453, // EVM chain ID enabled by your HFI Portal deployment
});

// 2. Build send transactions
const { approve, deposit } = client.prepareEvmTransactions({
  quote,
});

// 3. Send (wagmi helpers)
import { toWagmiSendParams } from "hfi-sdk";

if (approve) {
  const approveTx = await sendTransaction(wagmiConfig, toWagmiSendParams(approve));
  await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });
}
const depositTx = await sendTransaction(wagmiConfig, toWagmiSendParams(deposit));
await waitForTransactionReceipt(wagmiConfig, { hash: depositTx });
```

### ERC-20 token

Same flow — `approve` will be non-null when the token is not native:

```typescript
const quote = await client.quoteSend({
  recipientKind: "x",
  recipient: "@alice",
  amount: "50000000", // base units string (e.g. 50 USDC with 6 decimals)
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // example ERC-20 token address
  vm: "evm",
  chainId: 8453,
});
const { approve, deposit } = client.prepareEvmTransactions({
  quote,
});
// approve.to = token contract, deposit.to = attested/deposit contract from quote
```

## Quick start — Tron

The SDK exposes Tron quote normalization and the order tuple needed by TronWeb to call `HfiPayAttested.depositNativeWithOrder` or `depositErc20WithOrder`.

```typescript
import { createHfiPayClient, toBaseUnits } from "hfi-sdk";

const client = createHfiPayClient({
  quoteUrl: "https://hfi.network/api/intent/quote",
  portalBaseUrl: "https://hfi.network",
});

const quote = await client.quoteSend({
  recipientKind: "email",
  recipient: "alice@example.com",
  amount: toBaseUnits("10", 6), // USDT raw amount
  amountHuman: "10",
  token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", // USDT on Tron mainnet
  vm: "tron",
  chainId: 728126428, // Tron mainnet chain id used by HFI portal
});

const orderTuple = client.tronAttestedOrderTuple(quote);
// Pass orderTuple to TronWeb contract.depositErc20WithOrder(...).
```

## Solana Status

Solana is part of the production-launch target. Solana SDK helpers are retained
in the package and use the same `vm` / `ecosystem` routing model. Treat Solana
production availability as a Portal configuration question: do not present
Solana as live for a deployment unless that Portal has enabled and verified the
Solana program, mint registry, quote, wallet, indexing, and lifecycle support.

```typescript
import { createHfiPayClient, signAndSendSolanaAttestedDeposit } from "hfi-sdk";
import { Connection, clusterApiUrl } from "@solana/web3.js";

const client = createHfiPayClient({
  quoteUrl: "https://hfi.network/api/intent/quote",
});

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

const quote = await client.quoteSend({
  recipientKind: "email",
  recipient: "bob@example.com",
  amount: "5",
  token: "<USDC-MINT-ADDRESS>",
  ecosystem: "solana",
});

// wallet = Solana wallet adapter (e.g. @solana/wallet-adapter-react useWallet())
const { signature } = await signAndSendSolanaAttestedDeposit(wallet, connection, {
  quote,
  payer: wallet.publicKey,
});

console.log("Solana signature:", signature);
```

## Safety guarantee

If the recipient never claims the payment, funds automatically return to the sender after 7 days. There is no way to lose money — worst case is a round-trip.

The sender also has a **5-minute cancel window** (300 seconds, configurable) after sending. Use `quote.paymentRef` to cancel via the HFI contract's `cancelByPayer(bytes32)` method.

## Client config

```typescript
const client = createHfiPayClient({
  quoteUrl: "https://hfi.network/api/intent/quote",
  timeoutMs: 10_000,          // request timeout (default 10s)
  retry: { maxAttempts: 3, baseDelayMs: 400 },  // optional retry
  defaultHeaders: { "X-My-App": "v1" },
  fetchImpl: globalThis.fetch, // custom fetch (e.g. node-fetch in Node 16)
});
```

### `prepareEvmTransactions` behavior

- **Attested quote required** (`attestedContract + attestedOrder`): SDK builds `deposit*WithOrder` tx and uses `attestedContract` as spender for ERC-20 approve.
- **Legacy/basic quote**: `prepareEvmTransactions` rejects it. Use the explicitly deprecated `buildEvmDepositRequest` helper only for old `HfiPayDeposit` deployments.

### Amount units (important)

`quoteSend({ amount })` expects a **base-unit string**:

- ETH: wei (`1 ETH = 10^18 wei`)
- USDC: 6 decimals (`1 USDC = 10^6`)

```typescript
import { toBaseUnits } from "hfi-sdk";

const amountWei = toBaseUnits("0.01", 18); // ETH
const amountUsdc = toBaseUnits("50", 6);   // USDC
```

## Key exports

| Export | Description |
|---|---|
| `createHfiPayClient(config)` | Create a client instance |
| `HfiPayClient` | Client class |
| `fetchPaymentQuote(url, body, opts)` | Low-level quote fetch |
| `buildEvmAttestedDepositRequest(params)` | Build current attested EVM deposit tx |
| `buildEvmDepositRequest(params)` | Deprecated legacy/basic EVM deposit tx helper |
| `buildEvmApproveRequest(params)` | Build ERC-20 approve tx |
| `isNativeEvmToken(address)` | True for 0x000… / 0xeee… |
| `toWagmiSendParams(tx)` | Convert tx to wagmi sendTransaction args |
| `toWagmiSendSequence(approve, deposit)` | Returns `[approve?, deposit]` array |
| `buildSolanaDepositVersionedTransaction(connection, params)` | Build Solana versioned tx |
| `signAndSendSolanaAttestedDeposit(wallet, connection, params)` | Sign + send via wallet adapter |
| `waitForSolanaConfirmation(connection, signature)` | Poll until confirmed |
| `normalizeRecipient(kind, value)` | Normalize email / x / phone |
| `HfiPayError`, `HfiPayNetworkError`, etc. | Typed error classes |
| `getNetwork(name)` | Get network config (devnet / testnet / mainnet) |

## Error handling

```typescript
import { HfiPayError, HfiPayNetworkError, HfiPayQuoteError } from "hfi-sdk";

try {
  const quote = await client.quoteSend({ ... });
} catch (e) {
  if (e instanceof HfiPayQuoteError) {
    console.error("Quote failed:", e.message, e.status);
  } else if (e instanceof HfiPayNetworkError) {
    console.error("Network error:", e.message);
  } else if (e instanceof HfiPayError) {
    console.error("HFI error:", e.code, e.message);
  }
}
```

## Build

```bash
npm run build   # outputs to dist/
```

## License

MIT
