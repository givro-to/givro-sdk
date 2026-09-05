# 接收方 Claim 流程

## 接收方不需要集成任何 SDK

接收方使用标准钱包（MetaMask、TronLink 等）即可完成 claim。
整个流程发生在网页上，无需安装特殊钱包或插件。

## 首次 Claim 流程

```
1. 收到通知
   ├── 邮件："你收到了 100 USDC，点击领取 →"
   └── X："@alice 向你发送了一笔付款，点击领取 →"

2. 点击链接 → 跳转到 givro.to/claim?ref=0x...

3. 身份验证
   ├── email：Google 账号可直接「Continue with Google」，否则输入 OTP
   └── X：点击 "Connect X" 完成 OAuth

4. 连接钱包（任意标准钱包）

5. 钱包签名 → Portal 中继提交 registerMandateAndClaim → 资金到账
   └── 同一笔交易里登记 payout mandate（结算目的地）并领取本笔付款
```

首次领取走 `LazyAttested` 路线：收款人钱包与 Portal attester 各签一次同一份订单元组，
合约要求两者同时成立。attester 无法单独决定资金去向。

## 之后：无人值守结算

首次领取完成后，收款人的 payout mandate 已经在链上。之后任何人发到同一标识符的付款：

```
Portal 报价时把该收款人的 mandate 承诺（mandateCommit）写进订单
        ↓
付款人注资，合约发出 MandateCommitted 事件（结算目的地在注资时即可审计）
        ↓
cancel 窗口过后（产品默认 10 分钟）
        ↓
Portal 中继调用 claimWithMandate —— 无需收款人签名、点击或在场
        ↓
资金直接到达收款人 mandate 指定的钱包
        ↓
收款人只收到一条到账通知
```

这是产品的定义性规则：**领取只在第一次需要人参与，之后全部自动。**

## 中继自动结算的触发条件

Portal 中继周期性扫描 `funded` 状态的订单，满足以下条件时结算：

1. 订单的 `mandateCommit` 非零（报价时该收款人已有 mandate）
2. `cancelBefore` 已过
3. 收款人未关闭自动领取（`/my` 后台可关闭；关闭只停止中继，不解除链上 mandate）

`mandateCommit` 为零的订单（首次收款）不能无人值守结算，只能由收款人本人签名领取。

## 交易所 / 托管地址收款

收款人若希望资金进入无法签名的地址（交易所充值地址等），可在验证邮箱后声明该地址。
声明本身由收款人自己的浏览器或 App 钱包签名，attester 共同签署同一份包含完整订单元组
的授权，合约按 per-intent 授权付款。中继不能自行生成签名者或替换收款地址。

## 绑定关系的管理

收款人可以在 `/my` 后台更新 payout mandate（需重新身份验证）。
更新后有一个 24 小时宽限期，期间原地址仍可撤销，避免攻击者抢先改绑。
