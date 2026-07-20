# 接收方 Claim 流程

## 接收方不需要集成任何 SDK

接收方使用标准钱包（Phantom、MetaMask 等）即可完成 claim。  
整个流程发生在网页上，无需安装特殊钱包或插件。

## 首次 Claim 流程

```
1. 收到通知
   ├── 邮件："你收到了 100 USDC，点击领取 →"
   └── X DM："@alice 向你发送了 50 SOL，点击领取 →"

2. 点击链接 → 跳转到 givro.to/claim?ref=0x...

3. 身份验证
   ├── email：输入 OTP（发到邮箱）
   └── X：点击 "Connect X" 完成 OAuth

4. 连接钱包（任意标准钱包）

5. 钱包签名 → claim 交易上链 → 资金到账

6. 自动绑定
   └── Portal 记录「此 email → 此钱包地址」的绑定关系
```

## 绑定后的自动 claim

首次 claim 完成后，后续所有发到同一 email 的付款**由 Portal relay 自动 claim**，资金直接入账，无需用户操作。

```
以后任何人发到 alice@gmail.com
        ↓
cancel 窗口过后（产品默认 10 分钟）
        ↓
Portal relay 每 30 秒 tick 一次，检测 enrolled + 已绑定的订单
        ↓
relay 执行 claim() 交易（relayer keypair 签名，permissionless）
        ↓
资金直接到达 Alice 绑定的钱包
        ↓
Alice 只收到一条到账通知邮件
```

## relay 自动 claim 的触发条件

Portal relay 每 30 秒扫描一次 `funded` / `funded_notified` 状态的订单。满足以下所有条件时触发 auto-claim：

1. **enrolled**：接收方 email 已在 `auto_claim_enrollments` 表登记（首次 claim 后自动登记）
2. **cancel window 已过**：`cancelBefore` 时间戳已过（产品默认 10 分钟；Portal 的安全下限为合约 5 分钟加 3 分钟上链缓冲）
3. **on-chain binding 存在**：链上 `IdentityBinding PDA` 有有效的 `activeAddr`（即绑定了钱包地址）

**Unbound 重试机制**：如果接收方尚未绑定钱包（binding PDA 不存在），relay 会在每次 tick 时继续重试，直到绑定完成。订单在首次通知后状态变为 `funded_notified`，但 relay 仍会对 `funded_notified` 状态的订单持续尝试 claim。

## 绑定关系的管理

用户可以在 Portal 上更新绑定的钱包地址（需重新身份验证）。  
更新后有一个冷静期（`pendingActivateAt`），避免攻击者抢先绑定。

## 链上绑定（IdentityBinding PDA）

绑定关系同时写入链上 PDA（`binding[idHash].activeAddr`），任何人可验证，无需信任 Portal。

```
PDA 结构（Solana）：
  seeds: ["binding", idHash]
  active_addr (32 bytes)         ← 当前绑定地址
  active_updated_at (i64)
  pending_addr (32 bytes)        ← 变更中的新地址
  pending_activate_at (i64)      ← 冷静期结束时间
```

## claim 路径对比

| 场景 | 触发方式 | 延迟 |
|------|---------|------|
| 首次 claim（未绑定）| 用户打开链接，输入 OTP / X OAuth，连钱包签名 | 手动 |
| 首次绑定后的即时 claim | OTP 验证通过后，Portal 立即执行 claim | ~5 秒 |
| 后续 auto-claim（已绑定）| cancel 窗口后，relay 自动执行 | 最多 30 秒 + cancel 窗口 |
| relay 因 Unbound 延迟后 auto-claim | 用户绑定钱包后，下一个 relay tick | 最多 30 秒 |
