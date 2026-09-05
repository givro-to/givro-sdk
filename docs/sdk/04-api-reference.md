# API 参考

> Schema 中保留 `phone` 以支持后续集成；当前生产只启用 Base、BNB Smart Chain 与 Tron 上的 Email、X handle 与 Givro ID 流程。集成方必须以 Portal 实际启用配置为准。

## Portal 端点

Base URL: `https://givro.to`

---

### POST /api/intent/quote

获取支付报价。

**Request Body**

```typescript
{
  identifier: string;         // 收款方标识符（规范化后）
  identifierKind: 'email' | 'x' | 'givro_id' | 'phone';
  amount?: string;            // 人类可读金额，用于 UI/策略元数据
  amountWei: string;          // 最小单位金额（字符串）
  token: string;              // EVM 0x addr / TRC20 base58 / 原生币符号（须与 chainId 匹配）
  vm?: 'evm' | 'tron';        // 目标 VM（推荐，取代 ecosystem）
  ecosystem?: 'evm' | 'tron'; // vm 的别名，两者效果相同
  chainId: number;            // EVM / Tron chain id
  turnstile: string;          // production consumer browser quote 必填
  cancelWindowSec?: number;   // 取消窗口（秒），产品默认 600；0 表示即时付款（豁免取消窗口）
}
```

EVM 原生币符号按 `chainId` 严格解析；缺少链 ID 或符号与目标链不一致时 SDK 会
fail closed。EVM/Tron 的 escrow 地址必须是 independently pinned、非零的规范 `0x` 地址。

鉴权边界：production consumer quote 必须携带浏览器获得的新鲜 Turnstile token；
`X-API-Key` 会被拒绝。`identifierKind='x'` 时还需 `X-X-Session` 请求头，绑定当前
发送方 X 登录态。企业服务器调用使用 Payment Links API，而不是 consumer quote。

**Response**（SDK 通过 `coercePaymentQuote` 规范化后的字段）

```typescript
{
  paymentRef: `0x${string}`;  // 32 字节 hex，唯一标识此笔付款
  amount: string;             // 最小单位金额，恒等于 order.amount
  token: string;              // EVM：0x 地址（原生为零地址）；Tron：'native' 或 base58 合约
  ecosystem: 'evm' | 'tron';
  chainId: number;
  attestedContract: `0x${string}`;  // 该链的结算 escrow（必须与集成方 pin 一致）
  mandateCommit: `0x${string}`;     // 全零 = 首次收款，只能由收款人本人签名领取
  order: {
    chainId: bigint;
    paymentRef: `0x${string}`;
    intentId: `0x${string}`;
    blindedBinding: `0x${string}`;  // 每笔独立；escrow 拒绝重复值
    bindingEpoch: bigint;
    claimAuthorization: 0 | 1;      // 0 = LazyAttested，1 = ZkRegistered
    token: string;
    amount: bigint;
    cancelBefore: bigint;
    claimBefore: bigint;
    refundAfter: bigint;
  };
}
```

线上 JSON 里这些字段位于 `intentBlinded` 对象下（`escrow`、`mandateCommit`、`order`），
并在顶层重复 `attestedContract`、`token`、`amountWei`、`chainId`。SDK 会校验顶层值与
`order` 一致；不一致的报价会被拒绝。

---

### GET /api/public/supported-assets

返回当前 Portal 的 profile、registry version、chain、token 以及每条链的结算
`attestedContract`。SDK 提供类型化 helper：

```typescript
import { fetchPublicSupportedAssets } from 'givro-sdk';

const runtime = await fetchPublicSupportedAssets('https://givro.to');
```

该响应仅用于 onboarding/build-time discovery。集成方必须独立审核地址并固化到
`trustedAttestedContracts`；不得在每笔 quote 时动态信任同一 Portal 返回的地址。

---

### POST /api/intent/otp/send

为指定付款向收款邮箱发送 claim OTP。

```typescript
// body
{ email: string; paymentRef: string }
// response
{ ok: true }
```

### POST /api/intent/otp/verify

验证 OTP，返回 `verificationToken`（用于后续 claim）。

```typescript
// body
{ email: string; paymentRef: string; code: string }
// response
{ verificationToken: string; expiresAt: number }
```

### POST /api/intent/claim/v2/attest 与 /api/intent/claim/v2/submit

收款人签名领取的两步端点（路径中的 `v2` 是端点名，不是协议版本）：`attest` 返回收款人需签名
的 EIP-712 `IntentClaim` 元组与 attester 签名；`submit` 接收收款人签名并由 Portal 中继广播。
钱包厂商无需调用，claim 页面已封装。

---

## SDK 函数

### fetchPaymentQuote

```typescript
import { fetchPaymentQuote } from 'givro-sdk';

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
请求包含一次性 `turnstile` 时，SDK 强制 `maxAttempts=1`，不会自动重放。
失败后调用方必须获取新的 Turnstile token，再由用户发起重试。

---

### GivroPayClient

```typescript
import { createGivroPayClient } from 'givro-sdk';

const client = createGivroPayClient({
  quoteUrl: string;
  portalBaseUrl?: string;      // 默认从 quoteUrl 推导
  intentQuoteUrl?: string;     // Tron 报价端点显式覆盖
  fetchImpl?: typeof fetch;
  defaultHeaders?: HeadersInit;
  timeoutMs?: number;
  retry?: RetryOptions;
  trustedAttestedContracts?: Readonly<Record<string, readonly string[]>>;  // `${ecosystem}:${chainId}` → escrow 列表
});
```

**方法：**

- `client.fetchQuote(body)` — 底层报价，传入 QuoteRequestBody；校验响应与请求的链、token、金额一致
- `client.quoteSend(params)` — 更易用的报价接口，含 normalizeRecipient
- `client.prepareEvmTransactions({ quote })` — 要求报价 escrow 位于 `trustedAttestedContracts`，返回 `{ approve, deposit }`；ERC-20 approve 默认严格等于本次 deposit 金额
- `client.tronDepositCall(quote)` — 同样要求 pin，返回 TronWeb 所需的 `{ escrow, functionName, order, mandateCommit, callValue }`

---

### 资金交易构造器

```typescript
import {
  buildEvmDepositFromQuote,  // { quote, pinnedEscrow } → { steps: [deposit] | [approve, deposit] }
  buildEvmNativeDeposit,     // { escrow, order, mandateCommit }
  buildEvmErc20Deposit,      // { escrow, order, mandateCommit, approveAmount? } → { approve, deposit }
  buildEvmCancelTx,          // { escrow, paymentRef }，付款人在取消窗口内
  buildEvmRefundTx,          // { escrow, paymentRef }，refundAfter 之后任何人可调
  tronDepositCallFromQuote,  // Tron 版本的 deposit 调用描述
} from 'givro-sdk';
```

`buildEvmDepositFromQuote` 与 client 方法一样拒绝未 pin 的 escrow。低层构造器接受显式 escrow，
供已经在别处完成 pin 校验的调用方使用。

---

### EIP-712 材料

```typescript
import { escrowDomain, PAYOUT_MANDATE_TYPES, INTENT_CLAIM_TYPES, CLAIM_AUTHORIZATION } from 'givro-sdk';

escrowDomain(chainId, escrow);
// { name: 'HfiPayIntentBlinded', version: '1', chainId, verifyingContract: escrow }
```

- `PAYOUT_MANDATE_TYPES` — 收款人登记结算目的地时签名的 `PayoutMandate` 结构
- `INTENT_CLAIM_TYPES` — 收款人领取单笔付款时签名的 `IntentClaim` 结构
- `CLAIM_AUTHORIZATION` — `{ LazyAttested: 0, ZkRegistered: 1 }`

---

### normalizeRecipient / normalizeEmail

```typescript
import { normalizeRecipient, normalizeEmail } from 'givro-sdk';

normalizeRecipient('email', 'Alice+tag@Gmail.COM')   // 'alice@gmail.com'
normalizeRecipient('x', '@Alice')                     // 'alice'
normalizeRecipient('givro_id', '@Acme.Sales')         // 'acme.sales'

// Gmail/Googlemail 去点、去 +tag，并统一为 gmail.com；其他 provider 保留 local part
normalizeEmail('First.Last+tag@GoogleMail.COM')       // 'firstlast@gmail.com'
normalizeEmail('Alice+tag@Example.COM')               // 'alice+tag@example.com'
```

---

### toBaseUnits

```typescript
import { toBaseUnits } from 'givro-sdk';

toBaseUnits('1.5', 6)    // '1500000'    USDC
toBaseUnits('100', 18)   // '100000000000000000000'  ETH wei
```

---

## 链上合约常量

### Escrow ABI（EVM 与 Tron 共用）

`GIVRO_PAY_ESCROW_ABI`（Tron 别名 `GIVRO_PAY_ESCROW_ABI_TRON`）包含：

| 函数 | 说明 |
|------|------|
| `depositNativeWithOrder(order, mandateCommit)` | payable，原生币注资 |
| `depositErc20WithOrder(order, mandateCommit)` | 先 approve 再注资 |
| `cancelByPayer(paymentRef)` | 付款人在取消窗口内撤销 |
| `refund(paymentRef)` | `refundAfter` 之后任何人可调，资金退回付款人 |
| `previewFee(paymentRef)` | 预览协议费与收款人实收 |

订单元组：

```
(uint256 chainId, bytes32 paymentRef, bytes32 intentId, bytes32 blindedBinding,
 uint64 bindingEpoch, uint8 claimAuthorization, address token, uint256 amount,
 uint64 cancelBefore, uint64 claimBefore, uint64 refundAfter)
```

### 费用

协议费只在成功领取时从付款金额中扣除；取消与退款全额返还。零售费率与上限见主仓库
`docs/business-rules.md` §4。
