# Givro SDK 文档

> 生产环境为 Base、BNB Smart Chain 与 Tron 主网，公开标识符流程为 Email、X handle 与 Givro ID。手机号与 Solana 均未上线；只有在对应流程完成发布审核并出现在 Portal 配置中后才可启用。

## 目录

| 文档 | 内容 |
|------|------|
| [01-overview.md](./01-overview.md) | 产品概述、核心流程、技术架构总览 |
| [02-wallet-integration.md](./02-wallet-integration.md) | 钱包厂商集成指南（发送方，按 `vm` / `ecosystem` 集成 EVM 与 Tron）|
| [03-claim-flow.md](./03-claim-flow.md) | 接收方 claim 流程、首次收款绑定、无人值守结算 |
| [04-api-reference.md](./04-api-reference.md) | Portal API 端点、SDK 函数签名、合约常量 |
| [06-architecture-decisions.md](./06-architecture-decisions.md) | 架构决策记录（ADR），关键设计选择的背景和权衡 |

## 快速导航

**我是钱包厂商，想支持 Givro 发送** → [02-wallet-integration.md](./02-wallet-integration.md)

**我想了解接收方如何 claim** → [03-claim-flow.md](./03-claim-flow.md)

**我需要 API 文档** → [04-api-reference.md](./04-api-reference.md)

**我是 SDK 集成商，想了解收益分成** → [06-architecture-decisions.md](./06-architecture-decisions.md#adr-005sdk-integrator-身份认证与费用归因)

## 安装

```bash
npm install givro-sdk viem
# 仅使用本文 wagmi 示例时需要：
npm install wagmi @tanstack/react-query
```

`viem` 是唯一必需的 peer dependency。

SDK 按 `vm` / `ecosystem` 路由支付能力，类型层支持 `evm` 与 `tron`。类型或构造器存在不代表对应网络已经上线；生产集成只能使用 Portal 实际返回并经发布审核的链和 token 配置。

## 核心概念

**paymentRef** — 每笔付款的唯一标识（32 字节 hex，`0x` 前缀），由 Portal 在报价时生成。链上 deposit、链上 claim、Portal 数据库三者通过 paymentRef 关联。

**intentId / blindedBinding** — 每笔付款各自独立生成的随机 intent 标识与盲化绑定值。escrow 拒绝重复的 `blindedBinding`，因此链上不存在任何跨付款复用的收款人标签；观察者无法从链上数据把两笔发给同一个人的付款关联起来。

**escrow（`attestedContract`）** — 每条链一份结算合约。Portal 在 `GET /api/public/supported-assets` 中公布其地址，报价里以 `attestedContract` 携带同一个值。集成方必须独立审核后固化进自己的 `trustedAttestedContracts`。

**mandateCommit** — 注资时提交上链的结算目的地承诺。收款人已有 payout mandate 时为 `keccak256(abi.encode(mandateSigner, salt))`；首次收款时为全零，表示这笔款只能由收款人本人签名领取。

**claimAuthorization** — 订单在注资前就固定的领取授权路线：`0 = LazyAttested`（首次收款，收款人与 attester 双签），`1 = ZkRegistered`（需要零知识证明）。

**cancel window** — 发送方在一段时间内（产品默认 600 秒；合约下限 300 秒）可以撤销付款。超过 cancel window 后资金锁定，只能由收款人领取或到期退款。

**集成方归因** — 按 Givro 登记的集成 origin 链下统计，不需要交易字段，详见 [ADR-005](./06-architecture-decisions.md#adr-005sdk-integrator-身份认证与费用归因)。
