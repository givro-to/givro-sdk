# 钱包厂商集成指南

> 当前已验证的真实资金主网试点为 Base + Tron，公开标识符流程为 Email + X handle。手机号、Solana 和其他主流 EVM 网络仅为生产发布目标；以下 Solana 或手机号示例不得用于生产，除非 Portal 配置与专项发布审核明确启用对应能力。

## 集成定位

**钱包厂商只需要集成「发送」方向。**

接收方不需要任何特殊钱包支持——用户收到通知后打开网页，用任意标准钱包签名 claim 即可。

SDK 使用 `vm` / `ecosystem` 字段选择结算虚拟机：`evm`、`solana` 或 `tron`。EVM 的具体网络通过 `chainId` 指定；某条链或某个 token 是否可用，取决于对应 Givro Portal 部署配置，而不是 SDK 客户端硬编码。

## 安装

```bash
npm install givro-sdk viem @solana/web3.js @solana/spl-token
# 仅使用 wagmi 示例时需要
npm install wagmi @tanstack/react-query
```

当前根 ESM 入口静态导出 EVM 和 Solana helper，因此上述三个 peer dependency
均为必需依赖。后续若拆分独立 subpath export，才能真正实现按 VM 可选安装。

## 运行时资产发现与独立 pin

```typescript
import { fetchPublicSupportedAssets } from 'givro-sdk';

const runtime = await fetchPublicSupportedAssets('https://givro.to');
```

该接口用于 onboarding 或受控构建步骤，返回当前 chain、token 以及 Portal 发布的
`attestedContract`。集成方仍须独立核验并把批准后的地址固化到自己的
`trustedAttestedContracts` 配置中。不得在每笔 quote 时从同一个 Portal 动态读取地址并
立即信任，否则会失去独立 contract pin 的安全边界。

当前该接口不返回 Solana `programId`，因此不能作为 Solana Program pin 的来源。
Program ID 必须通过独立发布渠道获取、审核并固化到 `trustedSolanaPrograms`。
同时，当前 registry 的 native SOL marker 与交易构造层的 native mint 表示不能仅凭
discovery response 推断为完整闭环；未完成 Program、marker、指令和生命周期专项审核前，
不得据此开放 native SOL。Wrapped SOL 是 SPL token mint，不能当作 native SOL marker。

## Solana 集成

### 完整发送流程（推荐，使用 GivroPayClient）

```typescript
import { createGivroPayClient } from 'givro-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { REVIEWED_HFI_PROGRAMS } from './hfi-reviewed-deployments.js';

const client = createGivroPayClient({
  quoteUrl: 'http://localhost:3100/api/intent/quote',
  trustedSolanaPrograms: {
    devnet: [REVIEWED_HFI_PROGRAMS.devnet],
  },
});

async function sendViaGivroPay(params: {
  recipientIdentifier: string;   // 'alice@gmail.com' 或 '@alice'
  identifierKind: 'email' | 'x';            // phone 尚未上线
  amountRaw: string;             // 最小单位，如 USDC 1.00 = '1000000'
  amountHuman: string;           // 人类可读金额，如 '1.00'
  token: string;                 // SPL mint base58，或 '11111111111111111111111111111111' 表示原生 SOL
  payerPublicKey: PublicKey;
  connection: Connection;
  sendTransaction: (tx: import('@solana/web3.js').VersionedTransaction) => Promise<string>;
  turnstileToken: string;                   // 浏览器 Turnstile 新鲜 token
}) {
  // 1. 拿报价
  const quote = await client.quoteSend({
    recipientKind: params.identifierKind,
    recipient: params.recipientIdentifier,
    vm: 'solana',
    amount: params.amountRaw,
    amountHuman: params.amountHuman,
    token: params.token,
    turnstile: params.turnstileToken,
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
如果使用 Portal 返回的 base64 未签名交易，钱包必须在本地 decode，并逐项验证：固定的
Program ID、payer、mint/native marker、精确 amount、全部 account、signer/writable 权限、
指令 discriminator/参数，以及不存在任何额外指令。未签名不等于无风险；不能让同一个
Portal 同时成为 quote 与待签交易内容的唯一信任来源。

### 轻量方案（无 @solana/web3.js）

如果钱包环境无法在本地验证完整指令和可信 Program，不得直接签署 Portal 返回的未签名
交易。应在钱包侧增加等价的 Program、mint、金额和账户权限校验后再启用该方案。

当前包不提供无法独立验证交易的轻量签名捷径；集成方应保留本地交易解析能力或保持该链关闭。

## EVM 集成

### 使用 GivroPayClient（推荐）

```typescript
import { createGivroPayClient } from 'givro-sdk';
import { REVIEWED_HFI_CONTRACTS } from './hfi-reviewed-deployments.js';

const client = createGivroPayClient({
  quoteUrl: 'https://givro.to/api/intent/quote',
  trustedAttestedContracts: {
    'evm:8453': [REVIEWED_HFI_CONTRACTS.base],
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

// Attested quote required; returns approve (仅 ERC-20) + deposit tx
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
会直接拒绝。EVM/Tron 的 `trustedAttestedContracts` 只接受 independently reviewed、
非零的规范 `0x` 合约地址。

## TronWeb 完整发送流程（TRX + TRC-20）

```typescript
import {
  createGivroPayClient,
  GIVRO_PAY_ATTESTED_ABI_TRON,
  TRON_ATTESTED_ZERO_RELAY,
  toBaseUnits,
} from 'givro-sdk';
import { REVIEWED_HFI_CONTRACTS } from './hfi-reviewed-deployments.js';

const chainId = 728126428;
const tronWeb = window.tronWeb;
if (!tronWeb?.defaultAddress?.base58) throw new Error('Connect TronLink first');

const client = createGivroPayClient({
  quoteUrl: 'https://givro.to/api/intent/quote',
  portalBaseUrl: 'https://givro.to',
  trustedAttestedContracts: {
    [`tron:${chainId}`]: [REVIEWED_HFI_CONTRACTS.tron],
  },
});

function toBase58(address: string): string {
  if (address === 'native') address = '0x' + '0'.repeat(40);
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
  // Native TRX 的 tuple token 已规范化为 Solidity ABI zero address。
  const rawOrder = client.tronAttestedOrderTuple(quote);
  const order = { ...rawOrder, token: toBase58(rawOrder.token) };
  const settlementAddress = toBase58(quote.attestedContract!);
  const originRelay = toBase58(TRON_ATTESTED_ZERO_RELAY);
  const settlement = await tronWeb.contract(GIVRO_PAY_ATTESTED_ABI_TRON, settlementAddress);

  let txId: string;
  if (quote.token === 'native') {
    txId = await settlement.depositNativeWithOrder(order, originRelay)
      .send({ callValue: order.amount, feeLimit: 150_000_000 });
  } else {
    const token = await tronWeb.contract().at(toBase58(quote.token));
    const owner = tronWeb.defaultAddress.base58;
    const allowance = BigInt(String(await token.allowance(owner, settlementAddress).call()));
    const required = BigInt(order.amount);
    if (allowance !== required) {
      if (allowance > 0n) {
        const reset = await token.approve(settlementAddress, '0').send({ feeLimit: 100_000_000 });
        await confirm(reset);
      }
      const approve = await token.approve(settlementAddress, order.amount)
        .send({ feeLimit: 100_000_000 }); // exact approval
      await confirm(approve);
    }
    txId = await settlement.depositErc20WithOrder(order, originRelay)
      .send({ feeLimit: 150_000_000 });
  }
  await confirm(txId);
  return txId;
}

await fund('TRX', toBaseUnits('1', 6), '1');
await fund('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', toBaseUnits('10', 6), '10');
```

### 交易构造安全边界

应用必须通过 `GivroPayClient.prepareEvmTransactions` 或
`GivroPayClient.prepareSolanaTransaction` 构造资金交易，并在客户端配置经过发布审核的
`trustedAttestedContracts` / `trustedSolanaPrograms`。SDK 不再从包根导出可直接接受
报价返回地址的低层资金构造器，避免报价服务单独改变 spender、结算合约或 Solana
Program。

## UI 建议

在 Recipient 输入框提供双模式：

```
收款人  [─────────────────────────────────────]
        当前支持：钱包地址 / email / X handle
```

输入检测逻辑：
- 包含 `@` 且不是 `0x` 地址 → 识别为 email 或 X handle
- `0x...` → EVM 地址
- base58（长度 32-44）→ Solana 地址
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
const lamports  = toBaseUnits('0.01', 9);  // SOL:  '10000000'
```

## 注意事项

- `amountWei` 必须是**最小单位**的字符串（USDC 6 位小数，SOL 9 位小数）
- quote 请求对原生 SOL 可传 `'SOL'`（SDK 规范化为 `'native'`）；但当前 public discovery 不提供 Program ID，且 native marker 必须与审核后的交易构造逻辑单独对齐，不能仅凭 registry 开启 native SOL
- 对 native ETH 可传 `'ETH'` 或 `'0x0000000000000000000000000000000000000000'`；对 TRX 可传 `'TRX'` 或 `'native'`
- 报价有有效期（`solanaOrder.claimBefore` / `attestedOrder.claimBefore`），超时需重新报价
- deposit 上链后 Portal indexer 自动检测，通常 5-10 秒内触发通知
- `vm` 字段（或其别名 `ecosystem`）必须传，用于路由到正确的链后端；生产支持范围以 Portal 的链和 token 配置为准
