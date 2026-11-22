# 架构总览（Stellar 1.1.0）

> 只写现在这个版本实际在跑的东西。想知道「为什么这么设计」，看对应的功能篇；
> 想知道每个目录放什么，看 [../FOLDER_MAP.md](../../FOLDER_MAP.md)。

## 0 一句话

一个常驻的 **Node 进程（桥接）** 把 QQ 消息接进来、把 DSH 里的 agent 当成「会说话的大脑」、
再把回复发出去；**B站 与 QQ空间** 是它自己会主动做的事；**两个界面**用来观察和干预它。

## 1 进程与端口

```
SnowLuma（QQ 网关：OneBot HTTP 3000 / WS 3001）
        │ ws
        ▼
bridge  ──── node src/bridge.js ──────────  http://127.0.0.1:3100  ← 桥接自带控制台（consoleToken）
  │  │                                     
  │  └──► DSH（DeepSeek Harness，端口由它自己挑；config.dsh.baseUrl）
  │                                          │ 会话 prompt / 工具调用（MCP stdio）
  │                                          ▼
  │                                       她（一个 DSH 会话，带 84 个 MCP 工具）
  └──► 面板 stellar-manager ── 3300（可选，另起一个进程）
```

| 进程 | 起来的方式 | 挂了会怎样 |
| --- | --- | --- |
| **SnowLuma** | 用户自己启动（EULA 不允许随包分发） | 收不到也发不出 QQ 消息 |
| **bridge** | `start.bat` / 计划任务 / 面板「重启」 | 全停：不谈天、不刷 B站、面板读不到状态 |
| **DSH** | 用户自己开（桌面版） | 桥接还在，但她不会说话（消息堆在未读） |
| **stellar-manager** | `启动控制台.bat`（可选） | 只影响观察与手动操作，聊天不受影响 |

端口只在**回环**上：3100（桥接控制台）与 3300（面板）都不对外。
SnowLuma 的 3000/3001 也在本机。**唯一**对外的出口是面板可选开的 Cloudflare 隧道（见 REMOTE-ACCESS-TAILSCALE.md）。

## 2 代码分层

| 层 | 在哪 | 职责 | 不该做什么 |
| --- | --- | --- | --- |
| 消息链路 | `src/bridge.js`（约 1.9 万行，最大单体） | 收发、唤醒、上下文拼装、67 条控制台路由 | 不直接调模型；不写业务判断（那些在共享引擎里） |
| MCP 工具面 | `src/mcp-snowluma-safe.js` 等三个 server | 把能力以工具形式交给 DSH 里的她 | 不藏私活：每个工具都要有对应的 HTTP/本地实现 |
| 共享引擎 | `src/*.js` 里的纯逻辑 | 记忆库（`memory.db`）为主、额度、鱼群保护、收尾判断、身份、抓取、说话方式（`voice-style.js`，2026-11-22）；旧的两条记忆管线（衰减记忆卡 + 向量记忆）在 `memory.engine='db'` 时整体不启动（2026-11-22） | 不碰网络状态机；能被单测直接 import |
| 插件宿主 | `plugins/stellar/` | 定时作业（记忆切分/复核/侧写、生物钟、每日任务）、设置页 | 不参与消息收发 |
| 面板 | `stellar-manager/` | 观察与手动操作 | 不改消息链路状态（只写配置文件） |

### 2.1 记忆的旧管线（2026-11-22 起停跑）

- **配置源只有一份解释**：`memory.engine` 以**仓库根** `config.json` 为准；那份没有 `memory` 段才回退 `$DSH_HOME/stellar/config.json`。解析逻辑只有一份 `src/unified-memory-config.js`，桥接与插件共用，不再各读一份。
- **旧管线整体停跑**：`engine='db'` 时，插件的 `startMemoryCardTimer()` 与 `startVectorMemoryTimer()` 启动即返回（日志只留一行「不启动（数据保留）」）；`runMemoryCardMaintenance()` 早退并清空 `promptQq`/`promptBili`/`promptGroups` 产物；桥接侧 `cardRetired` 兜底，旧卡不进提示词。数据一律不删；只有把 `engine` 改回 `card` 并重启才恢复。
- **embedding 不再外发**：本地 18765 的 `embedding-shim.mjs` 已退役（它原本把记忆文本原样转给云端 embeddings 接口），keepalive 里的探活拉起块已删除。默认路径上不再有记忆文本出本机。

## 3 一条消息的完整旅程

1. SnowLuma 推一条 OneBot 事件到 bridge；
2. bridge 判黑名单/白名单、判是不是该理（`wake-policy.js` / `wake-filter.js`）、写未读；
3. 决定唤醒时，拼一份提示词（`buildWakePromptV2`）：人格 → 令牌 → 记忆（事实/目录/侧写）→ 平台归属 → B站记忆 → 状态 → 收尾建议 → 工具说明；
4. 把提示词投给 DSH 的一个会话（`dsh-client.js`），她开始调工具；
5. 她调 `qq_send_message` → MCP → bridge 的 `/api/send/*` → SnowLuma → QQ；
6. 收发两侧都异步写进 `memory.db` 的缓冲表（不阻塞链路）；
7. 面板通过 bridge 的只读接口观察这一切。

## 4 唤醒提示词里都有什么（顺序即优先级）

| 段 | 来源 | 为什么在这 |
| --- | --- | --- |
| 人格 | `personaWakeBlockV2` → 角色卡 | 不给就不知道自己是谁 |
| 【会话令牌】 | `state.agentToken` | 她调 `qq_*`/`stellar_*` 时得带上，否则一律拒绝 |
| 身份/归属 | `selfIdentityTextV2` + `buildProvenanceBlock` | 别把群里转发的聊天说成「我在 B站 说的」 |
| 记忆·事实 | `memoryFactBlockV2` | 生日、忌口这类被问得最多，且不依赖切分是否跑完 |
| 记忆·目录 | `memoryCatalogBlockV2` | 让她知道「聊过哪些事」，细节自己去查 |
| 侧写 | `memoryProfileLineV2` | 每人一句，避免把 A 的事安在 B 头上 |
| B站 简报 | `biliMemory.briefBlock()` | 群友问「B站那个号」时她不能把自己当别人 |
| 此刻状态 / 唤醒 / 收尾 | 各种 `*LineV2` | 让「该不该回、回几条、能不能睡」有依据 |
| 说话方式（鱼八股） | `voiceStylePrompt()` → `antiAiLine`（`src/bridge.js:16125`） | 原来的「【反AI味】」那句换成主人能改的一份（`state/voice-style.json`，≤600 字，下一轮生效） |
| 参考风格 | `memoryStyleBlockV2` | **已停用**（2026-11-22）：`memory.styleRef.enabled` 默认 `false`，只有显式写 `true` 才注入 2 片、≤900 字符 |

每一段都可以在 `config.json` 里关掉；关掉后那句会提示「本轮不注入」的日志。

## 5 数据放哪（三段）

| 位置 | 装什么 | 能不能删 |
| --- | --- | --- |
| 仓库目录（`<stellar>/`） | 代码、`config.json`、默认资源 | 代码不能删；`state/` 可删（会重建） |
| `~/.dsh/stellar/` | 统一配置、`state/`（未读、额度、审计、日志）、`characters/<角色>/` | 删之前想清楚：记忆库跟着角色走 |
| `~/.dsh/` 其他 | DSH 的 profile、MCP 注册、会话 | 不归本项目管 |

三份配置文件的边界见 [../operations/DATA-AND-CONFIG.md](../operations/DATA-AND-CONFIG.md)。

## 6 三种运行模式

| 模式 | 自主活动 | 醒来频率 | 谁决定 |
| --- | --- | --- | --- |
| `normal` 正常 | 每日任务、生物钟、B站、空间全跑 | 按生物钟 | 默认 |
| `idle` 摸鱼 | 只写日志 + 更主动找人聊天；B站 60 个/天、好友爱看 20 条 | 更频繁 | 周六周日默认；面板可切 |
| `minimal` 最低限度 | 停止一切自主活动，只有收到消息才醒，清醒 2 分钟 | 只有消息 | 面板可切 |

优先级：**手动指定（仅当天有效）> 周末默认 > normal**。实现在 `plugins/stellar/lib/run-mode.js`，
调度器、桥接、面板三处都读它，不各写一份。

## 7 重启矩阵

| 改了什么 | 要重启什么 |
| --- | --- |
| `src/*.js`、`config.json` | **桥接**（`restart.bat` 或面板「重启」） |
| `plugins/stellar/**` | **DSH**（插件由它加载） |
| `dsh/agent-presets/**` | 先跑 `node scripts/build-agent-preset-patches.mjs`，再重启 DSH |
| `stellar-manager/**` | 只管面板自己的进程 |
| `docs/**`、`*.md` | 不用重启（但清单要重生成，见 [../RELEASE.md](../../RELEASE.md)） |

## 8 术语

| 词 | 指什么 |
| --- | --- |
| 她 / agent | DSH 里的那个会话。人格、记忆、工具都在它身上 |
| 桥接 / bridge | 常驻 Node 进程 `src/bridge.js` |
| 会话令牌 | 每个会话一枚的随机串，她调工具时带；见 SECURITY_BASELINE.md |
| 内部调度令牌 | 插件定时任务用的令牌（`key=owner:internal`），TTL 10 分钟 |
| 唤醒 | 桥接主动投一份提示词给 DSH，让她「醒来」处理消息或做事 |
| 生物钟 | 插件按时段随机安排「今晚看几个视频、几点醒」 |
| 见闻区 | `zone_note`，B站/好友爱看两个不按话题分类的记忆区 |

