# 架构决策记录

记录 HFI Pay 关键设计选择的背景和权衡，供后续开发者理解。

---

## ADR-001：deposit tx 构建放在 Portal 端（轻量钱包路径）

**日期**：2026-05-04

### 问题

Solana deposit 指令需要 PDA 推导（`PublicKey.findProgramAddressSync`），
依赖 `@solana/web3.js`。轻量钱包（如浏览器扩展）不一定有此依赖。

### 方案

Portal 提供 `POST /api/intent/build-solana-tx` 端点，
接收 `paymentRef + payerAddress + recentBlockhash`，
返回未签名的 base64 VersionedTransaction。

钱包需要：
1. 提供 payerAddress 和 recentBlockhash（任意 RPC 均可获取）
2. 本地 decode 返回的 VersionedTransaction
3. 验证 independently pinned Program ID、payer、mint/native marker、精确 amount、
   全部 accounts、signer/writable 权限、指令参数，以及不存在额外指令
4. 校验通过后用标准 Ed25519 签名并提交

### 权衡

- 钱包可避免自行实现 PDA 推导，但必须保留完整交易解析和策略校验能力
- 未签名交易仍可能包含恶意 Program、账户权限或额外指令，不能直接签名
- 同一 Portal 不能同时成为 quote 与待签交易内容的唯一信任根
- 有 `@solana/web3.js` 的钱包应使用 `HfiPayClient.prepareSolanaTransaction` 本地构建，并通过 `trustedSolanaPrograms` 独立验证 Program ID

---

## ADR-002：接收方不需要集成 SDK

**日期**：2026-05-04

### 决策

接收方（claim）流程完全在 Portal 网页完成，
接收方只需要任意标准钱包（Phantom、MetaMask 等）。

### 理由

- 降低接收方门槛至零（任何人都能收款，不需要预先安装特定钱包）
- 绑定完成后 relay 自动 claim，接收方日常使用无感知

---

## ADR-003：relay 自动 claim 不需要额外 ZK proof

**日期**：2026-05-04

### 决策

Portal relay 执行 claim 时，合约验证的是链上 IdentityBinding PDA
（`binding[idHash].activeAddr`），不需要额外 proof。

### 当前 claim 路径

```
relay → claim(paymentRef, idHash) → 合约读 binding PDA → 转账到 activeAddr
```

合约信任链上 binding PDA，不信任 Portal relay 提供的目标地址——relay 无法将资金转到 binding 以外的地址。

---

## ADR-004：钱包厂商集成只需关注发送方

**日期**：2026-05-04

### 决策

钱包厂商的集成工作范围限定为「在发送流程中支持 identifier 作为 recipient 输入」。

接收方流程（claim、注册、绑定）统一由 Portal 网页处理。

### 理由

- 钱包厂商改动量最小（引入 npm 包 + 几行逻辑），降低集成阻力
- 接收方无需任何特殊支持，任意钱包均可使用
- 钱包厂商无需理解 PDA、Anchor 等协议细节

### 发送方集成的完整改动量

```typescript
if (isEmail(input) || isXHandle(input)) {
  const quote = await fetchPaymentQuote(portalUrl, { identifier: input, ... });
  const tx = await buildDepositTx(quote, ...);
  wallet.signAndSend(tx);
} else {
  // 原有链上地址路径，不变
}
```

实质改动：~20 行代码 + 1 个 npm 包。

---

## ADR-005：SDK Integrator 身份认证与费用归因

**日期**：2026-05-13

### 背景

第三方钱包（MetaMask、Coinbase Wallet 等）接入 givro-sdk 后，每笔由其用户发起的支付都应归因到该集成方，以便 HFI 按约定比例结算收益分成。

### 约束

1. 集成方（钱包厂商）**不允许有任何运行时 server 调用**——SDK 必须纯客户端，无需向集成方自己的服务器发请求
2. 防止集成方身份被冒用（A 冒充 B 刷归因）
3. HFI 能识别、禁用特定集成方

### 方案选择

**否决：链上签名验证**
合约验证 relay 对每笔 tx 的签名，私钥须嵌入 SDK bundle → 可被提取，等于无保护。

**否决：VendorRegistry 合约白名单 + originShareBps**
链上实时拆分费用，需要 HFI 调用 `setOriginShare()`；结合阶梯分账难以在合约层实现；且"A 填 B 地址"对 A 毫无收益（A 无法取走 B 地址的资金），经济模型天然防止冒用。

**采用：链下归因 + 离线结算**

```
链上：feeBps（全局统一），所有费用打入 HFI treasury
链下：按 originRelayAddress 统计各集成方带来的交易量，周期性结算
```

### 实现细节

1. **地址生成**：集成方自行生成 keypair，将公钥地址提交给 HFI
2. **HFI 审批**：HFI 将地址录入内部 partner 数据库（`partner_type = 'integrator'`）
3. **交易构造**：集成方在每次构造交易时传入自己固定、审核过的归因地址

```typescript
const txs = client.prepareEvmTransactions({
  quote,
  originRelayAddress: "0xYourReviewedRelayAddress",
});
```

Solana 对应在 `prepareSolanaTransaction` 参数中传入 base58
`originRelayAddress`；Tron 集成方在调用合约时把审核后的归因地址作为
`originRelay` 参数传入。

4. **合约调用**：deposit 写入 `originRelayAddress`，合约记录该字段（纯归因，不做链上拆分）
5. **结算**：HFI 按周期统计，依阶梯政策计算应付金额，转账到集成方地址

### 冒用分析

- A 填 B 的地址：费用记到 B，A 无收益，且 A 自掏 gas——经济上反激励
- 未注册地址发起 deposit：归因字段被忽略，收益归 treasury
- 结论：无需技术强制手段，经济模型已足够

---

## ADR-006：SDK Integrator 收益分成政策

**日期**：2026-05-13

### 协议费率

全网统一费率，当前为 **100 bps（1%）**，通过合约 `setFeeBps()` 可调整。
所有费用实时打入 HFI treasury，不做链上拆分。

### 分成比例

集成方分成为协议费的百分比，按每日交易笔数阶梯计算（边际税率模型，类似所得税）：

| 每日笔数区间 | 该区间内集成方分成比例 | HFI 保留比例 |
|-------------|----------------------|-------------|
| 0 – 999 笔 | 50% | 50% |
| 1,000 – 9,999 笔 | 60% | 40% |
| 10,000 – 99,999 笔 | 70% | 30% |
| 100,000+ 笔 | 80% | 20% |

**示例**：某集成方某日 12,000 笔，协议费总计 $1,200：

```
前 999 笔对应费用  $99.90  → 集成方得 $49.95（50%）
1,000–9,999 笔    $900.00 → 集成方得 $540.00（60%）
10,000–12,000 笔  $200.10 → 集成方得 $140.07（70%）
────────────────────────────────────────────
集成方合计                   $730.02（≈60.8%）
```

### 数据库存储

`revenue_share_bps` 字段存储集成方当前档位对应的分成比例，以 bps-of-10000 表示：

| 档位 | 存储值 |
|------|--------|
| 50% | 5000 |
| 60% | 6000 |
| 70% | 7000 |
| 80% | 8000 |

该字段由 HFI 运营方根据集成方实际交易量手动更新。

### 结算周期

按月结算，HFI 统计上月各集成方 `originRelayAddress` 的归因交易量，计算应付金额，转账到集成方控制的对应地址。

### 政策调整

- 协议费率（`feeBps`）调整时，分成比例（百分比）不变，集成方绝对收益随之等比变化
- 阶梯政策为公开信息，HFI 可单方面更新，提前 30 天通知现有集成方
- 合同另有约定的从合同

---

## ADR-007：协议域名标识符

**日期**：2026-05-13

### 决策

所有 claim digest（EVM、Solana）及 auth message 使用统一的 deployment domain 字符串：

```
"hfi-pay:v1"
```

该字符串嵌入在：
- Rust `hfi-pay-core/src/auth.rs`：`DEPLOYMENT_DOMAIN`
- Solana 合约 `lib.rs`：`DEPLOYMENT_DOMAIN`
- EVM 合约 `HfiPayClaimDigest.sol`
- TypeScript SDK `evm/claimDigest.ts`：`HFI_PAY_DEPLOYMENT_DOMAIN`

### 变更历史

原始值为 `"ace-hfi-pay:v1"`，于 2026-05-13 统一改为 `"hfi-pay:v1"`。
所有以上四处需保持严格一致，任何更改必须同步更新合约、SDK、后端。
