# 记忆系统（memory.db）

> 这一篇描述的是当前这套记忆：一个 SQLite 库，按人归属，后台切分与抽取，唤醒时只注入目录与事实。
> 配置项 `memory.engine` 默认就是 `db`，照默认走就行。
>
> **2026-11-22 起**：`memory.engine='db'` 时，旧的**记忆卡**与**向量记忆**两条管线**整体不启动** ——
> 不渲染、不归档、不衰减、不告警、不摄取、不编码、不建索引；三份注入产物清空，数据文件保留不删。
> 开关以**仓库根 `config.json`** 为准，`$DSH_HOME/stellar/config.json` 只是回退（`src/unified-memory-config.js` 用同一套规则解析，桥接与插件共用）。**恢复办法**：把仓库根 `memory.engine` 改回 `"card"` 并重启 DSH。

## 0 一句话

聊天先落进一张高频写入的**缓冲表**，后台把「有头有尾的对话」切成**话题**、把「某个人的私事」抽成**事实**，
唤醒时只把**目录**（标题 + 句数 + 重要度）和**事实**塞进她的上下文；要细节她自己用工具去翻。

## 1 存在哪

```
~/.dsh/stellar/characters/<角色>/memory/memory.db     ← 库（SQLite，WAL）
~/.dsh/stellar/characters/<角色>/memory/memory-trash/ ← 删除前导出的 JSONL
```

库文件跟着**角色**走；`DSH_HOME` 可以整体改位置。边界：只装「启用之后的新对话」，
旧档案（`memory-card*.jsonl` / `memory-inbox.jsonl` / `vector-memory.jsonl`）一个字节都不读、不迁。

## 2 十二张实体表（+ 一张虚拟表 `search_fts`）

| 表 | 装什么 | 谁写 |
| --- | --- | --- |
| `cache_msg` | 所有收发消息的原始缓冲（`role=user/self`、`process_state`） | 桥接入站/出站双写 |
| `topic` / `topic_msg` | 切出来的话题与它的正文 | 切分作业 |
| `topic_participant` | 一个话题里都有谁说过话（`qq` / `name` / `role` / `msgs`）——「按人找话题」要能走索引，所以单独一张表 | 切分作业 |
| `fragment` | 够长但没配对的独白（单边话） | 切分作业 |
| `fact` | 生日、忌口、过敏、称呼、住址、联系方式 | 切分时正则抽 + 面板手写 |
| `zone_note` | 两个「见闻区」：`bili`（今天刷了什么）/ `qzone`（好友爱看） | 她自己调 `stellar_memory_zone` |
| `profile` | 每人一句侧写（`persona` / `detail` / `tags`） | 每日侧写作业 |
| `style_slice` | 参考角色的说话风格切片（不出现参考角色名字） —— **已停用（2026-11-22）**，`memory.styleRef.enabled` 默认 `false`，只有显式 `true` 才注入 | `scripts/index-style-refs.mjs` |
| `search_doc` / `search_fts` | 检索索引（FTS5 trigram；短词走 LIKE + bigrams） | 写话题/片段时同步 |
| `job_state` | 后台作业进度（`split` / `window` / `profile`） | 作业自身 |
| `meta` | schema 版本、引擎标记 | `openDb()` |

改动表结构要同时改 `src/memory-db-schema.sql` 与 `SCHEMA_VERSION`（当前 **4**）。

## 3 写进来（三条路）

1. **入站**：桥接收到消息 → `cacheInbound()`，`role=user`。
2. **出站**：桥接发出消息 → `cacheOutbound()`，`role=self`。
   注意：MCP 的 `qq_send_message` 走的是 `onebotSend()` 那条路，不是 `sendToQQ()`；
   两条路都要挂缓存，否则库里会出现「只有对方说话」的假象，话题永远切不出来。
3. **她主动记**：`stellar_memory_zone`（见闻区）、`stellar_memory_fact`（重要事实，仅主人可写）。

写库失败**绝不抛到消息链路**：调用方一律走 `safeAppend()`，失败只记日志。

## 4 切分（10 分钟一拍，插件侧定时器）

`plugins/stellar/lib/memory-db-timer.js` 每 **10 分钟**跑一次 `runTick()`，启动 30 秒后先跑一次。硬条件（`src/memory-worker.js`）：

- 同一个 `conversation_key`、相邻两条间隔 **≤ 20 分钟**、一批 **≤ 60 条 / ≤ 6000 字**；
- **段内双方都说过话**（有 `user` 也有 `self`）才建 `topic`。单边的先挂着（`held`）；
  挂满 **2 小时**还没等到对方 → `dropped`；其中 ≥40 字的降级成 `fragment`。
- 所以刚装好时「明明说了生日却没成话题」是正常：她还没回过话。
  **事实抽取不看这个条件** —— 单边消息里说的生日也会被抽成 `fact`。

每天 **06:30** 跑一次窗口清理（`memory.window.hour/minute`）：把 `day_key <= 今天-3` 的缓冲删掉（**积压的旧日也一起清**，不是只清恰好那一天），只留话题与事实；
保留几天由 `memory.window.days` 决定（默认 **3**，1–14 有效，越界回落 3；`src/memory-worker.js` 的 `windowDays()` 是实现），删话题时级联删 `topic_participant`，所有删除先导出到 `memory-trash/<day>-<ISO 时间戳>.jsonl`（同一天重跑不会互相覆盖）。

## 5 读出来（唤醒注入什么）

唤醒提示里只放三小块，按这个顺序：

1. **事实块**（`memoryFactBlockV2`）：这条会话对象的事实（私聊给本人的；群聊只给当前说话人的 `normal` 级）。
2. **目录块**（`memoryCatalogBlockV2`）：最近 8 条话题的标题 + 句数 + 重要度；空库时明写「刚启用，还没有切出任何话题，别编」。
3. **侧写行**：每人一句（≤50 字），群聊给「群 + 当前说话人」。

目录后面还有一段「查法」：问本人就查本人；问别人的先按那个人的号查，查到别人的事**只给结论、别转述细节**。

**群里的两人对话，私聊也看得到**（`soloGroupTopicIds()`）：群聊话题按 `owner_id = group:<群号>` 存，
但「测试群」这种只有主人一个人类的群，内容其实等价于私聊。私聊视角查目录/检索时会额外放行这类话题
（判据是「群会话 + 有他的 `user` 发言 + 没有别的 `user`」），行尾标 **〔群〕**，
并且**不**按「别人的事」处理。存储的归属不动，群视角不受影响，**别人的群话题不会漏进私聊**。

读侧是 stale-while-revalidate（`src/memory-read.js`）：第一次读给空、后台预热，之后读缓存（目录 60 秒 / 事实 60 秒 / 侧写 5 分钟）。
代价是「刚重启的第一条唤醒只有旧卡片」，换来唤醒路径永不阻塞。**事实的缓存键必须带 `audience`** ——
否则群聊会读到上一轮私聊那份，把 `secret` 念给群里。

## 6 事实（`fact`）：谁的事、能不能说

| 字段 | 说明 |
| --- | --- |
| `owner_id` | 这是**谁**的事（数字 QQ / `group:群号`） |
| `kind` | birthday / anniversary / like / dislike / allergy / contact / address / nickname / promise / identity / note |
| `label` + `text` | 一句话标签与正文；`(owner_id, kind, label)` 唯一 —— 同一个人同一件事只有一条 |
| `privacy` | `normal`（可以在群里说）/ `private`（只在跟本人说时提）/ `secret`（只跟本人私聊、面板里看） |
| `weight` | 1~5，越高越先给 |

除了从对话抽，还有一条**不走模型**的路（2026-11-22）：插件每天把 `state/friends.json` 里非空的 `remark` 同步成事实
（`kind=nickname`、`label=备注名`、privacy normal、weight 4、source friends）—— 主人备注成「小土豆」，她就能在跟这个人说话时知道该这么叫。
它和对话里抽出来的「称呼」（`label=称呼`）是两条，不会互相覆盖。

自动抽取只认**第一人称**：「我生日是 1 月 1 日」会记；「他生日 1 月 1」不会记到说话人头上。
默认隐私：`contact`/`address` = secret，`birthday`/`allergy` = private，`like`/`nickname` = normal。

`formatFactsForModel(facts, {audience})` 是唯一出口：`audience=owner` 才给三级，其它一律只给 `normal`。

## 7 见闻区（`zone_note`）：B站 与 好友爱看

两个**不按话题分类**的区，她自己看完内容后写一句总结（正文 ≤400 字，`items` ≤20 个各 ≤80 字）：

- `zone=bili`：今天刷了什么视频，`items` 放 BV 号；
- `zone=qzone`：好友爱看刷到了什么、点了什么赞。

被问「你今天在 b站看了什么视频」时，提示词要求她**先**调 `stellar_memory_zone(action="list", zone="bili", day="today")`，
不要拿聊天记忆凑。同一个区同一天同一段文字只存一条（重复写入只更新 `at`）。

## 8 她手上的记忆工具

| 工具 | 用途 | 谁能用 |
| --- | --- | --- |
| `stellar_memory_catalog` | 看某人的话题目录 | 本人可查自己；跨人仅主人 |
| `stellar_memory_search` | 关键词搜（≥3 字走 FTS，短词走 LIKE） | 同上；`scope=all` 仅主人 |
| `stellar_memory_topic` | 按 `topicId` 读一个话题的正文 | 同上（并校验归属） |
| `stellar_memory_fact` | 事实的增删改查 | **读**按 `audience` 裁隐私；**写/改/删仅主人** |
| `stellar_memory_zone` | 见闻区的写/列/搜/删/清 | 会话本人或内部调度会话 |
| `stellar_memory_read` | 按 `mem_xxx` id 读一条旧格式记忆的原文（兼容用，新装的库里查不到东西） | 仅主人 |

「本人可查自己」靠**会话令牌**认（`resolveAgentIdentity`），不是靠参数里自己报的 `key`。
没有令牌又没有可靠身份时一律拒绝 —— 这条规则的来由见 `docs/guides/operations/SECURITY_BASELINE.md`。

最后一行是 0.8 时代的遗留工具：它读的是 `memory-card*.json` / `memory-card-full.jsonl`，而默认引擎是 `memory.db`（见第 1 节），所以新装环境里它只会回「没找到」。留着是因为 `memory.engine=card` 时还有用。

## 9 面板上能做什么

`stellar-manager` 的「记忆」页有六张卡：记忆库概览、话题目录、零碎记忆、重要事实、B站 记忆、好友爱看记忆。（人物侧写在「通讯录」页，参考库在「设置」页。）
能做的事：搜话题、读一个话题的原文、标为重要、**忘记**（先导出到 `memory-trash/` 再删）、
新增/编辑/删除事实（选人、选类型、选隐私级、权重 1~5）、生成侧写、清空某天某人的见闻区。

所有删除都**先导出再删**（`memory-trash/*.jsonl`）。删错了可以从那里捞回来。

另外，DSH **设置窗口的「记忆」页签**里也有一块只读的「记忆库（memory.db）」：库里有几条、最近话题、重要事实（带隐私级标记）、人物侧写、B站 / 好友爱看两个见闻区。它是**只读**的 —— 要改（标重要、忘掉、加事实）还是走上面那个 3300 面板，避免两个写入口互相打架。

## 10 配置（`config.json` 的 `memory` 段）

```json
{
  "engine": "db",
  "cache": true,
  "worker": true,
  "model": true,
  "catalog": { "titles": 8, "maxChars": 600 },
  "window":  { "hour": 6, "minute": 30, "days": 2 },
  "profile": { "enabled": true, "minMsgs": 6, "maxChars": 50, "hour": 7, "minute": 0 },
  "styleRef":{ "enabled": true, "maxChars": 900, "slices": 2, "triggerOnly": true }
}
```

- `engine`：`db`（默认）。只有显式写 `card` 才会去读旧引擎，新装不要选；`db` 时旧卡与向量记忆两条管线整体不启动（见文首 2026-11-22 说明）。
- `cache`：记不记（关掉就只注入不写库）；`worker`：跑不跑后台作业；`model`：复核/侧写用不用模型。
- `window`：每天清理时间与保留天数；`profile`：侧写的条数门槛、字数上限、时间。
- `styleRef`：参考库只在命中高情绪时注入 2 片、≤900 字符，且**不提供查询工具**。

## 11 常见现象对照

| 你看到的 | 多半是 |
| --- | --- |
| 面板里话题 0 / 零碎 0 | 她还没回过话（话题要求双方发言），不是坏了 |
| 唤醒里说「刚启用新的记忆库」 | 库是空的，这是**有意**的兜底文案，防止她拿旧印象硬编 |
| 刚重启后第一条唤醒没有目录 | 读侧第一次是空的（stale-while-revalidate），下一轮就有 |
| 问生日答不上，但 `fact` 里有 | 本轮的 `audience` 不对（群聊只给 `normal`），或事实属于别人 |
| 群里她完全不提那件事 | 那是 `private`/`secret`，只在跟本人说时提 |
| 日志里出现「记忆卡告警通知失败」 | 2026-11-22 起 `engine='db'` 时旧卡维护器不跑，正常不该再出现；真看到说明配置被改回了 `card` |
