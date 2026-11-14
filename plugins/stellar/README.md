# stellar 插件（DSH 侧的宿主）

> 这个目录是 **DSH 插件**，不是独立程序。桥接（`src/bridge.js`）和 B站 工具链（`tools/`）都在仓库根目录，插件负责的是：把两者装进 DSH、提供设置窗口、跑生物钟、维护记忆、管额度。

## 它做什么

| 职责 | 在哪 |
| --- | --- |
| 设置窗口（10 个页签） | `lib/client.js` |
| 三份配置的读写、备份、脱敏 | `lib/store.js` |
| 桥接的启停与探活 | `lib/bridge.js` |
| B站 生物钟（什么时候醒、看什么、发什么） | `lib/scheduler.js` |
| 记住她看过什么、发过什么 | `lib/memory.js` + 仓库 `src/memory-*.js` |
| 额度与 token 账本 | `lib/token-budget-service.js` |
| 扩展与平台接入 | `lib/extensions.js` / `lib/platforms.js` |
| 工具守则（她能用哪些工具） | 仓库 `qq-tool-restrict.mjs` |

## 装法

仓库根目录双击 `首次启动.bat`，它会跑 `scripts/bootstrap.mjs`：装依赖、建 `state/`、收紧目录权限、把本插件注册进 DSH profile、对齐 DSH 端口。**不要**手动复制目录——那样注册关系建不起来。

装完重启 DSH，设置窗口在 **设置 → Stellar**。

## 设置窗口的 10 个页签

| 页签 | 关于什么 |
| --- | --- |
| 概览 | QQ / B站 / 生物钟状态，一键启动，SnowLuma 安装检测 |
| 角色 | 当前角色、人格卡编辑器、角色包存档 |
| 目的 | 她为什么要主动找人说那句话（载体固定 QQ） |
| QQ | 管理员、白名单黑名单、启动开关、早安问候、高级参数 |
| B站 | 账号与扫码、生物钟窗口、动态、分享、鱼群保护、口味权重 |
| 观看历史 | 她真正看过的视频与看过之后做了什么 |
| 记忆 | 新记忆库的状态、话题目录、重要事实、见闻区、侧写 |
| 扩展 | 本地扩展的启用与重载 |
| 全部参数 | 三份配置的完整扁平树 |
| 诊断 | 体检、路径、日志 |

> 记忆是一个 SQLite 库（`characters/<角色>/memory/memory.db`）：按人归属、重要事实单独存、B站与空间各有见闻区。细节见仓库 [`docs/guides/features/MEMORY.md`](../../docs/guides/features/MEMORY.md)。

## 三份配置

| 文件 | 谁读 |
| --- | --- |
| `<仓库根>/config.json` | 桥接（QQ 全部参数） |
| `~/.dsh/stellar/config.json` | 插件（启动开关、管理员、界面偏好） |
| `~/.dsh/stellar/bili.config.json` | B站 工具链与生物钟 |

三份互不复制的，改错地方的表现是「改了没反应」。保存时自动备份到 `~/.dsh/stellar/backups/`。

## 能力开关

面板「设置 → 她的能力」有 15 个开关，关掉哪个她就真的不再做那件事：

- 聊天助手：待办提醒、替人问主人、主动分享给好友
- QQ空间：发说说提醒、空间互动监看、自动点赞/评论
- B站 刷与发：刷视频（生物钟）、发动态、看后日报、每日 vlog
- B站 互动：自动评论/回复、视频分享、鱼群保护、每日三连、评论区倾听

写在 `src/capabilities.js`，桥接与调度器都读同一份。

## 目录

```
plugins/stellar/
  package.json / cordis.patch.yml / icon.svg / locale/
  lib/
    index.js      宿主：路由、配置、桥接控制、扩展、诊断
    client.js     设置窗口（React，无构建步骤）
    store.js      三份配置 + 备份 + 脱敏
    privacy.js    确定性隐私闸门（跨平台搬运时的硬拦）
    memory.js     观看历史与记忆的整理
    align.js      身份对齐（同一个人在两个平台上是同一个）
    platforms.js  平台适配器注册表（贴吧预留）
    extensions.js 扩展宿主
    scheduler.js  B站 生物钟
    bridge.js     桥接探活 / 启停 / 控制台调用
    run-mode.js   三种运行模式
    token-budget-service.js  token 账本与额度
  tools/          B站 工具链（58 条子命令，入口 tools/bili.mjs）
  extensions/     sts2 / bili-live 两个空壳示例
  platforms/      tieba 预留
  presets/        qq-chat-v2 的 bundle patch（由仓库脚本生成，别手改）
  persona/        占位目录
  scripts/        插件自己的回归与 UI 探针
```

## 回归

```
node plugins/stellar/scripts/test-client-contract.mjs
node scripts/test-audit.mjs
```

第二条是仓库全量（159 条），要先把依赖装上（`首次启动.bat` 会装）。

## 已知边界

- 改 QQ 配置后桥接要重启（它只在启动时读 `config.json`）；B站 配置下一轮生效。
- 扩展默认关闭；开启等于允许执行本地代码，只开信得过的。
- 贴吧只是接口预留，没接真实平台。
- 只发文字和图片：不合成语音，也不发图片以外的富媒体。
