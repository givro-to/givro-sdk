# API 参考

> Schema 中保留 `phone` 和 `solana` 以支持后续集成；当前公开主网试点只启用 Base + Tron 上的 Email + X handle 流程。集成方必须以 Portal 实际启用配置为准。

## Portal 端点

Base URL: `https://hfi.network`

---

### POST /api/intent/quote

获取支付报价。

**Request Body**

```typescript
{
  identifier: string;         // 收款方标识符（规范化后）
  identifierKind: 'email' | 'x' | 'phone';
  amountWei: string;          // 最小单位金额（字符串）
  token: string;              // SPL mint base58 / EVM 0x addr / 'SOL' / 'ETH'
  vm?: 'solana' | 'evm' | 'tron';  // 目标 VM（推荐，取代 ecosystem）
  ecosystem?: 'solana' | 'evm' | 'tron';   // vm 的别名，两者效果相同
  chainId?: number;           // EVM only
  cancelWindowSec?: number;   // 取消窗口（秒），默认/服务端最小 360；合约硬下限 300
}
```

**Response**（SDK 通过 `coercePaymentQuote` 规范化后的字段）

```typescript
{
  paymentRef: string;         // '0x' + 32字节 hex，唯一标识此笔付款
  amount: string;             // 最小单位金额
  token: string;
  ecosystem: 'solana' | 'evm' | 'tron';
  chainId?: number;

  // Solana 专有（raw response 在 `order` key 下，SDK 重映射到 solanaOrder）
  programId?: string;         // HFI Pay 程序 ID（base58）
  solanaOrder?: {
    cancelBefore: string;     // unix 秒（字符串）
    claimBefore: string;
    refundAfter: string;
    idHash: string;           // 64 hex chars（32字节，接收方身份 hash）
  };

  // EVM 专有（attested flow）
  attestedContract?: string;  // '0x' HFI Pay 合约地址
  depositContract?: string;   // attestedContract 的别名
  attestedOrder?: {
    chainId: bigint;
    paymentRef: string;       // '0x' hex
    idHash: string;           // '0x' hex
    token: string;
    amount: bigint;
    cancelBefore: bigint;
    claimBefore: bigint;
    refundAfter: bigint;
  };
}
```

> **注意**：Portal server 返回的 Solana 报价字段直接平铺在 response 根（`cancelBefore`, `claimBefore`, `refundAfter`, `idHash` 在 `order` 子对象下），`coercePaymentQuote` 将其重映射到 `solanaOrder`。直接使用 SDK 的 `fetchPaymentQuote` 时拿到的已是规范化后的结构。

---

### POST /api/intent/build-solana-tx

让 Portal 构建未签名的 Solana deposit VersionedTransaction。  
适用于没有 `@solana/web3.js` 的轻量钱包环境（如浏览器扩展）。

**Request Body**

```typescript
{
  paymentRef: string;       // 来自 quote 的 paymentRef（'0x' hex）
  payerAddress: string;     // 发送方 Solana 地址（base58）
  recentBlockhash: string;  // 从 Solana RPC getLatestBlockhash 获取
}
```

**Response**

```typescript
{
  txBase64: string;   // base64 编码的未签名 VersionedTransaction
}
```

钱包收到后用 Ed25519 签名，然后通过 `sendTransaction` RPC 提交。  
速率限制：每 IP 60 次/分钟。

---

### POST /api/intent/otp/send

向 email 或手机发送 OTP。

```typescript
// body
{ identifier: string; identifierKind: 'email' | 'phone' }
// response
{ ok: true }
```

### POST /api/intent/otp/verify

验证 OTP，返回 `verificationToken`（用于后续 claim）。

```typescript
// body
{ identifier: string; identifierKind: 'email' | 'phone'; code: string }
// response
{ verificationToken: string; expiresAt: number }
```

---

## SDK 函数

### fetchPaymentQuote

```typescript
import { fetchPaymentQuote } from 'hfi-sdk';

function fetchPaymentQuote(
  quoteUrl: string,
  body: QuoteRequestBody,
  init?: {
    fetchImpl?: typeof fetch;
    headers?: HeadersInit;
    timeoutMs?: number;         // 默认 10000ms
    retry?: {
      maxAttempts?: number;     // 默认 1（不重试）
      baseDelayMs?: number;     // 默认 300ms，指数退避
      jitter?: number;          // 默认 0.2
    };
  }
): Promise<PaymentQuote>
```

返回值已经过 `coercePaymentQuote` 规范化（camelCase，bigint 类型等）。

---

### HfiPayClient

```typescript
import { createHfiPayClient } from 'hfi-sdk';

const client = createHfiPayClient({
  quoteUrl: string;
  portalBaseUrl?: string;      // 默认从 quoteUrl 推导
  fetchImpl?: typeof fetch;
  defaultHeaders?: HeadersInit;
  timeoutMs?: number;
  retry?: RetryOptions;
  trustedAttestedContracts?: Readonly<Record<string, readonly string[]>>;
  trustedSolanaPrograms?: Readonly<Record<string, readonly string[]>>;
});
```

**方法：**

- `client.fetchQuote(body)` — 底层报价，传入 QuoteRequestBody
- `client.quoteSend(params)` — 更易用的报价接口，含 normalizeRecipient
- `client.prepareEvmTransactions({ quote, originRelayAddress? })` — 要求 attested EVM quote 且合约位于 `trustedAttestedContracts`，返回 `{ approve, deposit }` tx 对象
- `client.prepareSolanaTransaction(connection, { quote, payer, cluster, recentBlockhash?, originRelayAddress? })` — 要求报价 Program 位于 `trustedSolanaPrograms[cluster]`，返回 VersionedTransaction

---

### 资金交易低层构造器

包根不导出接受任意结算合约或 Solana Program 的资金构造器。应用必须通过
`HfiPayClient` 的 pinned builder 构造交易；生命周期辅助函数不受此限制，因为它们不创建
新的 token allowance 或资金存款。

---

### waitForSolanaConfirmation

```typescript
import { waitForSolanaConfirmation } from 'hfi-sdk';

async function waitForSolanaConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs?: number    // 默认 60_000ms
): Promise<{ slot: number }>
```

轮询直到 tx 达到 `confirmed` 或 `finalized` commitment，返回确认 slot。

---

### 其他 EVM 工具函数

```typescript
import {
  buildEvmCancelRequest,     // 发送方取消
  buildEvmRefundTx,          // 退款
  buildEvmBindTx,            // 绑定钱包地址到 idHash
  buildEvmRevokePendingTx,   // 撤销待激活的绑定变更
  buildEvmClaimTx,           // 接收方手动 claim
} from 'hfi-sdk';
```

---

### normalizeRecipient / normalizeEmail

```typescript
import { normalizeRecipient, normalizeEmail } from 'hfi-sdk';

normalizeRecipient('email', 'Alice+tag@Gmail.COM')   // 'alice@gmail.com'
normalizeRecipient('x', '@Alice')                     // 'alice'
normalizeRecipient('phone', '+86 138 0000 0000')      // '+861380000000'（trimmed）

// 仅 email 规范化（去掉 + 后缀，小写，保留 domain）
normalizeEmail('Alice+tag@Gmail.COM')                 // 'alice@gmail.com'
```

---

### toBaseUnits

```typescript
import { toBaseUnits } from 'hfi-sdk';

toBaseUnits('1.5', 6)    // '1500000'    USDC
toBaseUnits('0.01', 9)   // '10000000'   SOL
toBaseUnits('100', 18)   // '100000000000000000000'  ETH wei
```

---

## 链上合约常量

### Solana

```typescript
// 程序 ID（由 Portal 报价返回覆盖，生产环境以报价值为准）
DEFAULT_HFI_PAY_PROGRAM_ID = 'B8sLQ5g6ABbZyyuyx9hia4kFv8nMo4wCqWXcLcR9XpJZ'

// Anchor discriminators（sha256("global:<name>").slice(0,8)）
DEPOSIT_SPL_DISCRIMINATOR    = Uint8Array [224, 0, 198, 175, 198, 47, 105, 204]
DEPOSIT_NATIVE_DISCRIMINATOR = Uint8Array [13, 158, 13, 223, 95, 213, 28, 6]
CLAIM_DISCRIMINATOR          = Uint8Array [62, 198, 214, 193, 213, 159, 108, 210]
CLAIM_NATIVE_DISCRIMINATOR   = Uint8Array [65, 171, 104, 250, 157, 187, 30, 151]

// PDA seeds（对应 SDK 的 pda.ts 中的辅助函数）
vaultAuthority: ["vault_authority", paymentRef]
vaultAta:       ["vault_ata",       paymentRef]
vaultMeta:      ["vault_meta",      paymentRef]
binding:        ["binding",         idHash]
config:         ["config"]                     // 全局合约配置（含 treasury 地址）
mintPolicy:     ["mint_policy",     mint]      // mint=Pubkey::default() 表示 native SOL
```

`MintPolicy.useUsdFeeFloor=true` 仅适用于 USDC/USDT 这类 6-decimal 美元面值资产；native SOL 应配置为 `false`，只按 bps 收费。

### deposit_spl 指令数据布局

```
offset  size  field
0       8     discriminator (DEPOSIT_SPL_DISCRIMINATOR)
8       32    paymentRef
40      32    idHash
72      8     amount (u64 LE)
80      8     cancelBefore (i64 LE)
88      8     claimBefore (i64 LE)
96      8     refundAfter (i64 LE)
104     32    originRelay (pubkey，全零 = 无 relay)
```

`deposit_native` 布局相同，discriminator 换为 `DEPOSIT_NATIVE_DISCRIMINATOR`。

### deposit_spl 账户列表

```
0  payer                 signer, writable
1  config                readonly
2  mint                  readonly
3  mintPolicy            readonly
4  payerAta              writable
5  vaultAuthority        readonly
6  vaultAta              writable
7  vaultMeta             writable
8  TOKEN_PROGRAM         readonly
9  SYSTEM_PROGRAM        readonly
10 SYSVAR_RENT           readonly
```

### deposit_native 账户列表

```
0  payer              signer, writable
1  config             readonly
2  nativeMintPolicy   readonly
3  vaultAuthority     writable
4  vaultMeta          writable
5  SYSTEM_PROGRAM     readonly
```

### claim 账户列表（relay 执行，SPL）

```
0  relayer                  signer, writable
1  config                   readonly
2  mint                     readonly
3  mintPolicy               readonly
4  vaultAuthority           readonly
5  vaultAta                 writable
6  vaultMeta                writable
7  binding                  writable
8  recipient                readonly
9  recipientAta             writable
10 treasury                 writable
11 treasuryAta              writable
12 TOKEN_PROGRAM            readonly
13 ASSOCIATED_TOKEN_PROGRAM readonly
14 SYSTEM_PROGRAM           readonly
```

### claim_native 账户列表（relay 执行）

```
0  relayer            signer, writable
1  config             readonly（全局配置，含 treasury pubkey）
2  nativeMintPolicy   readonly
3  vaultAuthority     writable
4  vaultMeta          writable
5  binding            writable（IdentityBinding PDA）
6  recipient          writable（绑定的钱包地址）
7  treasury           writable（协议 fee 接收方）
8  SYSTEM_PROGRAM     readonly
```
