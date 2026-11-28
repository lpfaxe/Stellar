# 记忆分区、主体页与「做梦」

> 2026-11-27 落地。解决的问题：话题、零碎、见闻、事实都在同一张平表里，
> 她能查到一个话题的原文，却没有「对这个人 / 这件事，我现在怎么看」的一层；
> 也没有一个每天读原文、改错、把零碎归位的整理动作。
>
> 这一层**不换库、不拆库、不引向量库**：仍然是每个角色一个 `memory.db`，
> 只是给现有表加「区 / 主体」两个维度，再加两张页表（主体页、标题历史）。

## 1. 五个记忆区

| code | 显示名 | 落什么 |
| --- | --- | --- |
| `region_01` | QQ聊天 | `private:` / `group:` / `owner:` 会话的话题、零碎、事实、侧写 |
| `region_02` | 好友爱看 | `zone=qzone` 的见闻 |
| `region_03` | B站 | `zone=bili` 的见闻 |
| `region_04` | 小镇 | 小镇来源 |
| `region_05` | 未归类 | 回填时推不出来的，或以后新增来源 |

- **区是显示维度，不是第二个库**。一个角色一个库，跨区检索、事实、隐私闸门都还在原处。
- 显示名存在 `memory_region.name`，可改；代码/回填只认 `code`。
- 区域页**不存正文**：`GET /memory-db` 的 `regions` 是 `regionStats()` 实时算的
  （话题数 / 主体数 / 见闻数 / 页数）。`memory_page` 只放主体页。

## 2. 主体（subject）

`memory_subject` 一行 = 一个区里的一个人 / 一个群 / 一个 UP / 一个地方 / 未识别。

| 列 | 说明 |
| --- | --- |
| `id` | `su_` + sha1(区|类型|外部id) 前 16 位；**绝不用显示名当主键** |
| `region_id` | 所属区 |
| `kind` | `user` / `group` / `friend` / `up` / `place` / `unknown` |
| `external_id` | QQ 号、群号、`owner:`、`self`、UP mid 等 |
| `name` / `aliases` | 显示名与别名（可改，不参与定位） |
| `privacy` | `normal` / `private` / `secret`；主体页继承它 |

`UNIQUE(region_id, kind, external_id)`：同一个人重跑回填/再建话题不会分叉。

## 3. 话题、零碎、见闻的变化

- `topic` 加 `region_id`、`subject_id`、`title_source`（`auto` / `dream` / `manual`）、`dreamed_at`。
- `fragment` 加 `region_id`、`subject_id`、`status`（`inbox` / `routed` / `promoted` / `deferred` / `archived`）、
  `routed_to`、`resolved_at`。**零碎是收件箱，不是与话题并列的一层**：
  稳定偏好升级 `fact`，一次性事件挂到话题/主体，判不了先 `deferred`。
- `zone_note` 加 `region_id`、`subject_id`；见闻仍是见闻，不硬造话题。
- `fact` / `profile` 加 `subject_id`（可按主体收窄，不改原来的 owner 键）。
- 新表：
  - `memory_page`：`region_id` / `subject_id` / `title` / `body` / `links` / `sources` / `privacy` / `version`
  - `memory_page_history`：同一页每次改版都留一份（reason / at）
  - `memory_title_history`：标题每次变更都留旧值与来源（auto/dream/manual）
- `SCHEMA_VERSION` 4 → 5；加列走 `migrateColumns()`（`ALTER TABLE ADD COLUMN`），
  只增量、不改写不删除原件。

## 4. 标题优先级与做梦

### 4.1 优先级

`manual > dream > auto`：

- `manual` 只有人能改，且人可以再改自己；`dream` / `auto` 都覆盖不了。
- `dream` 可以覆盖 `auto`，但覆盖不了 `manual`。
- `auto` 只能覆盖 `auto`（复核 review 用的就是这条，它不再直接 UPDATE topic）。
- 每次改标题都写 `memory_title_history`，可回滚。

### 4.2 做梦（每天 06:30）

触发在 `plugins/stellar/lib/memory-db-timer.js` 的每日 tick（`memory.window`，默认 06:30），
先 `runDream` 再 `runReview`。一次做梦：

1. 取最近 **3 天** `dreamed_at=0` 的 daily 话题（补 backlog），读它们的 `topic_msg` **原文**；
   同时取 `status=inbox/deferred` 的零碎。
2. 一次模型调用（`memory-llm.js`，独立提示词、不带人格），只回 JSON：
   `{"topics":[{"id","title","summary"}],"pages":[{"topic","title","body","links"}],"fragments":[{"id","status","note"}],"reason"}`
3. 成功才写：标题（≤20 字）、摘要（≤60 字）、主体页（≤300 字，**必须带 `sources` 引用话题 id**）、
   零碎状态；最后给所有候选话题打 `dreamed_at`。
4. 任何一步坏（模型不可用、JSON 解析失败、模型给了不存在的 id）→ **整轮不写、不打标记**，
   `job_state('dream')` 记 `pending/failed`。

硬规则：

- **无引用不写页**：`upsertPage` 没有 `sources` 直接拒绝；不许把猜测写成结论。
- 每轮最多 **12 条话题原文** + 30 条零碎；当天做完就不再重复，白天新产生的话题留到明天（仍在 3 天窗口内）。
- 失败/未完成不会锁整天：20 分钟后重试；成功后才写 `job_state('dream')` 的 `done` + 当天 `day_key`。
- 单实例：`job_state('dream')` + 时间戳，30 分钟租约，避免两个 tick 同时写。
- 页面写 `search_doc`（`ref_type='page'`），可被 `stellar_memory_search` 搜到。

### 4.3 与窗口清理的关系

`pruneWindow` 删除 daily 原文的门槛：`day_key <= 今天-3` **且**（`dreamed_at > 0` 或
`day_key < 今天-7`）。缓存表用 `NOT EXISTS` 保护：同 owner/day 只要还有未做梦的 daily，
就不删 `cache_msg` —— 原文是做梦唯一来源，先删就补不回来。

`runReview` 在 prune 前检查 `dreamBacklog()`；>0 时记 `prune-deferred` 并跳过 prune。
效果：模型连坏 7 天也不会把没整理的原文删掉。

## 5. 怎么读（工具与注入）

### 5.1 唤醒注入

`src/memory-read.js` 的同步快照（TTL 60s/5m），顺序：

1. 人物侧写（`memory.catalog.persona` 默认 ≤120 字，保留为一行缓存）
2. 重要事实（按隐私级别过滤）
3. 记忆目录：`formatRegionLine()` 一行 ≤90 字（每区话题/人数）+ 最近 N 条话题标题与 id +
   主体页标题（`［关于xxx］`）

目录总长仍受 `memory.catalog.maxChars`（默认 600 字）约束；区域行只加一行，不放大段正文。

### 5.2 工具

| 工具 | 作用 |
| --- | --- |
| `stellar_memory_catalog` | `regionId` / `subjectId` 过滤；返回区域行、主体列表、主体页标题 |
| `stellar_memory_page` | 给 `pageId` 读主体页正文；不填列最近页。主人全可读；非主人不能读 `secret`，也不能读不属于自己的 `private` 页 |
| `stellar_memory_topic` | 按话题 id 读原文 |
| `stellar_memory_search` | 全文搜（含主体页） |

### 5.3 控制台

3300 面板「记忆」页与 DSH 设置页「记忆」区块都是**只读**视图：

- 写操作（切分 / 清空 / 改事实 / 删见闻 / 改标题）仍在 3300 面板的写接口与 `stellar_memory_*` 工具里。
- 设置页新增：第一排「记忆区」卡片（每区话题/人/页）、最近话题上的区 badge、
  「主体页（做梦整理出的结论）」区块（标题、版本、隐私、正文、更新时间）。

## 6. 回填（一次性）

历史数据没有 `region_id` / `subject_id`。`backfillMemoryRegions({dryRun})`：

- 扫 `topic` / `zone_note` / `fragment` / `fact` / `profile`，按会话 key / zone / owner 推区与主体；
- 推不出的落 `region_05`，不丢；
- `dryRun=true` 只统计不写；`real` 在事务里写，并记 `meta.regions_backfilled`；
- 幂等：重跑只补空值。

建议顺序（本次实际执行过）：

1. 停桥接：`powershell -File scripts/stop-qq-bot.ps1`（SnowLuma 可留着）。
2. 备份：`VACUUM INTO stellar/_backups/memory-<日期>-before-backfill.db`。
3. 跑一次性脚本（本次是 `.tmp/migrate-regions.mjs`，验收后已删；需要重跑按下面步骤重建）：
   `openDb()` 迁移 schema → `backfillMemoryRegions({dryRun:true})` 看统计 → 再 `{dryRun:false}` 写库。
4. 起桥接：`schtasks /run /tn "Stellar Keepalive"`，确认 3100 又在听。

> 回填脚本是一次性的，放工作区根 `.tmp/`，不要放进 `stellar/scripts/`（会被解耦扫描与审计扫到）。

## 7. 成本

- 每天新增原文约 1.3–1.5k 字（约 1k token）；做梦读 3 天原文 + 12 条标题约 1.5–2k token。
- flash 谷时 < ¥0.01/天，峰时 < ¥0.02/天；10 倍增长仍 < ¥0.1/天。
- 不调 embedding、不做向量索引；页面正文只写库，不进每轮提示词（只给标题）。

## 8. 失败码 / 边界

- 页面写失败：`upsertPage` 无 `sources` → 抛错并带原因；调用方记 `job_state`，不静默。
- 做梦失败：见 §4.2；不写、不标记、prune 跳过。
- 回填失败：事务回滚，`meta.regions_backfilled` 不写；下次重跑仍幂等。
- 已知边界：区只按来源粗分（QQ 区不再按「用户A/群A」拆成不同区，而是用 subject 区分）；
  主体页只写文字，不挂图片；控制台第一版只读。

## 9. 回滚

- 数据：`_backups/memory-<日期>-before-backfill.db` 整库换回；
- 代码：本次备份在 `.tmp/backup-20261127-memory/`（含 `memory-db.js` / schema / worker / read / cache /
  bridge / timer / llm / view / test-audit / docs）；
- 没有单独的运行时开关：区/主体/主体页/做梦与这次代码是一体的，回退就是换回上面那份代码与库；
  `memory.window` 只控制时间，不控制做梦是否运行。

## 10. 验证

```
node scripts/test-memory-regions.mjs
node scripts/test-memory-dream.mjs
node scripts/test-memory-db.mjs
node scripts/test-memory-facts.mjs
node scripts/test-memory-tools.mjs
node scripts/test-audit.mjs
```

真机回填验收（2026-11-27）：25 个话题 / 51 条见闻 / 4 条零碎 / 2 条事实 / 5 条侧写 →
5 个主体、`region_01` 25 话题，`region_02` 13 条见闻、`region_03` 38 条见闻，未归类 0。
