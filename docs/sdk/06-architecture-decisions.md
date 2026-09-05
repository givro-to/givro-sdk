# 架构决策记录

记录 Givro 关键设计选择的背景和权衡，供后续开发者理解。

---

## ADR-001：资金交易在客户端本地构造，报价服务不是信任根

**日期**：2026-05-04（2026-09 更新）

### 决策

SDK 在本地把报价里的订单元组编码成 escrow 调用；结算 escrow 地址必须来自集成方在
onboarding 时独立审核并固化的 `trustedAttestedContracts`，报价里的地址只用于比对。

### 权衡

- 集成方需要维护一份 pinned escrow 列表，随 Portal 发布更新
- 换来的是：即使报价服务被攻破，也无法把资金导向未审核的合约

---

## ADR-002：接收方不需要集成 SDK

**日期**：2026-05-04

### 决策

接收方（claim）流程完全在 Portal 网页完成，接收方只需要任意标准钱包（MetaMask、TronLink 等）。

### 理由

- 降低接收方门槛至零（任何人都能收款，不需要预先安装特定钱包）
- 首次领取登记 payout mandate 之后，Portal 中继自动结算，接收方日常使用无感知

---

## ADR-003：中继无人值守结算不需要每笔 ZK proof

**日期**：2026-05-04（2026-08 更新）

### 决策

首次领取时，收款人与 attester 双签登记 payout mandate。之后每笔付款在报价时把该 mandate
的承诺（`mandateCommit`）写进订单，注资时上链并发出 `MandateCommitted` 事件，中继调用
`claimWithMandate` 时合约校验承诺后付款。

### 理由

- 要求收款人为每笔付款生成证明会摧毁「零操作收款」，产品不成立
- 承诺在注资时就上链，结算目的地在领取前即可审计；attester 的签名只能决定是否结算，不能决定给谁
- 需要更高保证的收款人可以注册 ZK 身份，走 `ZkRegistered` 路线

---

## ADR-004：钱包厂商集成只需关注发送方

**日期**：2026-05-04

### 决策

钱包厂商的集成工作范围限定为「在发送流程中支持 identifier 作为 recipient 输入」。
接收方流程（claim、绑定）统一由 Portal 网页处理。

### 发送方集成的完整改动量

```typescript
if (isEmail(input) || isXHandle(input)) {
  const quote = await client.quoteSend({ recipient: input, ... });
  const { approve, deposit } = client.prepareEvmTransactions({ quote });
  // sign approve (if any), then deposit
} else {
  // 原有链上地址路径，不变
}
```

实质改动：~20 行代码 + 1 个 npm 包。

---

## ADR-005：SDK Integrator 身份认证与费用归因

**日期**：2026-05-13（2026-09 更新）

### 背景

第三方钱包接入 givro-sdk 后，每笔由其用户发起的支付都应归因到该集成方，以便 Givro 按约定比例结算收益分成。

### 约束

1. 集成方（钱包厂商）**不允许有任何运行时 server 调用**——SDK 必须纯客户端
2. 防止集成方身份被冒用（A 冒充 B 刷归因）
3. Givro 能识别、禁用特定集成方

### 方案

**采用：按已登记 origin 链下归因 + 离线结算**

```
链上：feeBps（全局统一），所有费用打入 Givro treasury；订单元组不携带归因字段
链下：consumer quote 只接受 Givro 登记过的集成 origin（Turnstile site key 按 origin 签发），
      Givro 按报价请求的 origin 统计各集成方带来的交易量，周期性结算
```

1. 集成方向 Givro 登记自己的集成 origin，Givro 为该 origin 签发 Turnstile site key
2. Givro 将集成方录入内部 partner 数据库（`partner_type = 'integrator'`）
3. 集成方的每笔报价都来自已登记 origin，无需在交易里额外传参
4. Givro 按周期统计，依阶梯政策计算应付金额，转账到集成方地址

### 冒用分析

- 伪造 origin 拿不到匹配的 Turnstile token，报价被拒
- 未登记 origin 的报价在生产被 Turnstile 拒绝，不产生归因
- 结论：归因边界与鉴权边界重合，无需额外链上字段

---

## ADR-006：SDK Integrator 收益分成政策

**日期**：2026-05-13（费率随 `docs/business-rules.md` §4 更新）

### 协议费率

零售标准档为 80 bps + 0.30 美元固定费，单笔上限 25 美元，只在成功领取时扣除；
通过合约 `scheduleFeeConfig` / `executeFeeConfig`（24 小时时间锁）调整。
所有费用实时打入 Givro treasury，不做链上拆分。

### 分成比例

集成方分成为协议费的百分比，按每日交易笔数阶梯计算（边际税率模型，类似所得税）：

| 每日笔数区间 | 该区间内集成方分成比例 | Givro 保留比例 |
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

该字段由 Givro 运营方根据集成方实际交易量手动更新。

### 结算周期

按月结算，Givro 统计上月各集成方的归因交易量，计算应付金额，转账到集成方控制的对应地址。

### 政策调整

- 协议费率调整时，分成比例（百分比）不变，集成方绝对收益随之等比变化
- 阶梯政策为公开信息，Givro 可单方面更新，提前 30 天通知现有集成方
- 合同另有约定的从合同

---

## ADR-007：EIP-712 域

**日期**：2026-08-18

### 决策

所有收款人签名（payout mandate、单笔领取）使用 escrow 的 EIP-712 域：

```
{ name: "HfiPayIntentBlinded", version: "1", chainId, verifyingContract: escrow }
```

该域嵌入在合约 `_buildDomainSeparator`、Portal 服务端与 SDK `escrowDomain` 三处，
必须严格一致。`name` 沿用合约名，是链上常量，不随品牌更名。Tron 与 EVM 共用同一份
字节码；跨链重放由 `chainId` 与 `verifyingContract` 隔离。
