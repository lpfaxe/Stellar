# 文档索引（docs/README.md）

> 文档分三层：根目录的 `README.md` / `README.en.md`（5 分钟概览）→ **本索引** → `guides/`（逐模块细节）。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
> 发布流程见 **[RELEASE.md](RELEASE.md)**；语音/桌宠的独立组件见 **[VOICE-PACKS.md](VOICE-PACKS.md)**。

---

## 一、先读这三篇

| 文档 | 一句话说明 |
| --- | --- |
| [../README.md](../README.md) | 项目是什么、装什么、怎么跑起来（中文） |
| [guides/architecture/ARCHITECTURE.md](guides/architecture/ARCHITECTURE.md) | **总纲**：进程/端口拓扑、代码分层、QQ 与 B站 两个世界、关键数据流、两套状态根、三份配置、安全模型 |
| [../AGENTS.md](../AGENTS.md) | 改代码前的工程纪律：动线、铁律、环境事实、交付定义 |

---

## 二、装与用

| 文档 | 一句话说明 |
| --- | --- |
| [guides/getting-started/INSTALL.md](guides/getting-started/INSTALL.md) | 手把手安装：SnowLuma 配置、白名单、启动、排错表 |
| [guides/getting-started/DSH_SETUP.md](guides/getting-started/DSH_SETUP.md) | DSH 侧安装：`qq-chat` / `qq-chat-v2` preset 与三个 MCP server 怎么挂上 |
| [guides/getting-started/AGENT-INSTALL-PROMPT.md](guides/getting-started/AGENT-INSTALL-PROMPT.md) | 让 AI 自己装的提示词模板 |
| [guides/getting-started/VERSIONS.md](guides/getting-started/VERSIONS.md) | 各组件版本、升级路径、兼容矩阵 |
| [guides/getting-started/SNOWLUMA_TROUBLESHOOT.md](guides/getting-started/SNOWLUMA_TROUBLESHOOT.md) | SnowLuma 连不上 / 收不到消息的排查 |
| [guides/operations/REMOTE-ACCESS-TAILSCALE.md](guides/operations/REMOTE-ACCESS-TAILSCALE.md) | 从外网访问控制台（Tailscale 隧道） |
| [guides/operations/PRIVACY.md](guides/operations/PRIVACY.md) | 哪些数据落盘、落在哪、怎么清 |
| [guides/operations/BILLING.md](guides/operations/BILLING.md) | 计价口径、额度上限、账单怎么看 |

## 三、模块与子系统（逐行读代码写的，带 `文件:行号`）

| 文档 | 一句话说明 |
| --- | --- |
| [guides/architecture/MODULE-BRIDGE.md](guides/architecture/MODULE-BRIDGE.md) | **桥接内核**（`src/bridge.js`）：启动序列、入站/出站全链路、会话与状态、控制台 API、安全闸门、定时器、失败模式 |
| [guides/architecture/MODULE-CORE-A.md](guides/architecture/MODULE-CORE-A.md) | **核心引擎 A**：记忆卡、角色人格、目的机制、对话收尾、每日额度、token 账本、价目表、身份闸 |
| [guides/architecture/MODULE-CORE-B.md](guides/architecture/MODULE-CORE-B.md) | **核心引擎 B**：B站 API/记忆/动态/卡片、鱼群、表情语义、黑话、md→纯文本、转发展开、SSRF、DSH 客户端、语音内核、ACL |
| [guides/architecture/MODULE-PLUGIN.md](guides/architecture/MODULE-PLUGIN.md) | **插件宿主**：装配顺序、配置模型（脱敏/原子写/备份）、设置页 API、B站 调度器、记忆与对齐、token 采集 |
| [guides/subsystems/SUBSYSTEM-BILI.md](guides/subsystems/SUBSYSTEM-BILI.md) | **B站 子系统**：账号与凭据、生物钟、内容生产/消费、CLI 命令与库、四本账额度、鱼群、配置全解 |
| [guides/subsystems/SUBSYSTEM-VOICE.md](guides/subsystems/SUBSYSTEM-VOICE.md) | **语音子系统**：三条链路、状态机、本地↔云端路由、合成契约、发送全链路、触发规则 |
| [guides/subsystems/SUBSYSTEM-PET.md](guides/subsystems/SUBSYSTEM-PET.md) | **桌宠子系统**：拓扑、发现与鉴权、pet-api 端点、对话链路、事件队列、目的载体、专注模式 |
| [guides/subsystems/AGENT-TOOLS-AND-PRESETS.md](guides/subsystems/AGENT-TOOLS-AND-PRESETS.md) | **工具面与 preset**：三个 MCP server、`qq_*` 工具全表与开关、权限与会话绑定、fail-closed 守卫、两代 preset |
| [guides/subsystems/UI-AND-CONSOLE.md](guides/subsystems/UI-AND-CONSOLE.md) | **两套界面**：插件设置页逐标签（控件↔配置键↔API）、浏览器控制台各页面 |

## 四、专题

| 文档 | 一句话说明 |
| --- | --- |
| [guides/features/MEMORY_CARD.md](guides/features/MEMORY_CARD.md) | **记忆卡**：衰减卡 vs 全量卡、重要度评分、清晰度/遗忘、容量告警、压缩、隐私 scope |
| [guides/features/VECTOR_MEMORY.md](guides/features/VECTOR_MEMORY.md) | **向量记忆**：与叙事记忆并列的独立系统、检索打分、注入预算、失败降级 |
| [guides/features/EMBEDDING_PACKS.md](guides/features/EMBEDDING_PACKS.md) | **Embedding 按需安装包**：pack.json 契约、安装/校验/卸载、与发布清单隔离 |
| [guides/features/CHARACTER_PERSONA.md](guides/features/CHARACTER_PERSONA.md) | **角色人格系统**：每角色目录包、切换序列与隔离、自动存档/回档、迁移 |
| [guides/features/CROSS_PLATFORM_IDENTITY.md](guides/features/CROSS_PLATFORM_IDENTITY.md) | **跨平台自我识别**：自我卡、来源判断、标签与规则双写、隐私打码 |
| [guides/features/PURPOSE_OUTREACH.md](guides/features/PURPOSE_OUTREACH.md) | **目的机制（主动找主人）**：载体 QQ/桌宠、排程与硬闸门、素材与提示词、预览/试一次 |
| [guides/features/CONVERSATION_CLOSURE.md](guides/features/CONVERSATION_CLOSURE.md) | **对话收尾判断**：六类信号 → continue/linger/close；与 mark_read/潜水的边界 |
| [guides/operations/TOKEN_USAGE_CONSOLE.md](guides/operations/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、峰谷计价、API、配置 |

## 五、配置与数据 / 边界与安全

| 文档 | 一句话说明 |
| --- | --- |
| [guides/operations/DATA-AND-CONFIG.md](guides/operations/DATA-AND-CONFIG.md) | **配置与数据**：三份配置逐段全解、状态文件全表（谁写谁读/能不能删）、角色包结构、备份与迁移 |
| [guides/operations/BOUNDARIES.md](guides/operations/BOUNDARIES.md) | **能力边界**：环境边界、能力矩阵、失败模式 → 恢复动作、安全承诺与不承诺 |
| [guides/operations/SECURITY_BASELINE.md](guides/operations/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现边界、残余风险、发布前回归清单 —— 动安全代码前必读 |
| [guides/operations/PERMISSIONS.md](guides/operations/PERMISSIONS.md) | **权限清单**：身份判定唯一来源、主人特权、关系与称呼不参与授权、变更检查单 |
| [../RULES.md](../RULES.md) | 使用规则与安全承诺（面向使用者） |

## 六、开发

| 文档 | 一句话说明 |
| --- | --- |
| [guides/development/DEV-TESTING.md](guides/development/DEV-TESTING.md) | 测试套件、离线回归、怎么加一条测试 |
| [guides/development/CONSOLE-UI-TESTING.md](guides/development/CONSOLE-UI-TESTING.md) | 控制台离线预览与浏览器回归 |
| [guides/development/ERROR-REPORTING.md](guides/development/ERROR-REPORTING.md) | **报错与建议规范**：`ok/code/error/hint/tried` 结构、弹窗 vs toast 判据、禁止清单 |
| [guides/architecture/12-LESSONS-ARCHITECTURE.md](guides/architecture/12-LESSONS-ARCHITECTURE.md) | 12 课总结 + 修 bug 手册：底层机制、链路与状态所有权、bug 候选、爆炸半径 |
| [guides/development/DSH_020_ADAPTATION.md](guides/development/DSH_020_ADAPTATION.md) | DSH 0.2.0 适配改动记录（现象/为什么必须改/证据/怎么验证）—— 升级 DSH 前先读 |
| [guides/development/MULTI-SESSION-WORKFLOW.md](guides/development/MULTI-SESSION-WORKFLOW.md) | 多会话协作（编辑会话 / 发布会话）的分工与交接 |
| [guides/development/SESSION-HANDOFF-PROMPT.md](guides/development/SESSION-HANDOFF-PROMPT.md) | 会话交接提示词模板 |
| [RELEASE.md](RELEASE.md) | **发布流程**：双分支纪律、门禁、bump、清单、推送、验证、回滚 |

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 装起来跑通 | [guides/getting-started/INSTALL.md](guides/getting-started/INSTALL.md) |
| 搞懂整体架构 / 全部配置项 | [guides/architecture/ARCHITECTURE.md](guides/architecture/ARCHITECTURE.md)、[guides/operations/DATA-AND-CONFIG.md](guides/operations/DATA-AND-CONFIG.md) |
| 看 AI 烧了多少钱 / 计价口径 | [guides/operations/TOKEN_USAGE_CONSOLE.md](guides/operations/TOKEN_USAGE_CONSOLE.md)、[guides/operations/BILLING.md](guides/operations/BILLING.md) |
| 搞懂角色记得什么 / 怎么遗忘 | [guides/features/MEMORY_CARD.md](guides/features/MEMORY_CARD.md) |
| 多角色切换 / 存档回档 | [guides/features/CHARACTER_PERSONA.md](guides/features/CHARACTER_PERSONA.md) |
| 动安全相关代码 / 发布前检查 | [guides/operations/SECURITY_BASELINE.md](guides/operations/SECURITY_BASELINE.md)、[RELEASE.md](RELEASE.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 发一个版本 | [RELEASE.md](RELEASE.md) |
