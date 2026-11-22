# 说话方式（鱼八股）——她每轮都看得见的那一小段

> 2026-11-22 加的。定位：把「AI 腔」从她嘴里挤出去，**规则由主人在面板里逐条增删**，
> 每轮随唤醒提示一起带过去 —— 不让她自己去读文件、也不让她「回答前先调一次工具」。

## 1. 为什么不做成「每次回答前调用一个文件」

最初的设想是让她回答前调一次规则文件。技术上能做，但算下来不划算：

| 做法 | 每轮成本 | 可靠性 |
|---|---|---|
| 每轮注入 300 token | **¥0.0002–0.0009** | 构造性 100% 在场（拼提示词时就写进去了） |
| 让她自己调工具读文件 | 一次完整往返 ≈ **¥0.04**（QQ 平均 67,170 token/次） | 概率性；她不调、或调了不照做，服务端都无法强校验 |

差 45–270 倍。而且「拒绝发送」这种强校验等于让她哑掉，不能用。
所以走注入：**规则进提示词，开关在面板，改完下一轮生效，不重启。**

## 2. 落点只有三处

| 文件 | 干什么 |
|---|---|
| `src/voice-style.js` | **唯一真相**：读文件、归一、校验、渲染成提示词、数用量。面板 import 它，不复制逻辑 |
| `src/bridge.js:16125` | 每次唤醒拼提示词时取这一段的正文 |
| `stellar-manager/` 的「说话方式」卡 | 主人增删原则与词条、看今天用量、保存/回滚 |

桥接侧接线（4 处，改的时候别漏）：

- `src/bridge.js:21` import `{ voiceStylePrompt, recordVoiceStats, voiceStyleFile, voiceStatsFile }`
- `src/bridge.js:16125` `const voiceStyle = voiceStylePrompt({ file: voiceStyleFile(path.join(STELLAR_DIR, 'state')) })` → `const antiAiLine = voiceStyle.text + '\n\n'`
- `src/bridge.js:16281` `lastWakePromptMeta` 里多记 `voiceSource`（file/default/fallback）与 `voiceEntries`，方便事后查「这轮到底注了没有」
- `src/bridge.js:10864` `sendMessagesV2` 成功分支调 `recordVoiceStats(sent, …)`（QQ 发送的唯一汇合点，统计只挂这一处）

## 3. 数据在哪、长什么样

`<DSH_HOME>/stellar/state/voice-style.json`（面板保存时自动建）：

```json
{
  "enabled": true,
  "stats": true,
  "maxChars": 600,
  "principles": [
    "先说她自己的反应，再回答；不要先总结再解释",
    "能一句话说完就一句话；不用破折号串三个短句"
  ],
  "entries": [
    { "id": "ve_1", "from": "这句我记下了", "to": ["知道啦", "懂了"] }
  ],
  "updatedAt": "2026-11-22T06:20:00.000Z"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 回到 2026-11-22 之前那句写死的提示（`LEGACY_FALLBACK`，122 字），词条**不删** |
| `stats` | `true` | 只数数量，不存原文；关掉就不写 `voice-stats.json` |
| `maxChars` | `600` | 渲染硬上限；改大也会被 `VOICE_MAX_CHARS` 夹住 |
| `principles` | 3 条（`DEFAULT_PRINCIPLES`） | 最多 6 条，单条 ≤ 120 字 |
| `entries` | `[]` | 最多 60 条；`from` 她常说的原句，`to` 最多 4 个改法 |

**文件不存在**不算错：按默认 3 条原则照常注入（fail-open，不会因为没配就退回 AI 腔）。
**文件坏了**（JSON 语法错、字段类型不对）：坏字段就地丢掉、错误记进 `error`，还能渲染就渲染；
整份都读不出时退回 `LEGACY_FALLBACK` —— 既不裸奔，也不静默。

## 4. 她实际看到什么

渲染成一段（`VOICE_HEAD` + 原则 + 词条），拼在唤醒提示里原来那句「【反AI味】…」的位置：

```
【说话方式】（主人的偏好，改了措辞不改身份；与人格卡冲突时以人格卡为准）
- 先说她自己的反应，再回答；不要先总结再解释
- 能一句话说完就一句话；不用破折号串三个短句
「这句我记下了」→ 知道啦 / 懂了
```

规则：

- 总量硬上限 **600 字**（她提示词里已经有 26 个块，再多会互相稀释）。
- 超长时**按整行切**，不切半个字；丢了几行记在 `droppedLines`，面板上会写「超了 N 字，超出部分她看不到」。
- 第一条永远写死「与人格卡冲突时以人格卡为准」—— 说话方式只改措辞，不改她是谁。
- 内容全空时用 `DEFAULT_PRINCIPLES` 渲染，不会变成一段空标题。

## 5. 今天用量（只统计，不存原文）

写 `<DSH_HOME>/stellar/state/voice-stats.json`，一天一份，跨天第一次读时自动归零（不写盘）。

| 字段 | 口径 |
|---|---|
| `messages` / `chars` | 今天发出去几条、多少字 |
| `emDash` | 含 `——` 或 `—` 的条数 |
| `enum3` | 三点列举（`1. 2. 3.` / ①②③ / 「首先…其次…最后」）命中 ≥2 项记一次 |
| `serviceWord` | 客服腔词表（11 个：感谢留言 / 希望对你有帮助 / 如有需要 …） |
| `entryHit` | 说到了词条左边的原句（说明旧习惯还在） |
| `entryFollow` | 用上了词条右边的改法（说明规则生效） |

这几项是**趋势**，不是判罚：`entryHit` 高 = 词条没盖住；`emDash`/`enum3` 不降 = 原则写得太抽象。
统计写失败绝不影响发送（`recordVoiceStats` 内部吞异常）。

## 6. 面板怎么用

「设置」页 → **说话方式**：

1. 两个开关：**启用这份词表**（关 = 回到写死那句）、**记今天用量**。
2. **原则**：骨架，加/删/改，最多 6 条。写「什么该做」比写「不许什么」管用。
3. **词条**：左边她常说的、右边换成什么（多个用 `/` 隔开），加/删/改，最多 60 条。
4. 字数条 + 「她实际会看到的那段」折叠区 —— 保存前先看一眼是不是你想要的样子。
5. **保存**：先校验（原则太长 / 有控制字符 / 原句太长 / 没填改法 / 渲染超上限 都会逐条报出来），
   通过才落盘；落盘前把旧文件备份到 `state/voice-style.bak/YYYYMMDD-HHmmss.json`（只留最新 10 个）。
6. **回滚到上一版**：取最新备份写回；回滚本身也是一次写入，会再产生一份备份，所以回滚过的还能再回滚。

路由（都在 `stellar-manager/server.mjs`，放在 `/api/config` 之后）：

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/api/voice-style` | 读权限即可（LAN 也能看） |
| POST | `/api/voice-style` | `requireWrite` → `crossSite` → 写审计 `voice-style-save` |
| POST | `/api/voice-style/restore` | 同上，审计 `voice-style-restore` |

**没有重启这回事**：桥接按 `mtimeMs:size` 缓存这份文件，面板一保存，下一轮唤醒就是新的。

## 7. 怎么关 / 怎么彻底拆

- **只想别用它**：面板把「启用这份词表」关掉（等同 `enabled:false`）→ 回到写死那句，词条原地保留。
- **只想别统计**：关「记今天用量」（`stats:false`）。
- **彻底拆掉**（留兜底，别把提示词搞空）：
  1. 删 `stellar-manager/public/js/voice.js`、index.html 里 `voiceCard` 那一段、`style.css` 末尾的 `.voice-*`；
  2. 删 `stellar-manager/lib/voice-style.js` 与 server.mjs 三个路由；
  3. `src/bridge.js`：删 import，把 `antiAiLine` 改回一句写死的 `LEGACY_FALLBACK`（或留着也行，`src/voice-style.js` 里就有这个常量）；
  4. 删 `src/voice-style.js`、`scripts/test-voice-style.mjs`，并从 `scripts/test-audit.mjs` 摘掉那一行；
  5. 数据文件（`state/voice-style.json`、`voice-stats.json`、`voice-style.bak/`）留着不影响任何东西，想删再删。

## 8. 测试与验收

```bash
node scripts/test-voice-style.mjs      # 35 条断言，全离线（临时目录，不碰真状态）
npm run test:audit                     # 它已进 audit（第 183 条）
```

- 改的是 `src/**`：**要重启 DSH 才生效**。
- 重启后确认两件事：`<DSH_HOME>/stellar/state/voice-style.json` 改一次、发一条消息，`voice-stats.json` 的 `messages` 加 1。
- 想确认注入的是文件而不是兜底：看 `state/context-telemetry*.jsonl` 里 `wake.layers.voiceSource` 是 `file`。

## 9. 已知限制

- **只覆盖 QQ**。B站、QQ空间、小镇各是另一套提示词，见 §10。
- **词表治标**。AI 腔的大头在结构：先总结后解释、三点列举、破折号、总之/换句话说、反问收尾、客服腔。
  所以 `DEFAULT_PRINCIPLES` 三条全是结构规则，词条只做兜底。
- 规则会和人格卡打架：写成「不许说什么」会让她越写越僵，写「换成什么」才有用。
- 面板没有「这句话像不像她」的对照视图，只有 §5 那几个计数。
- 不进 `memory.db`、不进 git 公开仓库（`state/` 本来就不在仓库里）。

## 10. 第二批（B站 / 空间 / 小镇）——可行性

| 渠道 | 注入点 | 改动量 | 每轮成本 | 建议 |
|---|---|---|---|---|
| B站 + QQ空间 | `plugins/stellar/lib/scheduler.js:188 identityContextLines()`（**20 处 B站唤醒共用的前置**） | 加一行 `voicePromptLine()`，P0.3 | +300 token（只在她醒着看 B站时付） | 值得做 |
| 鱼缸小镇 | `src/town-prompt.js:10 townPromptLine()`（单点） | 加一段，P0.2 | +300 token | **建议不做**：小镇是她的私人时间，影子会话提示词已经很长，多这段只会稀释 |

技术上三处都是单点、都不需要新机制（同一份 `voice-style.json`、同一个渲染函数），合计 ≈ 0.5 人日。
要不要做由主人定；默认先只做 QQ，跑一周看 §5 的计数再决定。

## 11. 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/voice-style.js` | 新增 ~380 行 | 读/归一/校验/渲染/计数，桥接与面板共用 |
| `src/bridge.js` | 改 4 处 | import、`antiAiLine` 换源、meta 记来源、发送后计数 |
| `scripts/test-voice-style.mjs` | 新增 | 35 条断言 |
| `scripts/test-audit.mjs` | 加 1 行 | 进 audit |
| `stellar-manager/lib/voice-style.js` | 新增 | 面板侧读写 + 备份/回滚（import 仓库模块） |
| `stellar-manager/server.mjs` | 加 3 个路由 | 见 §6 |
| `stellar-manager/public/index.html` | 加 1 张卡 | `#voiceCard`（设置页） |
| `stellar-manager/public/js/voice.js` | 新增 | 增删改、字数条、预览、保存/回滚 |
| `stellar-manager/public/style.css` | 末尾追加 | `.voice-*` |
| `stellar-manager/public/js/boot.js` | 加 1 行 | 打开页面时预载一次 |
