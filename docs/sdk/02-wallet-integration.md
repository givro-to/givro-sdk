# 钱包厂商集成指南

> 生产环境为 Base、BNB Smart Chain 与 Tron 主网，公开标识符流程为 Email、X handle 与 Givro ID。手机号与 Solana 未上线，不得在集成中展示为可用。

## 集成定位

**钱包厂商只需要集成「发送」方向。**

接收方不需要任何特殊钱包支持——用户收到通知后打开网页，用任意标准钱包签名 claim 即可。

SDK 使用 `vm` / `ecosystem` 字段选择结算虚拟机：`evm` 或 `tron`。EVM 的具体网络通过 `chainId` 指定；某条链或某个 token 是否可用，取决于对应 Givro Portal 部署配置，而不是 SDK 客户端硬编码。

## 安装

```bash
npm install givro-sdk viem
# 仅使用 wagmi 示例时需要
npm install wagmi @tanstack/react-query
```

## 运行时资产发现与独立 pin

```typescript
import { fetchPublicSupportedAssets } from 'givro-sdk';

const runtime = await fetchPublicSupportedAssets('https://givro.to');
```

该接口用于 onboarding 或受控构建步骤，返回当前 chain、token 以及 Portal 发布的
`attestedContract`（该链的结算 escrow）。集成方仍须独立核验并把批准后的地址固化到自己的
`trustedAttestedContracts` 配置中。不得在每笔 quote 时从同一个 Portal 动态读取地址并
立即信任，否则会失去独立 contract pin 的安全边界。

## EVM 集成

### 使用 GivroPayClient（推荐）

```typescript
import { createGivroPayClient } from 'givro-sdk';
import { REVIEWED_ESCROWS } from './givro-reviewed-deployments.js';

const client = createGivroPayClient({
  quoteUrl: 'https://givro.to/api/intent/quote',
  trustedAttestedContracts: {
    'evm:8453': [REVIEWED_ESCROWS.base],
    'evm:56': [REVIEWED_ESCROWS.bsc],
  },
});

const quote = await client.quoteSend({
  recipientKind: 'email',
  recipient: 'alice@gmail.com',
  vm: 'evm',
  amount: '10000000000000000',   // 0.01 ETH in wei
  amountHuman: '0.01',
  token: '0x0000000000000000000000000000000000000000',  // native ETH
  chainId: 8453,
  turnstile: await getFreshTurnstileToken(),
});

// 返回 approve（仅 ERC-20）+ deposit tx
const { approve, deposit } = client.prepareEvmTransactions({ quote });

// wagmi 示例
if (approve) await sendTransactionAsync(approve);
await sendTransactionAsync(deposit);
```

ERC-20 的 `approve` 默认只授权本次报价的精确 deposit 金额，不请求无限 allowance。
生产 consumer quote 必须由浏览器提交新鲜 Turnstile token；该端点拒绝
`X-API-Key`。发送到 X handle 时还必须通过 `defaultHeaders` 提供当前发送方的
`X-X-Session`。企业服务器集成应使用 Payment Links API。
Turnstile token 为一次性凭证；SDK 在请求中存在 `turnstile` 时强制只尝试一次。
失败后必须重新获取 fresh token，再由用户重试，不能自动重放原请求。

EVM 原生币符号必须与 `chainId` 一起解析，并按链严格匹配：例如 Base 使用
`ETH`，BNB Smart Chain 使用 `BNB`。缺少 `chainId` 或符号与目标链不匹配时，SDK
会直接拒绝。`trustedAttestedContracts` 只接受 independently reviewed、非零的规范
`0x` 合约地址。

### 报价里有什么

```typescript
quote.attestedContract; // 结算 escrow
quote.mandateCommit;    // 首次收款为全零；否则为收款人 payout mandate 的承诺
quote.order;            // escrow 存储的 11 字段订单元组
```

`prepareEvmTransactions` 把 `order` 与 `mandateCommit` 原样编码进 `depositNativeWithOrder`
/ `depositErc20WithOrder`。集成方不需要也不应该改动其中任何字段。

## TronWeb 完整发送流程（TRX + TRC-20）

Tron escrow 与 EVM escrow 是同一份字节码，ABI 相同。

```typescript
import { createGivroPayClient, GIVRO_PAY_ESCROW_ABI_TRON, toBaseUnits } from 'givro-sdk';
import { REVIEWED_ESCROWS } from './givro-reviewed-deployments.js';

const chainId = 728126428;
const tronWeb = window.tronWeb;
if (!tronWeb?.defaultAddress?.base58) throw new Error('Connect TronLink first');

const client = createGivroPayClient({
  quoteUrl: 'https://givro.to/api/intent/quote',
  portalBaseUrl: 'https://givro.to',
  trustedAttestedContracts: {
    [`tron:${chainId}`]: [REVIEWED_ESCROWS.tron],
  },
});

function toBase58(address: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return tronWeb.address.fromHex('41' + address.slice(2));
  if (/^41[0-9a-fA-F]{40}$/.test(address)) return tronWeb.address.fromHex(address);
  return address;
}

async function confirm(txId: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const info = await tronWeb.trx.getTransactionInfo(txId);
    if (info?.receipt?.result === 'SUCCESS') return;
    if (info?.receipt?.result && info.receipt.result !== 'SUCCESS') throw new Error(`Tron tx failed: ${txId}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Tron confirmation timeout: ${txId}`);
}

async function fund(tokenInput: 'TRX' | string, amountRaw: string, amountHuman: string) {
  const quote = await client.quoteSend({
    recipientKind: 'email', recipient: 'alice@example.com', vm: 'tron', chainId,
    token: tokenInput, amount: amountRaw, amountHuman,
    turnstile: await getFreshTurnstileToken(),
  });
  // Native TRX 的 tuple token 为 Solidity ABI zero address。
  const call = client.tronDepositCall(quote);
  const order = { ...call.order, token: toBase58(call.order.token) };
  const escrowAddress = toBase58(call.escrow);
  const escrow = await tronWeb.contract(GIVRO_PAY_ESCROW_ABI_TRON, escrowAddress);

  let txId: string;
  if (call.functionName === 'depositNativeWithOrder') {
    txId = await escrow.depositNativeWithOrder(order, call.mandateCommit)
      .send({ callValue: call.callValue, feeLimit: 150_000_000 });
  } else {
    const token = await tronWeb.contract().at(toBase58(quote.token));
    const owner = tronWeb.defaultAddress.base58;
    const allowance = BigInt(String(await token.allowance(owner, escrowAddress).call()));
    const required = BigInt(order.amount);
    if (allowance !== required) {
      if (allowance > 0n) {
        const reset = await token.approve(escrowAddress, '0').send({ feeLimit: 100_000_000 });
        await confirm(reset);
      }
      const approve = await token.approve(escrowAddress, order.amount)
        .send({ feeLimit: 100_000_000 }); // exact approval
      await confirm(approve);
    }
    txId = await escrow.depositErc20WithOrder(order, call.mandateCommit)
      .send({ feeLimit: 150_000_000 });
  }
  await confirm(txId);
  return txId;
}

await fund('TRX', toBaseUnits('1', 6), '1');
await fund('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', toBaseUnits('10', 6), '10');
```

### 交易构造安全边界

应用必须通过 `GivroPayClient.prepareEvmTransactions` / `GivroPayClient.tronDepositCall`
或显式传入 pinned escrow 的 `buildEvmDepositFromQuote` 构造资金交易，并在客户端配置
经过发布审核的 `trustedAttestedContracts`。报价服务不能单方面改变 spender 或结算合约。

## UI 建议

在 Recipient 输入框提供双模式：

```
收款人  [─────────────────────────────────────]
        当前支持：钱包地址 / email / X handle
```

输入检测逻辑：
- 包含 `@` 且不是 `0x` 地址 → 识别为 email 或 X handle
- `0x...` → EVM 地址
- `T` 开头 base58（34 位）→ Tron 地址
- 手机号仅在 Portal 明确上线后再显示和识别

识别为 identifier 后自动走 Givro 流程，用户无需手动切换。

SDK 提供 `normalizeRecipient` 辅助函数：

```typescript
import { normalizeRecipient } from 'givro-sdk';

// 'First.Last+tag@googlemail.com' → 'firstlast@gmail.com'
// 'alice+tag@example.com' → 'alice+tag@example.com'（非 Gmail 保留 +tag 和点）
// '@Alice' → 'alice'（去掉 @，小写）
const normalized = normalizeRecipient('email', userInput);
```

## 金额单位转换

```typescript
import { toBaseUnits } from 'givro-sdk';

// 人类可读金额 → 最小单位字符串
const amountWei = toBaseUnits('1.5', 6);   // USDC: '1500000'
const wei       = toBaseUnits('0.01', 18); // ETH:  '10000000000000000'
```

## 注意事项

- `amountWei` 必须是**最小单位**的字符串（USDC 6 位小数，ETH 18 位）
- 对 native ETH 可传 `'ETH'` 或 `'0x0000000000000000000000000000000000000000'`；对 BNB 传 `'BNB'`；对 TRX 可传 `'TRX'` 或 `'native'`
- 报价有有效期（`order.claimBefore`），超时需重新报价
- deposit 上链后 Portal indexer 自动检测，通常一个确认周期内触发通知
- `vm` 字段（或其别名 `ecosystem`）必须传，用于路由到正确的链后端；生产支持范围以 Portal 的链和 token 配置为准
