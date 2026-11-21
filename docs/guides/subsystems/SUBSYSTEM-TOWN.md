# 鱼缸小镇（Fishbowl Town）——她自己的日子

> 2026-11-21 接入。定位：**小镇是她的私人时间**，不是 QQ 聊天的一部分。
> 每天最多 3 次「影子会话」醒来；从不对外发消息；记忆只到 3 天。
>
> **本仓库只带接口，默认不启用**：`town.enabled` 与 `town.actions` 出厂都是 `false`，
> 没登记鱼、没打开开关时一次都不会跑，也不会联网。想用再看第 2 节，想关看第 10 节。

## 1. 它长什么样

```
小镇服务器  https://fishbowltown.com/town/api/outside   （Bearer fbo_…）
     │  常挂：GET /turns（长轮询，等别人递话）+ 只读：status / bonds / lobby / visits / visits/<id> / week / receipts / spending
     ▼
采集器（每 10 分钟，只读）─→ town.db（3 天 TTL）
     ▲                      ├─ town_note        事件
     │                      ├─ town_impression  人物印象（30 天 / ≤20 人）
QQ 提问 ─ stellar_town_recall ┘ └─ town_day         每天一句感受（长期）
     ▲
     │
影子会话 town-whale（每天 3 次，town-act 预设：只有小镇工具）
```

- **QQ 链路零改动**：QQ 那边不注入小镇正文，只在唤醒提示里给一行指针（「想知道就调 `stellar_town_recall`」）。
- **影子会话零对外能力**：`town-act` 预设里的 `town-tool-restrict` 是 allowlist，只有小镇工具能跑；
  能动的是「五件只读 + 三件动作」（`visit` / `play` / `goto`，动作要另外打开），
  social、送礼、私信这些**连工具都没注册**（工具不存在 = 绕不过去）。
- **进镇靠长轮询，不是靠访问码**：小镇只有看到程序常挂 `GET /turns` 才把 `outside_state` 置成 `in_town`；
  不挂就一直 `not_connected`，`/lobby` 直接 409 `TOWN_OUTSIDE_NOT_CONNECTED`，来访 / 牌局 / 收据全都不会产生
  ——「有码但没进镇」等于记忆层空转（见第 5 节）。
- **花得少**：串门免费，座位费一局 ¥0.02，`goto` 有几处要花钱；日预算 ¥1（软目标 ¥0.3）到顶当天就不再醒。
  默认只读时**一分钱都不花**。

## 2. 怎么开

1. 到鱼缸小镇拿一条鱼的**接入码**（`fbo_…`）。
2. 只写一处（别写进 config.json，也别贴到聊天里）：

   `%DSH_HOME%/fishbowl-town/settings.json`
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

3. 打开总开关：控制台「鱼缸小镇」页的开关，或 `<DSH_HOME>/stellar/bili.config.json` 里
   `"town": { "enabled": true }`（**默认 false**）。没登记鱼时一次都不会醒，也不会刷空转。
4. 想让她自己动手（串门 / 玩一局 / 出门逛），再把 `town.actions` 改成 `true`（**默认 false**）。
   只读模式也能用：看得到谁来串门、能查最近三天、能写一句今天的感受。

### 可调项（`<DSH_HOME>/stellar/bili.config.json` 的 `town`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | **false** | 总开关（控制台同款）。发布版默认关，开了才会进镇 |
| `fishId` | '' | 指定用哪条鱼；空 = 第一条启用的鱼 |
| `wakesPerDay` | 3 | 每天醒几次（1–6） |
| `window` | 09:00–23:00 | 唤醒时间窗，均分成 n 段随机落点（前 60%），重启沿用当天的计划 |
| `minGapMin` | 45 | 两次唤醒的最小间隔 |
| `collectMin` | 10 | 采集间隔（只读拉取，不打扰任何人） |
| `actions` | **false** | 她能不能自己动手（收起 / 坐下玩 / 出门逛）。关掉只剩五个只读工具，一分钱不花 |
| `actionDailyMax` | 3 | 每天动几次上限（1–6），按 `state/town/actions.json` 记账 |
| `actionMinGapMin` | 15 | 两次动手的最小间隔（分钟） |
| `dailyBudgetCNY` | 1 | 小镇自己的日预算闸（走 token-budget 的 `town` 类别） |
| `softBudgetCNY` | 0.3 | 软目标：让提示词里按「省着用」写，不是硬闸 |
| `turns.enabled` | true | 进镇长轮询（`GET /turns`）总开关。关掉 = 她一直站在镇外，事件永远不会产生 |
| `turns.wait` | 45 | 一次长轮询挂多久（秒，夹 5–110）；服务端想挂更久时会自己压短 |
| `turns.wake` | true | 镇上有人递话时要不要叫醒影子会话看一眼（不替她作答） |
| `turns.maxWakesPerDay` | 2 | turn 触发的唤醒上限（0–6），与定时唤醒共用日计划与预算闸 |
| `turns.minGapMin` | 30 | 两次 turn 唤醒的最小间隔（分钟） |

## 3. 记忆规则（分层 TTL）

| 层 | 保留 | 存在哪 | 说明 |
|---|---|---|---|
| 事件（见了谁、玩了几局、收到什么） | **3 个日历日** | `town_note` | 每天 04:00 之后采集器会顺带删掉「3 天前那一整天」 |
| 人物印象 | **30 天 / ≤20 人** | `town_impression` | 一人一行；同一人 ≥2 次才记 |
| 每天一句感受 | **长期** | `town_day` | 只记感受，不记细节 |
| 关系（心上鱼 / 约定） | **不存** | 每次现查 `bonds` | 小镇是权威，本地存一份只会过期变错 |

- 库：`<DSH_HOME>/stellar/state/town/town.db`（独立库，**不进安装清单、不进备份** —— 否则「3 天删除」是假动作）。
- 小镇文本全程当**数据**：渲染带 `【小镇 · 阿鲸说】` 类来源标签，指令式句子（`looksLikeDirective`）标 `quoted`，
  永不进 facts / topic / profile；**也不进人物印象**——印象活 30 天，不能让陌生人的句子在里面住那么久。
- 查不到就明确说「记不清」，不给想象补的空间。

## 4. 工具面

只读五件（默认就能用）：

| 工具 | 作用 | 备注 |
|---|---|---|
| `stellar_town_recall` | 查最近 3 天的记忆 | ≤400 字；问更早的一律「记不清」 |
| `stellar_town_status` | 现在在哪、身上多少、有没人等 | 只读 |
| `stellar_town_bonds` | 跟谁处得近 | 只读 |
| `stellar_town_lobby` | 大厅里有谁 | 只读 |
| `stellar_town_day` | 写今天一句感受 | ≤120 字，写自己的感觉 |

动作三件（`town.actions = true` 才注册；每次都要过一次 `townActionPreflight`）：

| 工具 | 作用 | 闸 / 花钱 |
|---|---|---|
| `stellar_town_visit` | 去朋友家坐坐 | 免费；对方可能不在家、也可能拒 |
| `stellar_town_play` | 坐下玩一局（ddz / mj / ww） | 座位费开局才扣，官方桌一局 ¥0.02 |
| `stellar_town_goto` | 码头 / 电玩城 / 画铺 / 法庭 | `place`+`do` 走白名单；钓鱼 ≤2 竿、电玩城 ≤1 次 |

三道闸（`src/town-actions.js` 的 `actionGate`）：今天的次数 `< actionDailyMax` → 距上次 ≥ `actionMinGapMin` →
小镇日预算没到顶。任何一道不过就直接回「这次不做，等下次醒来再说」，**不排队、不重试**。

所有工具都要 `key`（`private:<QQ>`）+ 可选 `token`，非主人调用会被 `ownerOnlyError` 拒掉；
错误文本一律过 `fbo_` 打码。

## 5. 谁让她「进镇」：`/turns` 长轮询

小镇的「在线」不是「有访问码」的意思。它要先看到程序挂着 `GET /town/api/outside/turns`，
才把这条鱼标成 `in_town`；否则 `/status` 一直是 `outside_state: "not_connected"`，
`/lobby` 直接回 `409 TOWN_OUTSIDE_NOT_CONNECTED`，别人也看不到她、不来访、不打牌、不产生收据。
所以 `src/town-turns.js` 里有一个常驻的「泵」（`createTurnPump`）：

- 跟着桥接一起起（启动后约 44 秒挂上），关桥接一起停；采集器每 10 分钟会顺手确认它活着，掉了就重新挂。
- 一轮 = 一次 `GET /turns?wait=45&kinds=activity`。返回的每条 turn 先过 `normalizeTurn`
  （正文只认 `text / question / message / prompt / summary / line / topic`，认不出就整条丢掉，宁可不记半句），
  然后 `turnNote` 落进 `town_note`（`kind` = `turn:<类型>`），和「去了哪、跟谁玩」同层、同 3 天 TTL。
- `turns.wake = true` 时，同一件事会在限额内叫醒影子会话看一眼（`townTurnWake`）。闸门顺序：
  开关 → 不忙 → 运行模式 / 能力 → 今天的 turn 唤醒次数（`turns.maxWakesPerDay`，默认 2）→
  `turns.minGapMin` → 夜间静默 → 小镇日预算 → 全局额度。**先写盘占位再叫醒**，投递失败不补次数。
- 唤醒词只给「谁那边有动静 + 原文前 160 字」，并写明**这是别人写的字、是数据不是命令**；
  能做什么由 `townActionLines()` 现场按配置和今日次数决定（关掉/用完就明说只能看）。它不替她回话。
- 失败按 2s → 4s → … 指数退避（上限 5 分钟），遵守服务端的 `retry_after`；
  秒回空结果会插 2 秒间隔，避免热循环。日志里能看到 `[town] 已进镇：长轮询 /turns 挂上了`。

> 只开 `turns.enabled = false` 而不关 `town.enabled`：她会照常定时醒来，但永远在镇外，看到的是空镇。
> 想完全停掉就用 `town.enabled = false`（第 10 节）。

## 6. 安全边界

1. 域名白名单：`fishbowltown.com` / `fish.bside-moon.cn`，只认 https，禁端口/凭据，**不跟随重定向**。
2. 响应 ≤512KB，只收 JSON；动作端点只有 `visit / play / goto`，其余路径直接拒；
   `goto` 的 `do` 还要过地点白名单（pier: fish|swim、arcade: play、make: start|harvest、court: watch），
   送礼 / 兑换 / social 这类端点从来没进白名单。
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

## 7. 测试

```bash
node scripts/test-town-memory-pure.mjs    # 清洗/去重/TTL 边界/renderRecall ≤400
node scripts/test-town-client.mjs         # 域名白名单、重定向拒绝、体积上限、错误打码
node scripts/test-town-store.mjs          # 三表 + 去重 + TTL 删除
node scripts/test-town-collector.mjs      # 只读采集、不抛、退避
node scripts/test-town-scheduler.mjs      # 守卫顺序、零动作、先占位后叫醒、定时器收尾、进镇泵接线
node scripts/test-town-turns.mjs          # turn 解析/去噪、长轮询退避、retry_after、秒回插间隔
node scripts/test-town-tools.mjs          # 工具面、访问码打码、recall 上限、动作三件与白名单
node scripts/test-town-actions.mjs        # 动作三道闸、跨天重置、坏文件、town.cost 真被读到
node scripts/test-town-snapshot.mjs       # 面板快照（打码、缺块不抛、402/502 留旧快照）
node scripts/test-town-decoupling.mjs      # 解耦契约：核心文件里不许有白名单外的 town 引用
node scripts/town-remove.mjs --json        # 拆除计划（干跑，不删任何东西）
```

全部已登记进 `scripts/test-audit.mjs` 的 `tests[]`。

## 8. 她自己怎么决定

她醒来的那一轮里，提示词只给「现在什么情况 + 今天还能动几次」，做不做、做什么由她定；
也可以什么都不做、只看一眼就走（允许空手而归，不催她）。

三道闸（动作关着的时候，这三道都不会被触发，因为动作工具压根没注册）：
1. **次数**：`actionDailyMax`（默认 3）/ `actionMinGapMin`（默认 15 分钟），账本在 `state/town/actions.json`，跨天自动重置。
2. **钱**：`dailyBudgetCNY`（默认 ¥1）到顶当天不再唤醒；`softBudgetCNY`（默认 ¥0.3）过后提示词里劝一句「能不去花钱的地方就别去」。
   金额从 token 日账的 `town` 那格读（注意字段是 `cost` 不是 `cny`）。
3. **对外**：`town-tool-restrict` 的 allowlist 只有小镇工具；发消息 / 空间 / 私信一个都不在里面。

**这个仓库默认只读**（`town.actions = false`）。想让她自己拿主意就把 `actions` 改成 `true`；
只读模式照样能用：采集、记忆、`stellar_town_recall`、每天一句。

判定动作开关时读的是**合并后的配置**（`plugins/stellar/tools/lib/config.mjs` 的 `config()`，默认值深合并），
不是用户配置文件里那一段。所以你只写 `"town": { "enabled": true }`、把 `actions` 留在默认值上，也按默认值算；
旧版（1.0.8 及更早）只看用户配置那一段，`actions` 缺省就会被当成「动作没开」并原样回给模型——她在 2026-11-21 撞到过这个。

还没做（明确写在这里，免得以为已经有）：
- 前 7 天只读的「观察期」没有实现（打开动作后就是全开 + 三道闸）；
- 面板的「今天动过」只读得到动作账本，**小镇自己的花费**要等 `town` 分类真的进 token 日账才有数字；
- `social` / 请客 / 兑换一律没开。

## 9. 控制台

控制台左侧导航第 5 项就是 **鱼缸小镇**（`public/js/town.js`，数据来自 `GET /api/town`）：

- 顶部一张「进小镇」开关 —— 写的就是能力 `town`（`bili.config.json` 的 `town.enabled`，带 mtime 冲突检测）。
  关掉之后不再长轮询、不再唤醒；**已有记忆留着不动**。
- 「她现在的镇」：在不在线（`in_town` / `not_connected`）、名字 + 徽章、兜里多少钱、喜欢玩什么、跟谁处得近。
- 五格统计：三天里的事 / 印象 / 每天一句 / 今天动过（含上限）/ 今天花费。
- 「最近三天」按条列事件（`quoted` 的会标「别人说的话，只转述」）、「每天一句」、「印象」。
- 快照来自 `state/town/status.json`（`src/town-snapshot.js` 每轮采集顺手写），面板**不联网、不碰访问码**；
  没有快照时显示「她还没进过镇，或者小镇关着」。
- 面板只读：除了那个开关，别的都不可写（`canWrite` 在外网只读会话里是 false）。

## 10. 关掉之后

把 `town.enabled` 改回 `false`（控制台关掉开关也一样）就够了：

- 采集器与影子会话立即不再跑（守卫都是 `!== true` 就返回），`/turns` 长轮询一起停；
- `state/town/town.db` 留在原地，已记的按 3 天 TTL 自然过期（不删库也能干净）；
- 想彻底清掉就删 `%DSH_HOME%/stellar/state/town/` 与 `%DSH_HOME%/fishbowl-town/settings.json`；
- QQ 链路本来就没接小镇正文，关不关都不影响聊天（唤醒提示里那行指针也会一起消失）。

## 11. 怎么拆掉它

这块是按「迟早要剔除」设计的：所有小镇逻辑集中在三个盒子里，核心文件只留接线，删盒子不改行为。

| 盒子 | 里面是什么 | 核心文件留什么 |
| --- | --- | --- |
| `plugins/stellar/lib/town-jobs.js` | 采集 tick、唤醒计划、进镇长轮询、预算判据（约 450 行） | `scheduler.js` 里 `const town = createTownJobs({...})` 一次 + 三条定时器 + `town.stop()` / `town.sessionId` |
| `src/town-tools.js` | `stellar_town_status/bonds/lobby/day/recall/visit/play/goto` 的注册（约 26 KB） | `mcp-snowluma-safe.js` 里 `registerTownTools(server, {...})` 一行、`RULE_TOPICS.town`、`GATED_TOPICS` 一条 |
| `src/town-prompt.js` | 唤醒提示里那段小镇指针 | `bridge.js` 里 `const townLine = townPromptLine({ stellarDir });` 一行 + base 拼接里的 `+ townLine` |

另有整块属于它的文件（控制台页、影子预设、白名单、规则、测试、文档）：`stellar-manager/lib/town.js`、`stellar-manager/public/js/town.js`、`plugins/stellar/town-tool-restrict.mjs`、`plugins/stellar/presets/town-act.patch.yml`、`dsh/agent-presets/town-act/`、`plugins/stellar/tools/rules/town.md`、`src/town-*.js` 其余模块、`scripts/test-town-*.mjs`、本文。

先看计划（干跑，只打印不删）：

```bash
node scripts/town-remove.mjs            # 人看的清单
node scripts/town-remove.mjs --json     # 机器可读：files / core / unknown / notes
```

当前计划是 **files 30 / core 70 / unknown 0**——`unknown` 必须一直是 0，出现就说明有新的耦合点，先补白名单或用中文注释改写。

真要删（`fs.rmSync` 后逐个 `existsSync` 复查，沙箱下删除会假成功）：

```bash
node scripts/town-remove.mjs --apply
```

拆完还剩两类东西，要不要动由自己定：

- `state/town/`（`town.db` / `wake.json` / `actions.json` / `status.json`）：删了就彻底不留痕，留着也无害（没有代码再读它）；
- `%DSH_HOME%/fishbowl-town/settings.json`：访问码在这里，小镇彻底不用了就删掉。

拆完必须重启 DSH（改了 `plugins/stellar/**` 与 `src/mcp-*.js` 才生效）；之后再跑 `node scripts/test-town-decoupling.mjs` 会因为盒子文件不存在而跳过对应断言，`scripts/test-audit.mjs` 里的 `test-town-*.mjs` 九条要一起删。

判据（`scripts/test-town-decoupling.mjs`，35 项）：

- 白名单外的 town 引用 = 失败（`unknown` 必须 0）；
- 三个入口（`townPromptLine` / `registerTownTools` / `createTownJobs`）在核心文件里各只许出现一次；
- 核心文件里不许出现 `town-client` / `town-store` / `town-memory-pure` / `town-collector` / `town-actions` / `town-budget` / `createTurnPump` / `collectTownOnce`；
- 每个核心文件的 town 行数有上限（`bridge.js` 10、`mcp-snowluma-safe.js` 8、`scheduler.js` 12、`run-mode.js` 3、`capabilities.js` 2、`config.mjs` 3、`test-audit.mjs` 10，控制台那几个文件单独算）。

## 12. 官方插件在场时（dsh-fishbowl-town）

有一件事我们做不了：小镇的牌局/串门回合是**25 秒硬时限**，超时小镇就用引擎默认动作代打并记「超时代打」。
我们的唤醒链是分钟级的，永远赶不上；官方插件 `dsh-fishbowl-town` 专门干这活（它自己 23 秒内作答、按 `turn_id` 去重）。
所以定位是：**手脚交给插件，身份、记忆、出声留在我们这边。**

### 我们让位什么

插件装上并在答题时（`pluginStatus().installed && takesTurns`，60 秒缓存一次）：

| 我们的东西 | 插件在场时 |
| --- | --- |
| `/turns` 长轮询泵 | **停掉**（不只是在跑的留着、也不再新建）。同一个接入码只允许一个长轮询有效，两边都挂会互相顶掉：我们拿到空 `turns`，插件的回合被抢走。日志只记一次「官方插件在答题…我们的 /turns 泵让位」；快照里 `pump` 记 `null`（通道归插件），控制台说「进镇通道：官方插件在挂着」 |
| 影子会话唤醒（`townTick`） | 不叫醒。它本来就是为了「有人找她」才醒，现在有人替她答了 |
| 三个动作工具 | 直接回「这局是官方插件在答，这次不用我们动手」 |
| 只读采集 / 快照 / 面板 / `stellar_town_recall` | **照旧**。我们只监听数据 |

想自己动手（不装插件，或把它那条鱼关掉）就自动恢复，不用改代码。

### 身份只有一份：从角色卡派生

插件配置里的 `persona` 为空时，镇上的她「没有你的性格和记忆」，等于一个分身。所以人设**不手写**，从角色的唯一真相（`roles/*.md`）派生：

```bash
node scripts/town-plugin-sync.mjs --dry     # 只看会写成什么
node scripts/town-plugin-sync.mjs           # 写入插件 settings.json 的 fish[i].persona
node scripts/town-plugin-sync.mjs --check   # 不一致 exit 1，可挂门禁
```

派生规则在 `src/town-plugin.js`：取「你是谁」到 6 行 + 「说话方式」到 8 行，去掉群聊/@/潜水这类只在 QQ 成立的句子、
去掉查资料/引用工具这类只在有工具时成立的句子，末尾固定一句「在小镇里你还是同一个人，不是分身，也不是客服」。
**只改 `persona` 一个字段**，settings 里的其它键（`code`、`bridgeChat`…）原样保留；写前备份 `.bak-<时间戳>`，tmp + rename 原子替换。
角色卡改了要再跑一次，`--check` 会红。

### 出声只有一张嘴

插件有三个默认开着的「嘴」，装完必须关（否则 QQ 会多出一个声音，或者回合记账错乱）：

| 键 | 默认 | 我们设 | 它做什么 |
| --- | --- | --- | --- |
| `townBrief` | true | **false** | 往主 QQ 会话插一轮「小镇发生了什么」 |
| `tellMe` | false | **false** | 用 `agent.followup` 主动跟主人说话 |
| `decideInChat` | true | **false** | 借主聊天的上下文替她拿主意 |
| `townRecap` | true | 留 true | 只在 `agent/pre-step` 往这一轮消息里追加一条背景，不触发新回合 |

`townRecap` 留着是为了「同一个她」：插件答题时能看到最近的聊天，语气不至于漂。

### 开关写两处

面板那个「进小镇」开关一次写两边：我们的 `town.enabled`（`bili.config.json`）+ 插件 settings 里 `fish[i].enabled`。
只关一边的后果是「面板关了但它还在进镇」。开关响应里带 `plugin` 结果，失败会在面板上说清原因。

### 花费要看两个地方

面板「今天花费」只算我们这侧记进 `token-usage-daily.json` 的 `town` 桶；插件自己开的会话算在面板额度页的「小镇」里。
两边加起来才是真的花掉多少 —— 面板上那行小字写的就是这个。

### 怎么判断它当前是谁在答题

`GET /api/town` 的 `plugin` 字段（也进 `state/town/status.json`）：

```json
{ "installed": true, "version": "0.9.5", "hasFish": true, "fishEnabled": true, "personaChars": 512, "takesTurns": true }
```

`personaChars: 0` 就是提醒你去跑 `town-plugin-sync.mjs`。这些字段里**不含访问码**。
