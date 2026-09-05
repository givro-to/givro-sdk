# Givro — 产品概述

> 生产环境为 Base、BNB Smart Chain 与 Tron 主网，公开标识符流程为 Email、X handle 与 Givro ID。手机号与 Solana 为未来目标，本文不把它们描述为已上线能力。

## 是什么

Givro 是一套协议 + SDK，让钱包用户可以**直接把 crypto 发到人类可读的标识符**，无需预先知道对方的链上地址。

发送方体验和普通转账完全一样，唯一的区别是 recipient 字段填的是 `alice@gmail.com` 或 `@alice`，而不是 `0x7f3a…` 这样的地址。

## 核心产品流程

### 发送方

1. 用户在钱包里选择链、token、填写金额
2. Recipient 字段填写 Portal 启用的标识符（email / X handle / Givro ID）
3. 钱包调用 Givro SDK 拿报价，构建 deposit 交易
4. 用户签名，交易上链
5. 完成 ✅

**用户无感，与普通转账无区别。**

### 接收方

1. 收到 Givro 邮件通知或 X 通知
2. 点击链接，跳转到 `givro.to/claim`
3. 完成身份验证（邮件 OTP / Google 登录 / X OAuth）
4. 连接任意钱包（MetaMask、TronLink 等）签名
5. 收到 crypto ✅
6. 此后所有发到该标识符的 crypto **由 Portal 中继自动结算到该钱包**，无需再操作

**接收方不需要任何特殊钱包，任意标准钱包均可。**

## 技术架构总览

```
发送方钱包                    Givro Portal                         接收方
────────────                 ──────────────                        ──────────
quoteSend()          ──────> 生成 paymentRef、intentId、
                             blindedBinding（每笔独立随机）
prepareEvmTransactions()     以及本笔的 mandateCommit
wallet.sign()
sendTransaction()    ──────> 链上 escrow 记录订单元组
                             indexer 检测存款
                    ──────────────────────────────────────────>  邮件 / X 通知
                                                                 用户点链接
                             OTP / Google / X OAuth 验证 <────────
                             首次：收款人签名 + attester 签名
                             登记 payout mandate 并领取  ───────>  资金到账
                             之后：relay 调用 claimWithMandate
                             无需收款人参与             ───────>  资金到账
```

## 关键设计原则

- **发送方无感知**：无需知道对方是否已有钱包，无需提前注册
- **接收方零门槛**：任意标准钱包即可 claim，无需集成任何 SDK
- **按 VM 路由**：发送方通过 `vm` / `ecosystem` 指定虚拟机类型，Portal 决定当前实际启用并通过发布审核的链和 token
- **一次绑定，之后无人值守**：首次领取时登记 payout mandate，之后 Portal 中继自动结算
- **非托管**：结算目的地在注资时以 `mandateCommit` 提交上链，合约在领取时校验；HFI 的签名只能决定「是否结算」，不能决定「结算给谁」
- **链上不可关联**：每笔付款使用独立的 `blindedBinding`，链上没有任何跨付款复用的收款人标签
