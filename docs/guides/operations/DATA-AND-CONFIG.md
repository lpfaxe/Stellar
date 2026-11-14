# 数据与配置（DATA-AND-CONFIG）

> 三份配置文件、状态文件全表、备份与清理约定。**不要**手改 `state/` 里的东西，除非这一篇写了可以。

## 0 一张图

```
<仓库>/config.json                  桥接读这份（ownerQQ / socialV2 / memory / consolePort / dsh）
~/.dsh/stellar/config.json          插件读这份（platforms / admin / bridge / 界面偏好）
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
| `socialV2.*` | 回复策略、唤醒条件、表情、收尾、图片额度 | 见各功能篇 |
| `memory.*` | 记忆引擎与四个子块 | 见 [../features/MEMORY.md](../features/MEMORY.md) |
| `dsh.*` | DSH 地址、模型、思考强度、认证头 | 端口会被 `dsh-port.js` 自动纠正 |
| `pricing` | 价目表覆盖项 | 留空用 `src/model-prices.js` 官方价 |
| `fishGuard` | 鱼群保护名单 | **默认空 = 不拦** |
| `greetings` | 早安问候 | 默认关 |

## 2 `~/.dsh/stellar/config.json`（插件）

入口：插件设置页保存时写；结构由 `plugins/stellar/lib/store.js` 的 `DEFAULT_UNIFIED` 定义（读时深合并）。

| 键 | 作用 |
| --- | --- |
| `platforms.start` / `platforms.enabled` | 开 DSH 时要不要连带起桥接 / B站 |
| `bridge.autoStart`（旧字段） | 仍被读取，用来推导 `platforms.start` |
| `admin` | 管理员（B站 ⇄ QQ 同一个人），空则回退 `config.json` 的 `ownerQQ` |
| 界面偏好 | 上次停在哪一页、紧凑模式等 |

**这份不复制桥接的配置**：桥接读自己那份，插件读自己那份。改错地方的表现是「改了没反应」。

## 3 `~/.dsh/stellar/bili.config.json`（B站）

入口：B站 页签保存；B站 CLI 的命令行参数也能临时覆盖。
**不要**手写 `STELLAR_BILI_CONFIG` 之外的路径，除非你知道 `DSH_HOME` 被改了。

| 段 | 作用 |
| --- | --- |
| `night` | 生物钟：今晚几点醒、看几个、抽几帧 |
| `qzone` | QQ空间：每日条数、好友爱看（看几条/赞几个/评几个）、关注谁 |
| `limits` | 每日额度：视频数、点赞数、评论数、分享数 |
| `fishGuard` | B站 侧鱼群保护（与 QQ 侧是两份配置，默认都空） |
| `notify` | 通知与免打扰 |

注意：**`qzone` 与 `limits` 会同时被桥接和面板读**。改完下一轮生效，不用重启。

## 4 状态文件全表

| 文件（相对 `DSH_HOME/stellar/state/`） | 内容 | 能删吗 |
| --- | --- | --- |
| `social-v2.json` | 每个会话的运行时状态（未读、唤醒配置、令牌、最近消息） | 能（等于丢未读与会话状态） |
| `sessions.json` | 会话 key → DSH 会话 id 的映射 | 能（会重新建会话） |
| `run-mode.json` | 三种运行模式（手动指定仅当天） | 能 |
| `todos.json` | 待办（含 `targetKey`/`targetName`） | **别删**，删了提醒就没了 |
| `approvals.json` | 等她/等主人批的事 | 能 |
| `outbox.json` | 待发/已发的出站记录 | 能 |
| `token-usage.jsonl` | 每次模型调用的用量账本 | 能（账就归零） |
| `token-budget.json` / `token-alert.json` | 每日额度与当日已用、告警水位 | 能 |
| `tool-calls.jsonl` | 工具调用流水（面板「运行」页读） | 能 |
| `audit.jsonl` | 面板写操作审计 | 能 |
| `bridge.lock` | 桥接 PID 与启动时间 | 桥接没跑时可删 |
| `console-token` | 控制台令牌（未在配置里指定时） | 能（会重新生成） |
| `current-role.json` | 当前角色指针 | **别删**，删了她不知道自己是谁 |
| `turn-context.json` / `turn-context/` | 本轮是谁在说话（15 分钟过期） | 能 |
| `purpose-outreach.json` | 主动搭话的状态 | 能 |
| `plugin.log` / `bridge.log` / `qq-activity.log` | 日志 | 能 |
| `memory-review-request.json` / `memory-profile-request.json` | 面板点的「立即复核/生成侧写」 | 能（40 分钟内有效） |
## 5 备份、保留与回滚

- **改配置前**：面板的保存会先写 `<文件名>.bak-<时间戳>`；命令行改就自己复制一份。
- **记忆库**：所有删除都先导出到 `characters/<角色>/memory/memory-trash/*.jsonl`；库本身用 `sqlite3 .backup` 或直接停桥接复制 `memory.db`（WAL 模式下要连 `-wal`/`-shm` 一起）。
- **面板口令**：`stellar-manager/panel-token.txt`；删掉会在下次启动时重建。
- **回滚代码**：`git log` → `git checkout <sha> -- <file>`；不要整目录覆盖（见 RELEASE.md）。

## 6 迁移与兼容

| 老位置 | 现在 | 怎么处理 |
| --- | --- | --- |
| 配置只在 `~/.dsh/stellar/config.json` | 桥接优先读 `<仓库>/config.json` | 仓库那份没有 `memory` 段时自动回退到旧位置 |
| `memory-card*.jsonl` 等旧记忆档案 | 新库不读 | 留在原地不动，仅当 `memory.engine=card` 时旧引擎才读 |
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
