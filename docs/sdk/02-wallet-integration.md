# 钱包厂商集成指南

## 集成定位

**钱包厂商只需要集成「发送」方向。**

接收方不需要任何特殊钱包支持——用户收到通知后打开网页，用任意标准钱包签名 claim 即可。

SDK 使用 `vm` / `ecosystem` 字段选择结算虚拟机：`evm`、`solana` 或 `tron`。EVM 的具体网络通过 `chainId` 指定；某条链或某个 token 是否可用，取决于对应 HFI Portal 部署配置，而不是 SDK 客户端硬编码。

## 安装

```bash
npm install hfi-sdk

# peer deps（按需安装）
npm install @solana/web3.js @solana/spl-token   # Solana
npm install viem                                  # EVM
```

## Solana 集成

### 完整发送流程（推荐，使用 HfiPayClient）

```typescript
import { createHfiPayClient } from 'hfi-sdk';
import { Connection, PublicKey } from '@solana/web3.js';

const client = createHfiPayClient({
  quoteUrl: 'https://hfi.network/api/intent/quote',
});

async function sendViaHfiPay(params: {
  recipientIdentifier: string;   // 'alice@gmail.com' 或 '@alice'
  identifierKind: 'email' | 'x' | 'phone';
  amountRaw: string;             // 最小单位，如 USDC 1.00 = '1000000'
  token: string;                 // SPL mint base58，或 '11111111111111111111111111111111' 表示原生 SOL
  payerPublicKey: PublicKey;
  connection: Connection;
  sendTransaction: (tx: import('@solana/web3.js').VersionedTransaction) => Promise<string>;
}) {
  // 1. 拿报价
  const quote = await client.quoteSend({
    recipientKind: params.identifierKind,
    recipient: params.recipientIdentifier,
    vm: 'solana',
    amount: params.amountRaw,
    token: params.token,
  });

  // 2. 构建 deposit 交易（SDK 内部处理所有 PDA 推导和指令编码）
  const tx = await client.prepareSolanaTransaction(params.connection, {
    quote,
    payer: params.payerPublicKey,
  });

  // 3. 钱包签名并提交（标准 Ed25519，与普通转账无区别）
  const signature = await params.sendTransaction(tx);
  return signature;
}
```

### 底层 API（直接用 buildSolanaAttestedDepositTransaction）

如果你需要更细粒度的控制，可以直接调用底层构建函数：

```typescript
import {
  fetchPaymentQuote,
  buildSolanaAttestedDepositTransaction,
  paymentRefHexToBytes,
  DEFAULT_HFI_PAY_PROGRAM_ID,
} from 'hfi-sdk';
import { Connection, PublicKey } from '@solana/web3.js';

// 1. 拿报价
const quote = await fetchPaymentQuote(
  'https://hfi.network/api/intent/quote',
  {
    identifier: 'alice@gmail.com',
    identifierKind: 'email',
    amountWei: '1000000',    // 1 USDC
    token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    vm: 'solana',
  }
);

// quote.solanaOrder 包含 idHash、cancelBefore、claimBefore、refundAfter
const sol = quote.solanaOrder!;

// 2. 构建 deposit 交易
const { blockhash } = await connection.getLatestBlockhash();
const tx = await buildSolanaAttestedDepositTransaction(connection, {
  programId: new PublicKey(quote.programId ?? DEFAULT_HFI_PAY_PROGRAM_ID),
  payer: payerPublicKey,
  order: {
    paymentRef: paymentRefHexToBytes(quote.paymentRef),  // 32 bytes Uint8Array
    idHash:     paymentRefHexToBytes(sol.idHash),         // 32 bytes Uint8Array
    mint:       new PublicKey(quote.token),
    amount:     BigInt(quote.amount),
    cancelBefore: BigInt(sol.cancelBefore),
    claimBefore:  BigInt(sol.claimBefore),
    refundAfter:  BigInt(sol.refundAfter),
  },
  recentBlockhash: blockhash,
});

// 3. 钱包自己签名
const signature = await wallet.sendTransaction(tx, connection);
```

### 使用 wallet-adapter 的一步式 API

```typescript
import {
  fetchPaymentQuote,
  signAndSendSolanaAttestedDeposit,
  paymentRefHexToBytes,
  DEFAULT_HFI_PAY_PROGRAM_ID,
} from 'hfi-sdk';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';

const { connection } = useConnection();
const wallet = useWallet();

const quote = await fetchPaymentQuote(...);
const sol = quote.solanaOrder!;
const { blockhash } = await connection.getLatestBlockhash();

const { signature } = await signAndSendSolanaAttestedDeposit(
  wallet,      // 注意：wallet 在前，connection 在后
  connection,
  {
    programId: new PublicKey(quote.programId ?? DEFAULT_HFI_PAY_PROGRAM_ID),
    payer: wallet.publicKey!,
    order: {
      paymentRef: paymentRefHexToBytes(quote.paymentRef),
      idHash:     paymentRefHexToBytes(sol.idHash),
      mint:       new PublicKey(quote.token),
      amount:     BigInt(quote.amount),
      cancelBefore: BigInt(sol.cancelBefore),
      claimBefore:  BigInt(sol.claimBefore),
      refundAfter:  BigInt(sol.refundAfter),
    },
    recentBlockhash: blockhash,
  }
);
```

### 轻量方案（无 @solana/web3.js）

如果钱包环境没有 `@solana/web3.js`（如浏览器扩展），可以让 Portal 构建未签名 tx，钱包只负责签名：

```typescript
// 1. 拿报价（不需要 SDK，直接 fetch）
const quote = await fetch('https://hfi.network/api/intent/quote', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    identifier: 'alice@gmail.com',
    identifierKind: 'email',
    amountWei: '1000000',
    token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    vm: 'solana',
  }),
}).then(r => r.json());

// 2. 获取 blockhash（通过 Solana RPC）
const { blockhash } = await solanaRpc('getLatestBlockhash');

// 3. 让 Portal 构建未签名 tx
const { txBase64 } = await fetch('https://hfi.network/api/intent/build-solana-tx', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    paymentRef: quote.paymentRef,
    payerAddress: payerPublicKeyBase58,
    recentBlockhash: blockhash,
  }),
}).then(r => r.json());

// 4. 钱包签名（Ed25519，标准）并提交
const signedBase64 = walletSign(txBase64);
await solanaRpc('sendTransaction', [signedBase64, { encoding: 'base64' }]);
```

## EVM 集成

### 使用 HfiPayClient（推荐）

```typescript
import { createHfiPayClient } from 'hfi-sdk';

const client = createHfiPayClient({
  quoteUrl: 'https://hfi.network/api/intent/quote',
});

const quote = await client.quoteSend({
  recipientKind: 'email',
  recipient: 'alice@gmail.com',
  vm: 'evm',
  amount: '10000000000000000',   // 0.01 ETH in wei
  token: '0x0000000000000000000000000000000000000000',  // native ETH
  chainId: 1,
});

// Attested quote required; returns approve (仅 ERC-20) + deposit tx
const { approve, deposit } = client.prepareEvmTransactions({ quote });

// wagmi 示例
if (approve) await sendTransactionAsync(approve);
await sendTransactionAsync(deposit);
```

### 底层 API

```typescript
import {
  fetchPaymentQuote,
  buildEvmAttestedDepositRequest,
  buildEvmApproveRequest,
  isNativeEvmToken,
} from 'hfi-sdk';

const quote = await fetchPaymentQuote(
  'https://hfi.network/api/intent/quote',
  {
    identifier: 'alice@gmail.com',
    identifierKind: 'email',
    amountWei: '10000000000000000',
    token: '0x0000000000000000000000000000000000000000',
    vm: 'evm',
    chainId: 1,
  }
);

// 构建 EVM deposit 调用数据（permissionless attested flow，无需 portal 签名）
const deposit = buildEvmAttestedDepositRequest({
  depositContract: quote.attestedContract!,
  order: quote.attestedOrder!,
});

// ERC-20 还需要先 approve
const token = quote.token as `0x${string}`;
if (!isNativeEvmToken(token)) {
  const approve = buildEvmApproveRequest({
    token,
    depositContract: quote.attestedContract!,
    amount: quote.attestedOrder!.amount,
  });
  await wallet.sendTransaction(approve);
}

await wallet.sendTransaction(deposit);
```

## UI 建议

在 Recipient 输入框提供双模式：

```
收款人  [─────────────────────────────────────]
        支持：钱包地址 / email / X handle / 手机号
```

输入检测逻辑：
- 包含 `@` 且不是 `0x` 地址 → 识别为 email 或 X handle
- `0x...` → EVM 地址
- base58（长度 32-44）→ Solana 地址
- `+` 开头 → 手机号

识别为 identifier 后自动走 HFI Pay 流程，用户无需手动切换。

SDK 提供 `normalizeRecipient` 辅助函数：

```typescript
import { normalizeRecipient } from 'hfi-sdk';

// 'alice@gmail.com' → 'alice@gmail.com'（去掉 + 后缀，小写）
// '@Alice' → 'alice'（去掉 @，小写）
const normalized = normalizeRecipient('email', userInput);
```

## 金额单位转换

```typescript
import { toBaseUnits } from 'hfi-sdk';

// 人类可读金额 → 最小单位字符串
const amountWei = toBaseUnits('1.5', 6);   // USDC: '1500000'
const lamports  = toBaseUnits('0.01', 9);  // SOL:  '10000000'
```

## 注意事项

- `amountWei` 必须是**最小单位**的字符串（USDC 6 位小数，SOL 9 位小数）
- `token` 对原生 SOL 传 `'SOL'` 或 `'11111111111111111111111111111111'`；对 native ETH 传 `'0x0000000000000000000000000000000000000000'`
- 报价有有效期（`solanaOrder.claimBefore` / `attestedOrder.claimBefore`），超时需重新报价
- deposit 上链后 Portal indexer 自动检测，通常 5-10 秒内触发通知
- `vm` 字段（或其别名 `ecosystem`）必须传，用于路由到正确的链后端；生产支持范围以 Portal 的链和 token 配置为准
