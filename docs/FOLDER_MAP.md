# 仓库目录地图（FOLDER_MAP）

> 一句话说明每个顶层目录干什么、`scripts/` 里的命名约定是什么、哪些脚本像是过期的一次性产物。
> 本文**只描述现状**，不构成改动指令。文档索引见 [README.md](README.md)。
>
> 最后核对：2026-11-14（新增首次启动引导 `scripts/bootstrap*.mjs` 与配置编辑器 `config-ui*.mjs` + `public/config-ui.html`，`scripts/` 计数随之更新）。
> 新增目录/脚本时请顺手补一行。

---

## 一、顶层布局

```
<工作区根>/
├── stellar/                ← 本仓库（QQ ↔ DSH 桥接 + DSH 插件 + B站 + 桌宠接口）
├── pet/                     ← 桌宠工程（独立 Electron 工程，**不在本仓库**；通过
│                               ~/.dsh/stellar/pet/host.json 发现插件接口）
└── 重启DSH-加载语音工具.cmd  ← 工作区根的运维启动器（重启 DSH 让 MCP 工具重新挂载）
```

`stellar/` 内部：

| 目录 | 作用 | 能不能删/动 |
| --- | --- | --- |
| `src/` | **桥接内核与共享引擎**：主程序 `bridge.js`、DSH 客户端、三个 MCP server、黑话/表情/语音共享库、鱼群保护（`fish-guard.js`）、记忆卡引擎（`memory-card.js`）、目的机制纯逻辑（`purpose-engine.js`）、对话收尾判断（`conversation-closure.js`）、**每日 token 额度纯逻辑（`token-budget.js`）+ 账本（`token-ledger.js`）**、**状态目录 ACL 收紧（`state-acl.mjs`，与 `scripts/harden-state-acl.mjs` 同一实现）**、**安全抓取（`safe-fetch.js`）**、**上线补历史（`history-catchup.js`）**、**价目表（`model-prices.js`）**、**发送语音内核（`voice-core.js` / `voice-packs.js` / `voice-tts.js`，三者职责不同：解析与探测 / 语音包安装 / 本地 TTS 客户端）** | 不能动。`bridge.js` 是主程序（**约 15,000 行**，仍是全仓库最大单体，控制台 126 条路由写在同一条 if 链里）；`voice-core.js` 与 `snowluma-conn.js` 是**独立工具也在用的单一实现**；`memory-card.js` 同时被桥接/插件/单测引用，改评分权重必须跑 `npm run test:memory-card`；`purpose-engine.js` / `token-budget.js` 是纯逻辑，改它们要跑 `npm run test:audit`。**目录里只应有 `.js`/`.mjs`**：曾经的 `bridge.js.bak-*` 会污染全局搜索并看起来像 module，2026-09-20 已移出（见下） |
| `scripts/` | 调试 / 测试 / 一次性运维脚本（见第二节命名约定） | 测试脚本不能删；`cleanup-*` / `fix-*` / `patch-*` / `diag-*` 多为历史遗留 |
| `dsh/` | 要装进 DSH 的东西：`agent-presets/qq-chat`、`agent-presets/qq-chat-v2`（preset 的**权威源**，含工具白名单 `qq-tool-restrict.mjs` 的 re-export 壳）。DSH 0.1.7 起 preset 以 bundle patch 形式安装，patch 由 `scripts/build-agent-preset-patches.mjs` 从这里的源生成到 `plugins/stellar/presets/` | 改 preset 会影响所有人设行为；改完必须重新生成 patch |
| `plugins/` | DSH 插件：**`stellar`（合体插件：QQ 设置 + B站养鱼 + 双向记忆 + 身份对齐 + 鱼群保护 + 目的载体（QQ / 桌宠） + 桌宠对话/语音 + token 额度 + 扩展/平台接口；含 `qq-mode` 命名空间与设置窗口）**；两个 QQ preset 行与 `qq-tool-restrict` 权威实现也在同一个 bundle 的 `presets/` 里。原 `qq-mode-console` 已并入 Stellar，目录已从本仓库移除。桌宠相关：`lib/pet.js`（安装/启动）、`lib/pet-chat.js`（对话/语音/事件）、`lib/pet-purpose.js`（目的载体）、`lib/pet-api.js`（本地令牌接口），说明见 `plugins/stellar/docs/PET.md`。另外：`lib/token-budget.js`（用量采集器，纯逻辑在 `src/token-budget.js`）、`lib/http-guard.js`（设置页 API 与桌宠 API **共用**的回环/同源/令牌判据） | 改了要重装/重启 DSH。⚠️ 插件通过 `../../../src/*.js` **相对路径直接引用同仓库核心模块**（12 个），其中 `src/memory-card.js` 带 `?rev=` 缓存破坏后缀——热重载前要 bump，规则见 历史踩坑记录 |
| `public/` | 浏览器静态资源：`console.html`（桥接自带控制台，127.0.0.1:3100） | 目录里只应有这一个文件；历史备份 `console.html.bak` 已移出仓库 |
| `roles/` | 人格卡的**旧布局**（`roles/*.md`；角色人格系统启动时会自动迁移到 `~/.dsh/stellar/characters/<id>/persona.md`）：设置页「角色」页仍可查看/编辑当前人格卡 | 用户内容，别乱动 |
| `assets/` | 仓库用图片等资源（`deepseek娘.png`；`project-intro.mp4` 已改为 Release 附件、不入库） | 别加体积大的二进制 |
| `state/` | **只放运行时数据**（会话映射、模式、角色、黑话库、日志、锁、令牌）。`.gitignore` 排除。**这里不该出现 `.mjs` / 截图 / 一次性审计日志**——2026-10-26 审计一次清出 50 个（21 个一次性 `.mjs`、5 张 probe 截图、24 个日志），已隔离到 `_backups/state-residue-*/` | **用户数据，绝不删除/移动**（清理走 `_backups/`，带 README 与回滚说明） |
| `docs/` | 全部文档，按用途分子目录（见第三节） | 见第三节 |
| `node_modules/` `.npm-cache/` | 依赖与 npm 缓存 | 忽略 |
| `config.json` | 运行配置（真实配置**不入库**）；模板是 `config.example.json` | 值属于用户，别改 |

---

## 二、`scripts/` 命名约定

脚本共 244 个文件（238 个 `.mjs` + 3 个 JSON 基线 + 3 个 `.ps1`，另有 `fixtures/` 目录）；
其中 `test-*.mjs` **186 个**，被 `scripts/test-audit.mjs` 的 `tests[]` 收录的是**默认门禁**
（159 个）。按前缀区分用途：

| 前缀 / 形态 | 含义 | 归宿 |
| --- | --- | --- |
| `test-*.mjs` | **自动化测试**。其中被 `scripts/test-audit.mjs` 列进 `tests[]` 的那些会跑在 `npm run test:audit` 里（离线、不发真 QQ 消息、不用生产凭据） | 保留，改动需同步 test-audit 清单 |
| `test-agent-preset-patches.mjs` | preset **防漂移**契约：`plugins/stellar/presets/*.patch.yml` 必须与 `dsh/agent-presets/` 逐字一致、守卫行只用裸说明符（`npm run test:preset-patches`） | 保留（**2026-10-26 起进 `test:audit`**；以前它既不在门禁也没 npm script，导致 patch 静默落后于源，见 历史踩坑记录） |
| `test-core-rev-sync.mjs` | 插件 → `src/*.js` 的引用一致性：`?rev=` 三处必须相同、不许裸引用；并把「改了热重载也不生效」的模块清单打出来 | 保留（`npm run test:core-rev-sync`） |
| `test-privacy-scan.mjs` + `privacy-rules-lib.mjs` | 隐私闸的**判据本身**：编译出的正则必须带 `g`（否则每条规则每文件只查第一个命中），以及噪音过滤的边界 | 保留（`npm run test:privacy-scan` / `privacy-scan:strict`） |
| `test-voice-packs-default.mjs` | 语音包默认安装源必须是「仓库上级 / `voice/packages/<id>`」，不许硬编码盘符；8765/8767 与启停脚本名不能漂移 | 保留 |
| `test-dsh-*.mjs` | **需要活的 DSH**（不在 `test:audit` 里）：`test-dsh-auth.mjs`（鉴权链路）、`test-dsh-inbox-projection.mjs`（会话队列投影解析，离线）、`test-dsh-session-retire.mjs`（退役会话的端到端回归）、`test-dsh-v2-wait.mjs`（preset 工具面） | 保留（改 DSH 契约时必须跑） |
| `test-audit-*.mjs` | test-audit 的子模块（`test-audit-bridge` / `-protocol` / `-security` / `-setup` 及其 `-helpers`/`-guards`），被上一个直接运行 | 保留 |
| `test-console-ui.mjs` + `console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/` | 控制台**离线浏览器回归**与基线（`npm run test:console-ui` / `npm run preview:console`），说明见 [guides/development/CONSOLE-UI-TESTING.md](guides/development/CONSOLE-UI-TESTING.md) | 保留（基线只在后端契约真变时才重录） |
| `send-*.mjs` | 面向 SnowLuma/QQ 的**真发送**小工具（`send-voice.mjs` 走桥接；`send-test-group.mjs` 发测试群） | 保留，但注意会真的发消息 |
| `setup-*.mjs` | **安装/初始化**：把 preset、MCP 挂载写进目标设备的 DSH（`setup-dsh.mjs`，幂等） | 保留 |
| `verify-*.mjs` | **一致性校验**：`verify-dsh-020-adaptation.mjs`（DSH 适配；`npm run verify:adaptation`）、`verify-persona-config.mjs`（人格配置） | 保留 |
| `probe-*.mjs` | **探针**：用来问 DSH/SnowLuma「实际支持什么」（RPC 形状、工具清单、事件流、工作区、模型、协议帧、settings 命名空间）。鉴权统一走 `probe-auth.mjs` | 保留，按需重跑 |
| `probe-020-protocol.mjs` / `probe-020-settings.mjs` | 0.2.0 版探针：前者采样 `session/control` baseline、`session/projections`、`session/follow`、`$events`、`session/cancel` 的**原始帧结构**；后者列 settings 命名空间并**幂等写回**验证 `qq-mode` 可写。控制台「改模式不生效」时的第一手诊断 | 保留（`npm run probe:protocol` / `probe:settings`） |
| `scan-dsh-tool-names.mjs` + `dsh-tool-names.mjs` | **工具名对账**：从已安装的 DSH 包里抽真实工具名，与 QQ 守卫的 restrict 名单双向求差（防拼错假名静默失效 / 防新版本新增能力漏隐藏）。抽取实现只有 `dsh-tool-names.mjs` 一份，`test-preset-local-tools.mjs` 与 `scan-dsh-tool-names.mjs` 共用 | 保留（每次升级 DSH 后跑一次） |
| `probe-snowluma-heartbeat.mjs` | 只读探针：连 SnowLuma 的 OneBot WS，等一个 `meta_event/heartbeat`，打印载荷里的 `status.online` / **`status.good`**。桥接的上游健康主信号就是这个字段——它存不存在、拼写对不对只能拿**真实运行时**验证（SDK 不校验 data 载荷，取错字段不会报错）。不发消息、不建会话 | 保留（`npm run probe:heartbeat`） |
| `audit-bridge-harness.mjs` | 虚拟网关 + 沙箱化的桥接行为审计脚手架（被 `test-audit-bridge.mjs` 使用） | 保留 |
| `harden-state-acl.mjs` | 收紧 `state/` 目录权限（Windows 上 `mode 0o600` 是空操作，必须动 ACL）。直接试 → 失败提权重试 → 仍失败则打印可复制命令；**任何路径都以 0 退出，绝不阻断启动**。被 `start.bat` 调用 | 保留（`start.bat` 依赖） |
| `config-ui.mjs` + `config-ui-core.mjs` | **配置编辑器**（`配置.bat` / `npm run config-ui` 的入口）。`config-ui-core.mjs` 是零依赖纯逻辑（路径检查、深合并、校验、备份命名、原子写），可单独测；`config-ui.mjs` 只起 HTTP 服务（绑 `127.0.0.1`、一次性令牌、Origin 校验）并调 PowerShell 弹系统文件/目录选择框。页面在 `public/config-ui.html` | 保留（根目录 `配置.bat` 依赖）。改字段表必须同步 `scripts/test-config-ui.mjs`；**不许做自动检索**（路径只能由用户手选）、**不许整份覆盖**（只写表单覆盖的键） |
| `bootstrap.mjs` + `bootstrap-plan.mjs` | **首次启动引导**（`首次启动.bat` / `npm run bootstrap` 的入口）。`bootstrap-plan.mjs` 是零依赖纯函数（版本比较、参数解析、`buildPlan`、`summarize`），可在 `npm install` 之前运行；`bootstrap.mjs` 只做探测与副作用（装依赖、复制 config、建 state、收紧 ACL、装进 DSH、探测 SnowLuma），跑完复用 `plugins/stellar/lib/doctor.js` 打同一套体检表 | 保留（根目录 `首次启动.bat` 依赖）。改判定必须同步 `scripts/test-bootstrap.mjs`；**绝不覆盖已有 `config.json`** |
| `diagnose-acl.mjs` | 只读盘点：列出仓库里所有被**切断 ACL 继承**的路径，分「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类，并对后者打印恢复继承的命令。背景见 [guides/operations/SECURITY_BASELINE.md](guides/operations/SECURITY_BASELINE.md) §2.6：DSH 沙箱的写权限只靠继承下发能力 SID，切断继承 ⇒ 沙箱里写不进去。**必须在无沙箱终端跑**（沙箱禁止以管道 stdio 拉起 icacls） | 保留（`npm run diagnose:acl`） |
| `dsh-modules.mjs` | 小工具：按路径加载 DSH 安装内的模块 | 保留 |
| `check-onebot-status.mjs` | 手工排查：查 OneBot 连通性 | 保留（运维常用） |
| `patch-*.mjs` | **补丁**（含 `postinstall` 的 `patch-snowluma-sdk.mjs`：修 `@snowluma/sdk` 的 ESM 打包 bug） | `patch-snowluma-sdk.mjs` **必须保留**（postinstall 依赖）；其余进 `scripts/` 前先确认没有 npm script 引用 |
| `cleanup-*.mjs` / `fix-*.mjs` / `diag-*.mjs` / `debug-*.mjs` | **一次性**脚本：清理某次运行留下的脏数据、针对具体场景的诊断与调试 | 除仍被 npm script 或别的脚本调用的，其余用完即删（现状：已清理干净，见下方「千万别清掉」） |

> ⚠️ **「写了测试」不等于「测试会跑」**：只有进 `tests[]`（`scripts/test-audit.mjs` 里手工维护的数组）
> 或挂在 `package.json` 的 npm script 上的脚本才有门禁。2026-11-14 实测：`scripts/` 下 186 个 `test-*.mjs`，
> 159 个在 `tests[]` 里，其余 27 个中还有 14 个连 npm script 都没挂（多为需要真实网关/账号的活体测试）。
> 新增测试请顺手登记，否则它抓到的漂移会真的漏过去。

---

## 三、`docs/` 结构

```
docs/
├── README.md      # 文档索引（每篇一句话 + 是否仍然有效）  ← 先看这个
├── FOLDER_MAP.md  # 本文件
├── RELEASE.md     # 发布流程
├── VOICE-PACKS.md # 语音与桌宠的独立组件
└── guides/        # 按主题分六组
    ├── getting-started/  # 装上并跑起来：INSTALL / DSH_SETUP / AGENT-INSTALL-PROMPT /
    │                     #   VERSIONS / SNOWLUMA_TROUBLESHOOT
    ├── architecture/     # 总纲与逐段拆解：ARCHITECTURE / 12-LESSONS-ARCHITECTURE /
    │                     #   MODULE-BRIDGE / MODULE-CORE-A / MODULE-CORE-B / MODULE-PLUGIN
    ├── subsystems/       # 子系统与界面：SUBSYSTEM-BILI / SUBSYSTEM-VOICE / SUBSYSTEM-PET /
    │                     #   UI-AND-CONSOLE / AGENT-TOOLS-AND-PRESETS
    ├── features/         # 功能机制：MEMORY_CARD / VECTOR_MEMORY / EMBEDDING_PACKS /
    │                     #   CHARACTER_PERSONA / CROSS_PLATFORM_IDENTITY /
    │                     #   PURPOSE_OUTREACH / CONVERSATION_CLOSURE
    ├── operations/       # 配置、边界与安全：DATA-AND-CONFIG / BOUNDARIES / SECURITY_BASELINE /
    │                     #   PERMISSIONS / PRIVACY / BILLING / TOKEN_USAGE_CONSOLE /
    │                     #   REMOTE-ACCESS-TAILSCALE
    └── development/      # 开发与发布：DEV-TESTING / CONSOLE-UI-TESTING / ERROR-REPORTING /
                          #   DSH_020_ADAPTATION / MULTI-SESSION-WORKFLOW /
                          #   SESSION-HANDOFF-PROMPT
```

> `docs/` 下只有 `README.md`、`FOLDER_MAP.md`、`RELEASE.md`、`VOICE-PACKS.md` 和 `guides/`（六个子目录）。
> **仓库根只留面向使用者的少数几篇**：`README.md` / `README.en.md` / `RULES.md` / `AGENTS.md` / `CHANGELOG.md` / `LICENSE`，
> 加上给使用者双击的启动器（`首次启动.bat` / `配置.bat` / `start.bat` / `restart.bat` / `start-with-dsh-port.bat` / `停止QQ机器人.bat`）
> 与 npm 配置（`package.json` / `package-lock.json` / `.npmrc` / `.gitignore` / `config.example.json`）。
> 其余文档按主题进 `docs/guides/` 的对应子目录，并在 [README.md](README.md) 索引里登记一行（含「仍然有效 / 被谁取代」）。

---

## 四、已被清理的一次性脚本

> 早期仓库里混着 `cleanup-*` / `fix-*` / `diag-*` / `debug-*` / `patch-qq-chat-v2-*` /
> `patch-web-mcp-timeout` / `probe-015` / `send-voice` 等绑定单次运行的一次性脚本；
> 它们已全部从仓库移除（既不在 `package.json`，也不在 `test-audit.mjs` 清单里）。
> 现在 `scripts/` 只保留三类：**自动化测试**（`test-*.mjs`）、**按需重跑的探针与校验**
> （`probe-*.mjs`、`verify-*.mjs`）、**日常运维与安装**（setup / patch-snowluma-sdk /
> harden-state-acl / version / privacy-scan / release-manifest 等）。

**千万别当「过期脚本」清掉**：

- `scripts/patch-snowluma-sdk.mjs`（`postinstall` 依赖，删了 `npm install` 就坏）
- `scripts/test-audit.mjs` 清单里的每一个（完整清单见该文件 `tests[]` 数组）
- `scripts/console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/`（控制台回归基线）
- `scripts/audit-bridge-harness.mjs`、`scripts/dsh-modules.mjs`（被测试/工具引用）
