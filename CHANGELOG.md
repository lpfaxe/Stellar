# 更新日志

> 从 **1.0.0** 开始记。更早的开发迭代不在这里，也不代表现在的能力——以本文件和代码为准。

## [1.0.0] - 2026-11-13

首个以 **Stellar** 为项目名的对外版本。这是一个「装在自己的电脑上、用自己的 QQ 号和一个 AI 角色聊天」的完整程序：QQ 网关 + 桥接 + DSH 会话 + B站/QQ空间 的自主活动。

### 它是什么

- QQ 侧：通过 SnowLuma 接 OneBot，白名单内的人私聊/群里都能跟她说话；桥接负责唤醒、分条、记忆、表情、安全边界。
- 她自己的时间：生物钟决定什么时候去看 B站、发动态、看 QQ空间的好友爱看、写日记、提醒待办。
- 记忆是一套新系统：SQLite（`memory.db`），按人归属，重要事实（生日、忌口等）单独存并带隐私分级，B站/空间的见闻另有一个区。
- 浏览器控制台：`启动控制台.bat` → `http://127.0.0.1:3300/。概览、她今天、通讯录、记忆、运行日志、设置六个页面。

### 装起来是什么样

- 双击 `首次启动.bat`（或 `node scripts/bootstrap.mjs`）按提示补齐：Node、依赖、`config.json`、主人 QQ 与白名单、状态目录权限、DSH 注册、DSH 端口、SnowLuma 网关。缺什么补什么，已完成的步骤自动跳过，绝不覆盖已有配置。
- **只有 DSH、没装 Node 的机器也能装**：`scripts/dsh-locate.mjs` 会去找 DSH 自带的 Node 与 pnpm；四个 .bat 也按「PATH → DSH 自带运行时」回退。
- `setup-dsh.mjs` 自己定位 `dsh.cmd`（PATH → DSH 安装目录 → 运行中的进程路径）；找不到就打印手动要跑的命令并跳过，不会把已经写好的 profile 回滚掉。
- 不代装 Node / DSH / SnowLuma，也不猜主人 QQ——这三样必须是使用者自己有的。

### 出厂就是空的

- **没有现成人格**：`roles/` 只有写作指南和一张空白模板；必回关键词、唤醒关键词、同类 bot 名单全部为空，人格由使用者自己写。
- **没有形象图**：`assets/self-image.png` 不存在时 `qq_get_self_image` 会说明「还没配形象图」，让她用角色卡里的文字描述自己。想配就把图放进去，或在 `config.json` 里写 `socialV2.selfImage`。
- **控制台首次打开是空的**：它读 `~/.dsh/stellar/` 与仓库 `config.json`，全新安装还没有聊天记录、没有记忆、没有花费。

### 这一版做对的地方

- 六份文档全部按代码现状重写，删掉了历史分析报告、旧 UI 截图和已剥离子系统的文档。
- `install-manifest.json` 对仓库内每个文件算 sha256，`verify` 能查出任何被改动或被删掉的文件。
- 隐私扫描（`scripts/privacy-scan.mjs`）在发布前跑一遍，扫本机路径、QQ 号、凭据形态。
- 控制台只监听 `127.0.0.1`，页面拿不到桥接 `consoleToken`（由服务端转发时附带）；面板口令存在 `~/.dsh/stellar/` 而不是仓库目录。
- 修复控制台首次加载 30 秒（计划任务探测去掉 `-ExecutionPolicy Bypass`，本机实测带它会挂到超时）与三个恒 500 的接口（`numParam` TDZ）。
- 隐私扫描器的凭据规则收紧为「值必须带引号」，`allowPaths` 补上嵌套的 `package-lock.json`（`sha512-` integrity 不是密钥）。

### 已知限制

- 平台只有 Windows。Node ≥ 22.13，DSH 桌面版，SnowLuma 2（OneBot 部分）。
- 只有文字与图片：没有语音发送、没有桌面宠物，也没有对应开关。
- `config.json` 里还留着 `socialV2.voice` / `tools.sendVoice` 两个死键（两份配置必须字节一致，暂时保留），写不写都不生效。
- `stellar-manager/panel-token.txt` 与 `audit.jsonl` 不进仓库；面板口令在首次启动时生成。
