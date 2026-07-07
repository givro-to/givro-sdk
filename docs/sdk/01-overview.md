# HFI Pay — 产品概述

## 是什么

HFI Pay 是一套协议 + SDK，让钱包用户可以**直接把 crypto 发到 email 地址、X handle 或手机号**，无需知道对方的链上地址。

发送方体验和普通转账完全一样，唯一的区别是 recipient 字段填的是 `alice@gmail.com` 或 `@alice`，而不是 `7xKX...` 这样的地址。

## 核心产品流程

### 发送方

1. 用户在钱包里选择链、token、填写金额
2. Recipient 字段填 email / X handle / 手机号
3. 钱包调用 HFI Pay SDK 拿报价，构建 deposit 交易
4. 用户签名，交易上链
5. 完成 ✅

**用户无感，与普通转账无区别。**

### 接收方

1. 收到 HFI Pay 邮件通知或 X DM
2. 点击链接，跳转到 `hfi.network/claim`（或钱包 app 内嵌页面）
3. 完成身份验证（邮件 OTP / X OAuth）
4. 连接任意钱包（Phantom、MetaMask 等）签名 claim
5. 收到 crypto ✅
6. 此后所有发到该 email 的 crypto **自动归集到此钱包**，无需每次手动 claim

**接收方不需要任何特殊钱包，任意标准钱包均可。**

## 技术架构总览

```
发送方钱包                    HFI Pay Portal                   接收方
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
- **按 VM 路由**：发送方通过 `vm` / `ecosystem` 指定 `evm`、`solana` 或 `tron`，Portal 决定具体启用的链和 token
- **Relay 自动 claim**：首次完成绑定后，后续 Portal relay 自动将资金转入绑定地址
- **链上可验证**：IdentityBinding PDA 公开存储绑定关系，任何人可独立验证，无需信任 Portal
