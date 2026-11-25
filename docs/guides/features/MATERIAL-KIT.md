# 素材包（日报与说说共用的记忆 / 配图聚合）

> 2026-11-25 新增。代码：`plugins/stellar/tools/lib/material-kit.mjs`（唯一口径）、
> `plugins/stellar/tools/commands/material.mjs`（命令行出口）、`src/memory-db.js` 的 `recentTopics()`、
> `src/town-kit.js`（小镇那段，见「小镇可以整块删」）。

## 为什么要有这一层

日报（控制台「她的日报」）以前只读 `report digest` 的日志汇总：醒了几次、发了什么、说了几句话。
说说以前只让她 `pool list` 临场找图。两条出口都只看得到「机器记的账」，
看不到她**记下来的**东西 —— B站见闻、好友爱看、跟人聊过什么、在小镇玩了什么；
配图也只有「B站封面池」一个来源，池子空了就硬凑或干脆不配。

「素材包」把这几处收成一份只读文本，两个出口吃同一份口径，谁也不用各自再写一遍路径判断。

## 数据源

| 段落 | 来源 | 取多少 | 备注 |
| --- | --- | --- | --- |
| B站见闻 | `memory.db` 的 `zone_note`（`zone='bili'`） | 每天 ≤6 条、回看 3 天 | `listZoneNotes()`，每条截 180 字 |
| 好友爱看 | 同上（`zone='qzone'`） | 同上 | 和 B站 并列、互不混 |
| 聊天记忆 | `topic` + `topic_participant` | ≤8 条（3 天内） | **只给标题 / 跟谁 / 几条**，不给正文 |
| 她记得的事 | `fact` 表 | ≤6 条 | 只给日报；`privacy='secret'` 一律跳过 |
| 小镇 | `state/town/town.db` + 相册 | 3 天 recall / 3 句 day line / 印象 ≤6 | `town-memory-pure.renderRecall()` 同一套 TTL |
| 配图候选 | `image-pool`（当天的 B站封面）+ 小镇相册 | 各 ≤8 张 | 已经用过的不再出现 |

聊天记忆只给元信息是**故意的**：说说是公开出口，正文一旦进了上下文就有被转述的风险。
两个口径的差别也在这里 —— 说说不给「她记得的事」，条数 6、每条 140 字，
并附一句「只能借感受，不许复述内容、不许提对方的号或真名」。

## 配图权重与兜底额度

- 本地图按来源加权抽：**B站封面 6 : 小镇相册 4**；关键词命中 `caption` 的图再 ×4。
- 网上搜图 / AI 生成是兜底，权重 1，且**一周最多用 1 次**（`FALLBACK_WEEKLY_MAX`）。
  用量不另开账本，直接从 `state/qzone-log.jsonl` 的 `imageSources` 统计（最近 7 天的 post）。
- 最近 30 天配过的图会从候选里剔除（同一份日志的 `imagePaths`），避免连着发同一张封面。
- 权重写在 `material-kit.mjs` 的模块常量里，**不新增配置段**：同一配置值已经有五个来源
  （tools DEFAULTS / `bili.config.json` / `stellar/config.json` / 面板回退 / 桥接），再多一处就没人说得清哪个值真的生效。

## 出口

```
node bili.mjs material --for report      # 日报口径：带事实 / 小镇 / 配图候选
node bili.mjs material --for qzone       # 说说口径：不带事实，条数与字数收窄
node bili.mjs material --for qzone --pick --kw "猫"   # 按权重挑一张，输出路径
node bili.mjs material --json            # 原始素材包（调试）
```

- **日报**：`report digest` 在「她自己的记录」之后多出第 ⑦ 段「记忆」，来自 `buildKit({audience:'report'})`。
  记忆读失败只降级成一行提示，不让整份日报写不出来。
- **说说**：`scheduler.js` 的空间提醒第一步改成 `material --for qzone`，配图用 `--pick`；
  只有本地确实没有贴合图、且兜底额度还剩，才允许搜图 / `image_generate`。
- **规则文件**：`tools/rules/report.md`、`tools/rules/qzone.md` 同步写了同一套规矩（工具首次调用时注入上下文）。
- **日志**：`qzone post` 成功后在 `qzone-log.jsonl` 记 `imagePaths` 与 `imageSources` ——
  只记路径与来源，不记图片内容，也不外发。

## 失败与降级

| 坏了 | 表现 |
| --- | --- |
| 记忆库读不出来 | 见闻 / 聊天段为空，`warnings` 记一句；日报与说说照常出 |
| `town.db` 坏 / 小镇没数据 | 小镇段为空，相册 0 张 |
| 图池空、相册也空 | 配图段写「今天本地没有能用的图」，并给出兜底剩余次数 |
| `qzone-log.jsonl` 读不到 | 兜底用量按 0 算（宁可多发一张兜底，也不能把日报卡死） |

## 小镇可以整块删

小镇的读取逻辑（`town.db` 的存档、人物印象、每天那句、相册索引）住在 `src/town-kit.js`，
不在这里 —— `scripts/town-decoupling-lib.mjs` 要求「小镇逻辑只住 town-* 文件」，
所以 `material-kit.mjs` 里只剩一行 import + 一处调用，拆小镇时这两行一起删。
`src/town-kit.js` 自己也登记在拆除清单里（`npm run town:remove -- --json` 能看到）。
## 改之前先知道

- 新增图片来源要同时改：`classifyImageSource()`、`IMAGE_SOURCE_LABELS`、`renderImageLines()`、
  以及读 `imageSources` 的 `readRecentPosts()`（历史日志里没有新来源会被当成 `other`，兜底额度会多算）。
- 权重 / 兜底次数是常量，改了要同步 `scripts/test-material-kit.mjs`（它钉住 6:4、×4 命中、每周 1 次、排除已用）。
- 素材包**只读**：不写库、不删图、不动索引；唯一读的日志是 `qzone-log.jsonl`。
