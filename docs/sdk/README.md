# Givro SDK 文档

> 当前已验证的真实资金主网试点为 Base + Tron，公开标识符流程为 Email + X handle。手机号、Solana 以及其他主流 EVM 网络属于生产发布目标，只有在对应流程完成发布审核后才可启用。

## 目录

| 文档 | 内容 |
|------|------|
| [01-overview.md](./01-overview.md) | 产品概述、核心流程、技术架构总览 |
| [02-wallet-integration.md](./02-wallet-integration.md) | 钱包厂商集成指南（发送方，按 `vm` / `ecosystem` 集成 EVM、Solana、Tron）|
| [03-claim-flow.md](./03-claim-flow.md) | 接收方 claim 流程、relay 自动 claim、链上绑定 |
| [04-api-reference.md](./04-api-reference.md) | Portal API 端点、SDK 函数签名、合约常量 |
| [06-architecture-decisions.md](./06-architecture-decisions.md) | 架构决策记录（ADR），关键设计选择的背景和权衡 |

## 快速导航

**我是钱包厂商，想支持 Givro 发送** → [02-wallet-integration.md](./02-wallet-integration.md)

**我想了解接收方如何 claim** → [03-claim-flow.md](./03-claim-flow.md)

**我需要 API 文档** → [04-api-reference.md](./04-api-reference.md)

**我是 SDK 集成商，想了解收益分成** → [06-architecture-decisions.md](./06-architecture-decisions.md#adr-005sdk-integrator-身份认证与费用归因)

## 安装

```bash
npm install givro-sdk viem @solana/web3.js @solana/spl-token
# 仅使用本文 wagmi 示例时需要：
npm install wagmi @tanstack/react-query
```

当前根 ESM 入口同时导出 EVM 与 Solana helper，因此 `viem`、
`@solana/web3.js`、`@solana/spl-token` 是必需 peer dependency，并非按链可选。

SDK 按 `vm` / `ecosystem` 路由支付能力，类型层支持 `evm`、`solana`、`tron`。类型或构造器存在不代表对应网络已经上线；当前生产集成只能使用 Portal 实际返回并经发布审核的 Base + Tron 配置。

## 核心概念

**paymentRef** — 每笔付款的唯一标识（32字节 hex，`0x` 前缀），由 Portal 在报价时生成。链上 deposit、链上 claim、Portal 数据库三者通过 paymentRef 关联。

**idHash** — 接收方身份的链上表示（32字节 hex），由 Portal 用 HMAC 从接收方 identifier（邮箱/X handle 等）生成。合约只看到 32 字节，不存储明文身份。

**relay** — Portal 运行的服务，每 30 秒扫描一次。对 enrolled（已绑定过钱包）的接收方，cancel 窗口过后自动执行 claim 交易，资金直接入账。订单状态 `funded` 或 `funded_notified` 均会被 relay 处理。

**IdentityBinding PDA** — 链上存储接收方绑定钱包地址的账户，seeds 为 `["binding", idHash]`。relay claim 时合约从此 PDA 读取目标地址，不信任 relay 传入的参数。任何人可验证，无需信任 Portal。

**cancel window** — 发送方有一段时间（产品默认 600 秒；Portal 安全下限为合约最小 300 秒加 180 秒上链缓冲）可以撤销付款。超过 cancel window 后，资金锁定，只有接收方（或 relay）可以 claim。

**originRelayAddress** — 集成方在交易构造时显式传给 SDK 的固定链上地址，用于交易归因和收益结算。详见 [ADR-005](./06-architecture-decisions.md#adr-005sdk-integrator-身份认证与费用归因)。
