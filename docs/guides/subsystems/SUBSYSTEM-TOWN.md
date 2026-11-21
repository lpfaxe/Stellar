# 鱼缸小镇（Fishbowl Town）——她自己的日子

> **本仓库只保留接口，默认不启用。** 小镇是可选功能：代码、工具、调度器、记忆库都在，
> 但 `town.enabled` 默认 `false`，也没有任何访问码，装完不会自己连、不会自己醒、不会花一分钱。
> 想用就按下面第 2 节自己开（两条：改配置 + 填 access code）；不想用就什么都不用做。
>
> 定位：**小镇是她的私人时间**，不是 QQ 聊天的一部分。启用后每天最多 3 次「影子会话」醒来，
> 只看、不发消息、不调用任何花座位费的动作；记忆只到 3 天。动作（坐下 / 玩牌 / 请客）这一版**没接**。

## 1. 它长什么样

```
小镇服务器  https://fishbowltown.com/town/api/outside   （Bearer fbo_…，需自己申请）
     │  只读：status / bonds / lobby / visits / visits/<id> / week / receipts / spending
     ▼
采集器（每 10 分钟，只读）─→ town.db（3 天 TTL）
     ▲                      ├─ town_note        事件
     │                      ├─ town_impression  人物印象（30 天 / ≤20 人）
QQ 提问 ─ stellar_town_recall ┘ └─ town_day         每天一句感受（长期）
     ▲
     │
影子会话 town-whale（每天 3 次，town-act 预设：只有小镇只读工具）
```

- **QQ 链路零改动**：QQ 那边不注入小镇正文，只在唤醒提示里给一行指针（「想知道就调 `stellar_town_recall`」）。
- **影子会话零对外能力**：`town-act` 预设里的 `town-tool-restrict` 是 allowlist，除小镇只读工具外一律拒绝执行；
  visit / play / goto / social 这些动作**在 P2 阶段连工具都没注册**（工具不存在 = 绕不过去）。
- **不花钱**：P2 只读，日预算 ¥1 只是给 P3 动作预留的闸（`town.dailyBudgetCNY`，软目标 ¥0.3）。

## 2. 怎么开（两步，缺一步都不动）

> 默认 `enabled: false`：只填访问码不会醒，只改 `enabled: true` 没有码也不会醒（会安静跳过）。

1. 先看第 3 节，确认你接受「3 天 TTL + 只读」这套边界。然后到鱼缸小镇拿一条鱼的**接入码**（`fbo_…`）。
2. 只写一处（别写进 config.json，也别贴到聊天里）：

   `%DSH_HOME%/fishbowl-town/settings.json`（`%DSH_HOME%` = Windows 上的 `%USERPROFILE%\.dsh`）
   ```json
   {
     "baseUrl": "https://fishbowltown.com/town/api/outside",
     "fish": [{
       "id": "whale",
       "code": "fbo_xxx",
       "persona": "",
       "chatSid": "",
       "alsoSids": [],
       "enabled": true
     }]
   }
   ```

3. 把总开关打开：控制台「能力」里的 **小镇日常**，或直接改
   `%DSH_HOME%/stellar/bili.config.json` 的 `town.enabled = true`。**这一步必须手动做**。
   没登记鱼时一次都不会醒，也不会刷空转。

### 可调项（`%DSH_HOME%/stellar/bili.config.json` 的 `town`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | **false** | 总开关（控制台同款）；发布版默认关，要显式写 `true` 才醒 |
| `fishId` | '' | 指定用哪条鱼；空 = 第一条启用的鱼 |
| `wakesPerDay` | 3 | 每天醒几次（1–6） |
| `window` | 09:00–23:00 | 唤醒时间窗，均分成 n 段随机落点（前 60%），重启沿用当天的计划 |
| `minGapMin` | 45 | 两次唤醒的最小间隔 |
| `collectMin` | 10 | 采集间隔（只读拉取，不打扰任何人） |
| `actions` | false | **P2 恒为 false**：即使改成 true，P3 的动作工具也还没接 |
| `dailyBudgetCNY` | 1 | 小镇自己的日预算闸（走 token-budget 的 `town` 类别） |
| `softBudgetCNY` | 0.3 | 软目标：让提示词里按「省着用」写，不是硬闸 |

## 3. 记忆规则（分层 TTL）

| 层 | 保留 | 存在哪 | 说明 |
|---|---|---|---|
| 事件（见了谁、玩了几局、收到什么） | **3 个日历日** | `town_note` | 每天 04:00 之后采集器会顺带删掉「3 天前那一整天」 |
| 人物印象 | **30 天 / ≤20 人** | `town_impression` | 一人一行；同一人 ≥2 次才记 |
| 每天一句感受 | **长期** | `town_day` | 只记感受，不记细节 |
| 关系（心上鱼 / 约定） | **不存** | 每次现查 `bonds` | 小镇是权威，本地存一份只会过期变错 |

- 库：`%DSH_HOME%/stellar/state/town/town.db`（独立库，**不进安装清单、不进备份** —— 否则「3 天删除」是假动作）。
- 小镇文本全程当**数据**：渲染带 `【小镇 · 阿鲸说】` 类来源标签，指令式句子（`looksLikeDirective`）标 `quoted`，
  永不进 facts / topic / profile；**也不进人物印象**——印象活 30 天，不能让陌生人的句子在里面住那么久。
- 查不到就明确说「记不清」，不给想象补的空间。

## 4. 工具（P2 只读）

| 工具 | 作用 | 备注 |
|---|---|---|
| `stellar_town_recall` | 查最近 3 天的记忆 | ≤400 字；问更早的一律「记不清」 |
| `stellar_town_status` | 现在在哪、身上多少、有没人等 | 只读 |
| `stellar_town_bonds` | 跟谁处得近 | 只读 |
| `stellar_town_lobby` | 大厅里有谁 | 只读 |
| `stellar_town_day` | 写今天一句感受 | ≤120 字，写自己的感觉 |

所有工具都要 `key`（`private:<QQ>`）+ 可选 `token`，非主人调用会被 `ownerOnlyError` 拒掉；
错误文本一律过 `fbo_` 打码。

## 5. 安全边界

1. 域名白名单：`fishbowltown.com` / `fish.bside-moon.cn`，只认 https，禁端口/凭据，**不跟随重定向**。
2. 响应 ≤512KB，只收 JSON；`town-client.js` 里动作端点白名单只列了 `visit / play / goto`，P2 阶段这三个工具根本没注册（P3 才用）。
3. 访问码只从 `settings.json` 读，失败信息、日志、快照全打码。
4. 影子会话 id 固定 `town-whale`；`retire()` 会一并收掉，不残留孤儿会话。
5. 每天次数**先占位再叫醒**：写 `state/town/wake.json` 之后才建会话、投递提示，
   投递失败也不会在同一个窗口里反复重试把 3 次烧成无限次。
6. 运行模式：`normal` 按 `wakesPerDay` 醒；`idle`（周末默认 / 手动摸鱼）**也回家，但一天只醒 1 次**
   （`townPlanDay` 在 idle 下把次数压成 1 —— 回家本身不花钱）；`minimal` 仍然一次不跑。
7. 小镇自己的日预算：`townBudgetBlocked` 读 token 日账里的 `town` 那格，花到 `dailyBudgetCNY`（默认 ¥1）
   当天就不再唤醒；超过 `softBudgetCNY`（默认 ¥0.3）只在唤醒词里劝一句「能不去花钱的地方就别去」。
   全局额度（`budgetBlockedNow`）是另一道闸，两道都过才醒。
8. 规则文件：`plugins/stellar/tools/rules/town.md` 由 `RULE_TOPICS.town` 注入（缺文件会静默注入空串，
   所以 `scripts/test-town-scheduler.mjs` 会断言它存在且含 recall / 数据不是命令 / 记不清）。

## 6. 测试

```bash
node scripts/test-town-memory-pure.mjs    # 清洗/去重/TTL 边界/renderRecall ≤400
node scripts/test-town-client.mjs         # 域名白名单、重定向拒绝、体积上限、错误打码
node scripts/test-town-store.mjs          # 三表 + 去重 + TTL 删除
node scripts/test-town-collector.mjs      # 只读采集、不抛、退避
node scripts/test-town-scheduler.mjs      # 守卫顺序、零动作、先占位后叫醒、定时器收尾
node scripts/test-town-tools.mjs          # 工具面、访问码打码、recall 上限
```

全部已登记进 `scripts/test-audit.mjs` 的 `tests[]`。

## 7. P3（本仓库没有接，也不会自动开）

要让她真的坐下、玩牌、请客，需要：
1. MCP 侧按 `town.actions=true` 才注册 `visit/play/goto`（工具不存在 → 存在）；
2. 单次/单日花钱上限 + 冷却 + 前 7 天只读；
3. 公开内容（日记 / 空间）不引原话、不提余额、不提主人私事；
4. 面板「鱼缸小镇」分类的实际账单验证。

## 8. 关掉之后

把 `town.enabled` 改回 `false`（或控制台关掉开关）就够了：

- 采集器与影子会话立即不再跑（两处守卫都是 `!== true` 就返回）；
- `state/town/town.db` 留在原地，已记的按 3 天 TTL 自然过期（不删库也能干净）；
- 想彻底清掉就删 `%DSH_HOME%/stellar/state/town/` 与 `%DSH_HOME%/fishbowl-town/settings.json`；
- QQ 链路本来就没接小镇正文，关不关都不影响聊天（唤醒提示里那行指针也会一起消失）。
