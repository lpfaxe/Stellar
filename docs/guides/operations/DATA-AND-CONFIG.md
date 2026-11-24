# 数据与配置（DATA-AND-CONFIG）

> 三份配置文件、状态文件全表、备份与清理约定。**不要**手改 `state/` 里的东西，除非这一篇写了可以。

## 0 一张图

```
<仓库>/config.json                  桥接读这份；记忆开关的权威来源（ownerQQ / socialV2 / memory / consolePort / dsh）
~/.dsh/stellar/config.json          插件主配置；仓库那份没有 memory 段时才回退到这里读记忆（platforms / admin / bridge / 界面偏好）
~/.dsh/stellar/bili.config.json    B站 CLI 读这份（生物钟 / 额度 / 白名单 / 发动态口径）

~/.dsh/stellar/state/              运行时状态（未读、额度、审计、日志、运行模式、待办）
~/.dsh/stellar/characters/<角色>/  角色卡 + B站凭据 + memory/memory.db
```

## 1 `<仓库>/config.json`（桥接）

入口：`src/bridge.js` 启动时读；面板「全部参数」与 `配置.bat` 也编辑它。

| 键 | 作用 | 注意 |
| --- | --- | --- |
| `ownerQQ` / `admin` | 主人 QQ（谁能用主人级工具） | **空 = 谁都不理**，首次启动必须先填 |
| `allow.private` / `allow.groups` | 白名单 | 空 = 谁都不理（群里也不理） |
| `deny` | 黑名单 | 优先于白名单 |
| `snowluma.wsUrl` / `accessToken` | QQ 网关地址与令牌 | 默认 `ws://127.0.0.1:3001` |
| `consolePort` / `consoleToken` | 桥接自带控制台 | 默认 3100；令牌为空时自动生成到 `state/console-token` |
| `socialV2.selfImage` | 她自己的形象图（`qq_get_self_image` 用） | 留空则找 `assets/self-image.png` / `.jpg` / `.webp`；都没有就回「还没有形象图片」 |
| `socialV2.*` | 回复策略、唤醒条件、表情、收尾、图片额度 | 见各功能篇 |
| `socialV2.send.allowBiliLinksInGroups` | 群里能不能发 B站 视频链接 | **默认 `false`**：群聊出站一律剥掉 `bilibili.com` / `b23.tv` 链接与 `BV` 号，纯链接拒发（`GROUP_BILI_LINK`）、正文里的回 `linksStripped`；改 `true` 才放行。私聊不受影响（`src/group-link-guard.js`） |
| `socialV2.town.chatSync` | QQ → 小镇的会话重绑 | **默认开**；写 `false` 才关。主人私聊的 DSH 会话 id 变了就把新 id 写进官方插件的 `alsoSids`，失败静默退避 10 分钟（`src/town-chat-sync.js`，见 [SUBSYSTEM-TOWN.md](../subsystems/SUBSYSTEM-TOWN.md) 第 16 节） |
| `memory.engine` | `db` / `card` | **记忆总开关**：`db`=记忆库（`memory.db`）唯一真相，旧记忆卡与向量记忆两条管线**整体不启动**（2026-11-22）；`card`=旧行为。当前是 `db` |
| `memory.*` | 其余记忆子块 | 见 [../features/MEMORY.md](../features/MEMORY.md)；`memory.window.days` 是 daily 话题保留天数（默认 3） |
| `biliBridge.dynamics.enabled` | 把她自己的 B站 空间动态同步到群 | **默认 `true`**；不想要群里出现链接就设 `false`（代码与 `share` 配置都保留）。**改完必须重启 DSH** —— 轮询定时器只在桥接启动时创建 |
| `memoryCard` | 旧记忆卡配置 | `memory.engine='db'` 时整段不生效（定时器不启动、维护早退），数据文件保留 |
| `dsh.*` | DSH 地址、模型、思考强度、认证头 | 端口会被 `dsh-port.js` 自动纠正 |
| `pricing` | 价目表覆盖项 | 留空用 `src/model-prices.js` 官方价 |
| `fishGuard` | 鱼群保护名单 | **默认空 = 不拦** |
| `greetings` | 早安问候 | 默认关 |

## 2 `~/.dsh/stellar/config.json`（插件）

入口：插件设置页保存时写；结构由 `plugins/stellar/lib/store.js` 的 `DEFAULT_UNIFIED` 定义（读时深合并）。

**两份 config 谁说了算**：仓库根 `config.json` 优先——它有 `memory` 段就用它；没有才回退到这份。解析逻辑只有一份 `src/unified-memory-config.js`，桥接与插件共用，所以 `memory.engine` 不会出现「一边 db、一边 card」的两套答案。改记忆开关请改**仓库根**那份。

| 键 | 作用 |
| --- | --- |
| `platforms.start` / `platforms.enabled` | 开 DSH 时要不要连带起桥接 / B站 |
| `bridge.autoStart`（旧字段） | 仍被读取，用来推导 `platforms.start` |
| `admin` | 管理员（B站 ⇄ QQ 同一个人），空则回退 `config.json` 的 `ownerQQ` |
| 界面偏好 | 上次停在哪一页、紧凑模式等 |

**这份不复制桥接的配置**：桥接读仓库根那份，插件读这份；但**记忆开关是例外**——`memory.engine` 仓库根优先、这份只作回退（见上）。改错地方的表现是「改了没反应」。

## 3 `~/.dsh/stellar/bili.config.json`（B站）

入口：B站 页签保存；B站 CLI 的命令行参数也能临时覆盖。
**不要**手写 `STELLAR_BILI_CONFIG` 之外的路径，除非你知道 `DSH_HOME` 被改了。

| 段 | 作用 |
| --- | --- |
| `night` | 生物钟：今晚几点醒、看几个、抽几帧 |
| `qzone` | QQ空间：`weekly.min` 本周目标（默认 **7** 条，周一为界）、`dailyLimit` 硬上限、好友爱看（看几条/赞几个/评几个）、关注谁 |
| `limits` | 每日额度：视频数、点赞数、评论数、分享数 |
| `wake` | **醒来账**：`mergeGapMin`（默认 20，次生叫醒被压到上一趟收工 N 分钟后）+ `maxCallsPerTurn`（默认 12，每趟提示词里的工具调用上限）。**两项写 `0` = 关；删键 = 用默认值**（见 [../subsystems/SUBSYSTEM-BILI.md](../subsystems/SUBSYSTEM-BILI.md)） |
| `budget` | **每日金额闸**：`dailyCNY`（默认 0.8），读 `token-usage-daily.json` 的 `bili.cost`，到上限当天所有主动醒一律拦（含生物钟 / 监听 / 空间监看）。**写 `0` = 不限**；另有一道 token 额度闸，两道各管一个维度 |
| `fishGuard` | B站 侧鱼群保护（与 QQ 侧是两份配置，默认都空） |
| `notify` | 通知与免打扰 |

注意：**`qzone` 与 `limits` 会同时被桥接和面板读**。改完下一轮生效，不用重启。

`qzone.weekly.min` 是**目标不是保证**：调度器每天算「本周还欠几条 / 本周还剩几天」，只要当天已发条数没到
`min(dailyLimit, 欠账 ≥ 剩余天数 ? 2 : 1)` 就催一次；硬上限仍是 `qzone.dailyLimit`（超了 `qzone.mjs` 直接 exit 6）。

## 4 状态文件全表

运行时状态**分两处**，别搞混：

- **桥接侧 `<仓库>/state/`** —— `src/bridge.js:250 const STATE_DIR = path.join(ROOT, 'state')`；`ROOT` 是 Stellar 的安装目录（`src/bridge.js:171`）。桥接自己写、自己读。
- **插件侧 `DSH_HOME/stellar/state/`** —— `plugins/stellar/lib/run-mode.js:29`、`plugins/stellar/lib/memory-db-timer.js:86`。DSH 进程里的插件半写，面板读。

| 文件 | 位置 | 内容 | 能删吗 |
| --- | --- | --- | --- |
| `social-v2.json` | 桥接 | 每个会话的运行时状态（未读、唤醒配置、令牌、最近消息） | 能（等于丢未读与会话状态） |
| `sessions.json` | 桥接 | 会话 key → DSH 会话 id 的映射 | 能（会重新建会话） |
| `run-mode.json` | 插件 | 三种运行模式（手动指定仅当天） | 能 |
| `todos.json` | 插件 | 待办（含 `targetKey`/`targetName`） | **别删**，删了提醒就没了 |
| `approvals.json` | 桥接 | 等她/等主人批的事 | 能 |
| `outbox.json` | 桥接 | 待发/已发的出站记录 | 能 |
| `token-usage.jsonl` | 桥接 | 每次模型调用的用量账本 | 能（账就归零） |
| `token-budget.json` / `token-alert.json` | `DSH_HOME/stellar/`（不在 state/ 里） | 每日额度与当日已用、告警水位 | 能 |
| `tool-calls.jsonl` | 桥接 | 工具调用流水（面板「运行」页读） | 能 |
| `audit.jsonl` | 插件 | 面板写操作审计 | 能 |
| `bridge.lock` | 桥接 | 桥接 PID 与启动时间 | 桥接没跑时可删 |
| `console-token` | 桥接 | 控制台令牌（未在配置里指定时） | 能（会重新生成） |
| `current-role.json` | 桥接 | 当前角色指针 | **别删**，删了她不知道自己是谁 |
| `state/town/album/`（`index.json` + 原图/缩略图） | 插件 | 小镇相册镜像（60 张 / 120 MB 双限，单张 >8 MB 只留缩略图） | 能（下次采集重建索引，照片本身在小镇侧） |
| `state/town/chat-bind.json` | 桥接（写进插件侧 `DSH_HOME/stellar/state/town/`） | QQ → 小镇的绑定记录 `{ok, sid, at, base, fishId, removed, error?}`；会话 id 变了才 `POST /fishbowl-town/save` 重绑（退避 10 分钟），**不存访问码** | 能（下一趟投递会重新绑） |
| `turn-context.json` / `turn-context/` | 桥接 | 本轮是谁在说话（15 分钟过期） | 能 |
| `state/voice-style.json` | 插件侧 `DSH_HOME/stellar/state/`（面板保存时建；桥接按 `mtimeMs:size` 读） | 她每轮看到的「说话方式」原则与词条（≤600 字硬上限；文件不存在按默认 3 条渲染） | 能（等于回到内置那句） |
| `state/voice-stats.json` | 同上 | 今天的说话方式计数（条数/破折号/三点列举/客服腔/撞上原句/用上改法），只记数量不存原文 | 能 |
| `state/voice-style.bak/` | 同上 | 每次保存前的旧版，只留最新 10 份 | 能 |
| `purpose-outreach.json` | 角色目录 `characters/<id>/`，写不进才回退桥接 `state/`（`src/bridge.js:2265-2267`） | 主动搭话的状态 | 能 |
| `plugin.log` | 插件（`DSH_HOME/stellar/`） | 插件半的日志 | 能 |
| `bridge.log` / `qq-activity.log` | 桥接 | 桥接与 QQ 活动日志 | 能 |
| `memory-review-request.json` / `memory-profile-request.json` | 插件 | 面板点的「立即复核 / 生成侧写」 | 能（40 分钟内有效） |
| `memory-card.json` / `memory-card-full.jsonl` | 角色目录 `characters/<角色>/memory/` | 旧记忆卡的主文件与归档 | `memory.engine='db'` 时冻结、不再增长（历史可达数百 MB）；改回 `card` 后继续 |
| `vector-memory.jsonl` / `vector-memory-index/` | 角色目录 `characters/<角色>/memory/` | 旧向量记忆的记录与索引 | 同上：`db` 时冻结，不再摄取/编码/建索引；改回 `card` 后继续 |

## 5 备份、保留与回滚

- **改配置前**：面板的保存会先写 `<文件名>.bak-<时间戳>`；命令行改就自己复制一份。
- **记忆库**：所有删除都先导出到 `characters/<角色>/memory/memory-trash/*.jsonl`；库本身用 `sqlite3 .backup` 或直接停桥接复制 `memory.db`（WAL 模式下要连 `-wal`/`-shm` 一起）。
- **面板口令**：`stellar-manager/panel-token.txt`；删掉会在下次启动时重建。
- **回滚代码**：`git log` → `git checkout <sha> -- <file>`；不要整目录覆盖（见 RELEASE.md）。

## 6 迁移与兼容

| 老位置 | 现在 | 怎么处理 |
| --- | --- | --- |
| 配置只在 `~/.dsh/stellar/config.json` | 仓库根 `config.json` 优先 | 仓库那份没有 `memory` 段时回退到旧位置；解析只有一份 `src/unified-memory-config.js`，桥接与插件共用，记忆开关不会再出现两套答案 |
| `memory-card*.jsonl` 等旧记忆档案 | 新库不读 | 留在原地不动；`engine=db` 时冻结（不再写入/增长），仅当 `memory.engine=card` 时旧引擎才读并继续写 |
| `stateXYZ` 之类的历史目录 | 已清理 | 看到就当杂物 |

## 7 清理约定（什么能删、什么绝不能删）

**能删**：`state/` 下除 `todos.json` 以外的运行时文件、日志、`*.bak-*`、`memory-trash/` 里确认不要的导出。

**绝不能删**：

- `config.json`（两份都不一样，删了就是重新配）；
- `bili.config.json` 与 `characters/<角色>/bili/credentials.json`（B站 登录态）；
- `characters/<角色>/memory/memory.db`（记忆全在这一个文件里）；
- `roles/<角色>.md` 或 `examples/` 里你自己改过的角色卡。

**看起来能删其实不能**：`stellar-manager/panel-token.txt` 删了手机端要重新配口令；
`release/install-manifest.json` 删了 `verify` 会全红（它是发布清单，不是缓存）。
