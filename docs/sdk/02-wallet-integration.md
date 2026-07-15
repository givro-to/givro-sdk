# 钱包厂商集成指南

> 当前已验证的真实资金主网试点为 Base + Tron，公开标识符流程为 Email + X handle。手机号、Solana 和其他主流 EVM 网络仅为生产发布目标；以下 Solana 或手机号示例不得用于生产，除非 Portal 配置与专项发布审核明确启用对应能力。

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
  quoteUrl: 'http://localhost:3100/api/intent/quote',
  trustedSolanaPrograms: {
    devnet: ['REVIEWED_DEVNET_SOLANA_PROGRAM_ID'],
  },
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
    cluster: 'devnet',
  });

  // 3. 钱包签名并提交（标准 Ed25519，与普通转账无区别）
  const signature = await params.sendTransaction(tx);
  return signature;
}
```

### Solana 交易构造安全要求

Solana 资金交易必须通过 `client.prepareSolanaTransaction` 构造，并同时传入构建审核过的
cluster。客户端配置中的 `trustedSolanaPrograms[cluster]` 是独立信任根；报价响应不能决定
Program ID。为避免集成方绕过该约束，包根不再导出接受任意 Program ID 的底层资金构造器。

### 轻量方案（无 @solana/web3.js）

如果钱包环境无法在本地验证完整指令和可信 Program，不得直接签署 Portal 返回的未签名
交易。应在钱包侧增加等价的 Program、mint、金额和账户权限校验后再启用该方案。

当前包不提供无法独立验证交易的轻量签名捷径；集成方应保留本地交易解析能力或保持该链关闭。

## EVM 集成

### 使用 HfiPayClient（推荐）

```typescript
import { createHfiPayClient } from 'hfi-sdk';

const client = createHfiPayClient({
  quoteUrl: 'https://hfi.network/api/intent/quote',
  trustedAttestedContracts: {
    'evm:8453': ['0xREVIEWED_BASE_ATTESTED_CONTRACT'],
  },
});

const quote = await client.quoteSend({
  recipientKind: 'email',
  recipient: 'alice@gmail.com',
  vm: 'evm',
  amount: '10000000000000000',   // 0.01 ETH in wei
  token: '0x0000000000000000000000000000000000000000',  // native ETH
  chainId: 8453,
});

// Attested quote required; returns approve (仅 ERC-20) + deposit tx
const { approve, deposit } = client.prepareEvmTransactions({ quote });

// wagmi 示例
if (approve) await sendTransactionAsync(approve);
await sendTransactionAsync(deposit);
```

### 交易构造安全边界

应用必须通过 `HfiPayClient.prepareEvmTransactions` 或
`HfiPayClient.prepareSolanaTransaction` 构造资金交易，并在客户端配置经过发布审核的
`trustedAttestedContracts` / `trustedSolanaPrograms`。SDK 不再从包根导出可直接接受
报价返回地址的低层资金构造器，避免报价服务单独改变 spender、结算合约或 Solana
Program。

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
