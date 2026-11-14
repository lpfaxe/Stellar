# 目录地图（FOLDER_MAP）

> 每个顶层目录干什么、`scripts/` 的命名约定、哪些是运行时产物。文档索引见 [README.md](README.md)。

## 一、顶层

```
<仓库根>/
├── src/              桥接内核 + MCP server + 共享引擎（Node，无构建）
├── plugins/stellar/  DSH 插件：定时作业、设置页、B站 CLI
├── stellar-manager/  浏览器面板（可选，独立进程）
├── public/           两个 HTML：config-ui.html（配置编辑器）、console.html（桥接自带控制台）
├── dsh/              agent preset 源（安装时由 setup-dsh 写进 DSH profile）
├── scripts/          安装、体检、回归、运维脚本
├── docs/             文档（本目录）
├── roles/            角色卡模板（示例角色 + 说明）
├── examples/         角色目录样例（空壳，教会它长什么样）
├── release/          install-manifest.json（逐文件 sha256）
├── state/            运行时状态（.gitignore 忽略，首次启动重建）
└── *.bat             入口：首次启动 / 配置 / 启动控制台 / restart / 停止
```

## 二、`src/`：每个文件做什么

| 组 | 文件 | 职责 |
| --- | --- | --- |
| 入口 | `bridge.js` | 常驻主程序：收发消息、拼唤醒提示、67 条控制台路由 |
| MCP | `mcp-snowluma-safe.js` / `mcp-host-server.js` / `mcp-web-search-safe.js` | 三个 stdio server，共 67 个工具 |
| DSH 对接 | `dsh-client.js` / `dsh-port.js` / `dsh-health.js` / `dsh-model-follow.js` | 找端口、投提示、探活、跟随默认模型 |
| 记忆 | `memory-db.js` / `memory-db-schema.sql` / `memory-cache.js` / `memory-read.js` / `memory-worker.js` / `memory-facts.js` | 新记忆库（见 features/MEMORY.md） |
| 记忆（旧引擎） | `memory-card.js` / `memory-store.js` / `memory-tiers.js` / `memory-blend.js` / `memory-compact.js` / `vector-memory.js` | 只在 `memory.engine=card` 时走 |
| 人格 | `character-persona.js` / `persona-layers.js` / `persona-identity.js` / `role-card.js` / `style-refs.js` | 角色卡、分层人格、参考风格 |
| 判断逻辑 | `wake-policy.js` / `wake-filter.js` / `wake-batch.js` / `conversation-closure.js` / `reply-plan.js` / `command-spam.js` | 该不该理、回几条、能不能收尾（纯函数，好测） |
| B站 | `bili-api.js` / `bili-memory.js` / `bili-dynamics.js` / `bili-card.js` / `bili-share-scheduler.js` | 网络、记忆简报、卡片、分享排期 |
| 额度 | `token-budget.js` / `token-ledger.js` / `token-guard.js` / `model-prices.js` / `billing-report.js` / `cost-estimate.js` | 每日额度、账本、价目、报表 |
| 安全 | `identity-guard.js` / `access-audit.js` / `owner-audit.js` / `file-read-guard.js` / `safe-fetch.js` / `safe-text.js` / `state-acl.mjs` | 身份、审计、文件与 URL 白名单、ACL |
| 其他 | `todos.js` / `approvals.js` / `sticker-*.js` / `slang-learner.js` / `outbox.js` / `self-test.js` | 待办、审批、表情、黑话、发件箱、自检 |

## 三、`scripts/`：命名约定

| 前缀 | 意思 | 举例 |
| --- | --- | --- |
| `test-*.mjs` | 回归（**186 个**，`test:audit` 跑其中 159 个） | `test-memory-db.mjs` |
| `probe-*.mjs` | 手工探针（要真环境，不进回归） | `probe-events.mjs` |
| `verify-*.mjs` | 断言某件事仍然成立 | `verify-dsh-020-adaptation.mjs` |
| `bootstrap*` | 首次启动引导（幂等，绝不覆盖已有配置） | `bootstrap.mjs` |
| `setup-dsh.mjs` / `config-ui.mjs` | 把它装进 DSH / 打开配置编辑器 | — |
| `release-manifest.mjs` / `privacy-scan.mjs` | 发布前必跑 | — |

`test:audit` 的清单是**手写数组**（`scripts/test-audit.mjs` 开头），不是目录扫描；
新增测试要自己加一行，否则不会被跑。

## 四、运行时产物（都不进 git）

| 路径 | 是什么 |
| --- | --- |
| `state/` | 控制台令牌、桥接锁、临时请求 |
| `~/.dsh/stellar/state/` | 未读、额度账本、审计、日志、待办、运行模式 |
| `~/.dsh/stellar/characters/<角色>/` | 角色卡、B站凭据、`memory/memory.db` |
| `stellar-manager/panel-token.txt` | 面板口令（自动生成） |
| `stellar-manager/audit.jsonl` | 面板写操作审计 |

## 五、`plugins/stellar/` 内部

| 子目录 | 作用 |
| --- | --- |
| `lib/` | 定时器（生物钟、每日任务、记忆作业）、设置页 UI、路径解析 |
| `tools/bili.mjs` | B站 CLI 入口（**58 条子命令**，`tools/commands/` + `tools/verify/`） |
| `tools/docs/` + `tools/rules/` | 给 agent 看的命令说明与行为规矩（运行时会被注入） |
| `persona/` | 分层人格的默认片段 |
| `presets/` | 由 `dsh/agent-presets/` 生成的 patch（**改源文件后要重跑 build**） |
| `extensions/` | 扩展包（sts2 等） |
| `locale/` | 界面文案 |

## 六、两张「谁生成谁」的表

```
dsh/agent-presets/qq-chat-v2/agent.cordis.yml
        │ node scripts/build-agent-preset-patches.mjs
        ▼
plugins/stellar/presets/qq-chat-v2.patch.yml   ← 改完源文件必须重跑，否则 test:audit 会报不一致

所有被跟踪的文件 ──► release/install-manifest.json（sha256 逐条）
                      node scripts/release-manifest.mjs
```
