# 文档索引（docs/README.md）

> 这份索引只描述**当前代码**。看不到的东西就是没有，不要按印象去找；
> 现在每一篇都能对上仓库里的代码。目录结构见 [FOLDER_MAP.md](FOLDER_MAP.md)，发布流程见 [RELEASE.md](RELEASE.md)。

## 按你想做的事找

| 我想… | 看这篇 |
| --- | --- |
| 第一次装起来 | [getting-started/INSTALL.md](guides/getting-started/INSTALL.md) |
| 搞清楚 DSH 这一侧要配什么 | [getting-started/DSH_SETUP.md](guides/getting-started/DSH_SETUP.md) |
| 让 DSH 里的 agent 自己装 | [getting-started/AGENT-INSTALL-PROMPT.md](guides/getting-started/AGENT-INSTALL-PROMPT.md) |
| SnowLuma 连不上 / 掉线 | [getting-started/SNOWLUMA_TROUBLESHOOT.md](guides/getting-started/SNOWLUMA_TROUBLESHOOT.md) |
| 知道版本号怎么走、怎么升 | [getting-started/VERSIONS.md](guides/getting-started/VERSIONS.md) |
| 看懂它由哪几个进程组成 | [architecture/ARCHITECTURE.md](guides/architecture/ARCHITECTURE.md) |
| 搞清楚记忆是怎么存的 | [features/MEMORY.md](guides/features/MEMORY.md) |
| 她能读哪些文档（含扫描件 OCR） | [features/DOCUMENTS.md](guides/features/DOCUMENTS.md) |
| 让它有脾气、有说话风格 | [features/CHARACTER_PERSONA.md](guides/features/CHARACTER_PERSONA.md) |
| 为什么它会主动找人说话 | [features/PURPOSE_OUTREACH.md](guides/features/PURPOSE_OUTREACH.md) |
| 对话怎么算结束 | [features/CONVERSATION_CLOSURE.md](guides/features/CONVERSATION_CLOSURE.md) |
| QQ 号与 B站 号怎么算同一个人 | [features/CROSS_PLATFORM_IDENTITY.md](guides/features/CROSS_PLATFORM_IDENTITY.md) |
| B站 那套（刷视频/发动态/评论） | [subsystems/SUBSYSTEM-BILI.md](guides/subsystems/SUBSYSTEM-BILI.md) |
| 界面：插件设置页与浏览器面板 | [subsystems/UI-AND-CONSOLE.md](guides/subsystems/UI-AND-CONSOLE.md) |
| 78 个工具、以及它们怎么被放进 DSH | [subsystems/AGENT-TOOLS-AND-PRESETS.md](guides/subsystems/AGENT-TOOLS-AND-PRESETS.md) |
| 鱼缸小镇（可选，默认不启用） | [subsystems/SUBSYSTEM-TOWN.md](guides/subsystems/SUBSYSTEM-TOWN.md) |
| 配置项、状态文件都在哪 | [operations/DATA-AND-CONFIG.md](guides/operations/DATA-AND-CONFIG.md) |
| 它不该做什么（边界与硬闸） | [operations/BOUNDARIES.md](guides/operations/BOUNDARIES.md) |
| 谁能用、谁能改 | [operations/PERMISSIONS.md](guides/operations/PERMISSIONS.md) |
| 隐私：哪些数据出本机 | [operations/PRIVACY.md](guides/operations/PRIVACY.md) |
| 安全基线（端口、令牌、ACL） | [operations/SECURITY_BASELINE.md](guides/operations/SECURITY_BASELINE.md) |
| 花了多少钱、额度怎么算 | [operations/BILLING.md](guides/operations/BILLING.md) |
| 面板里那张花费卡怎么看 | [operations/TOKEN_USAGE_CONSOLE.md](guides/operations/TOKEN_USAGE_CONSOLE.md) |
| 在外面用手机连回面板 | [operations/REMOTE-ACCESS-TAILSCALE.md](guides/operations/REMOTE-ACCESS-TAILSCALE.md) |
| 把向量记忆的索引灌进去 | [features/EMBEDDING_PACKS.md](guides/features/EMBEDDING_PACKS.md) |
| 出问题怎么把日志给我 | [development/ERROR-REPORTING.md](guides/development/ERROR-REPORTING.md) |
| 想改代码 / 跑回归 | [RELEASE.md](RELEASE.md) |

## 三条先说清楚的事实

1. **记忆存在 `memory.db`（SQLite）。** 聊天进缓冲表 → 后台切成话题、抽出事实 → 唤醒只喂目录与事实。
   详见 [features/MEMORY.md](guides/features/MEMORY.md)。
2. **只发文字和图片。** 不合成语音，也不发图片以外的富媒体；设置页与面板里没有这类开关。
3. **形象图要自己放。** 仓库不带任何默认头像/立绘；把图片放 `assets/self-image.png`，
   或在 `config.json` 里配 `socialV2.selfImage`。没配时「发张自拍」会得到一条「还没有形象图片」的提示。

## 写文档的三条约定

- **只写现在**。不写「曾经/原来的设计」，历史进 `CHANGELOG.md`。
- **数字要能验证**。工具数、命令数、页签数都要能在代码里 grep 到出处。
- **链接必须活**。改文件名要同时改所有引用（`scripts/test-release-manifest.mjs` 会探几个固定路径）。