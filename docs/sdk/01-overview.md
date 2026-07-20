# Givro — 产品概述

> 当前已验证的真实资金主网试点为 Base + Tron，公开标识符流程为 Email + X handle。本文中的手机号、Solana 与其他 EVM 网络能力描述为 SDK 架构及生产发布目标，不代表对应能力当前已上线。

## 是什么

Givro 是一套协议 + SDK，让钱包用户可以**直接把 crypto 发到受支持的人类可读标识符**，无需预先知道对方的链上地址；当前公开流程支持 email 和 X handle。

发送方体验和普通转账完全一样，唯一的区别是 recipient 字段填的是 `alice@gmail.com` 或 `@alice`，而不是 `7xKX...` 这样的地址。

## 核心产品流程

### 发送方

1. 用户在钱包里选择链、token、填写金额
2. Recipient 字段填写当前 Portal 启用的标识符（公开流程为 email / X handle）
3. 钱包调用 Givro SDK 拿报价，构建 deposit 交易
4. 用户签名，交易上链
5. 完成 ✅

**用户无感，与普通转账无区别。**

### 接收方

1. 收到 Givro 邮件通知或 X DM
2. 点击链接，跳转到 `givro.to/claim`（或钱包 app 内嵌页面）
3. 完成身份验证（邮件 OTP / X OAuth）
4. 连接任意钱包（Phantom、MetaMask 等）签名 claim
5. 收到 crypto ✅
6. 此后所有发到该 email 的 crypto **自动归集到此钱包**，无需每次手动 claim

**接收方不需要任何特殊钱包，任意标准钱包均可。**

## 技术架构总览

```
发送方钱包                    Givro Portal                   接收方
────────────                 ──────────────                  ──────────
fetchPaymentQuote()  ──────> 生成 paymentRef + idHash         
                             （HMAC，Portal 持有密钥）         
buildDepositTx()             
wallet.sign()        
sendTransaction()    ──────> vm/ecosystem 对应链上             
                             indexer 检测存款                  
                    ──────────────────────────────────────>  邮件/DM 通知
                                                             用户点链接
                             OTP / X OAuth 验证 <──────────── 
                             relay 执行 claim  ──────────────> 资金到账
                             同时完成钱包绑定                  
                             （首次 claim 后自动生效）          
```

## 关键设计原则

- **发送方无感知**：无需知道对方是否已有钱包，无需提前注册
- **接收方零门槛**：任意标准钱包即可 claim，无需集成任何 SDK
- **按 VM 路由**：发送方通过 `vm` / `ecosystem` 指定 SDK 支持的虚拟机类型，Portal 决定当前实际启用并通过发布审核的链和 token
- **Relay 自动 claim**：首次完成绑定后，后续 Portal relay 自动将资金转入绑定地址
- **链上可验证**：IdentityBinding PDA 公开存储绑定关系，任何人可独立验证，无需信任 Portal
