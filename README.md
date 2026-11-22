# Stellar — 给 DSH agent 一个真实的身份：QQ × B站 × QQ空间

**中文** | [English](README.en.md)

> 一句话：**它不是“把大模型接进 QQ”的机器人框架，而是给模型一个身份、一套会遗忘也会记住的记忆、
> 一份作息、两只手（QQ / B站），让它自己过一天。**

| | |
| --- | --- |
| 版本 | `1.1.0` |
| 目标 DSH | `0.2.1-rc.2 或更新`（本机长期跑在 `0.2.2-rc.1`；`node scripts/verify-dsh-020-adaptation.mjs` 可逐项复核） |
| 平台 | Windows 10/11（沙箱 ACL、SnowLuma 接入与启动脚本都与它绑定） |
| 许可 | MIT（SnowLuma 是第三方专有运行时，**不随本仓库分发**） |
| 必装第三方 | SnowLuma2（QQ 接入，自行下载并扫码登录） |

> 🔒 **本仓库不含任何真实数据**：角色卡是空模板（`roles/`），记忆是空壳（`examples/`），
> 群号 / 群友名单 / QQ 号 / B站 mid 全部为占位符，出厂人格是**空白**的（等你自己填）。
> 运行时数据永远只在你自己的机器上。

---

## 让 DSH 自己装（也可以只发一条链接）

把这句话发给 DSH：

> 帮我安装 Stellar（本仓库），按 README 的步骤来。

**顺序很重要**（DSH 常常先 install_bundle、后装依赖，结果激活时报 `Cannot find module '@deepseek-ai/schemastery'`）：

1. `npm install`（没有 npm 就用 DSH 自带的 pnpm：`~/.dsh/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.cjs`）
2. 再 `plugin_manager install_bundle`（或 `node scripts/setup-dsh.mjs`）
3. 重启 DSH → 设置 → Stellar → 诊断 → 一键安装

> 用 junction 链接安装时，模块是从**仓库真实路径**解析的，所以仓库根必须有 `node_modules` —— 这就是第 1 步不能省的原因。

两个实测踩过的点：

- **必须从仓库根目录安装**：插件里有几十处 `../../../src/xxx.js`（人设、记忆、token 预算等），
  只装 `plugins/stellar` 会去找 `C:\src\...` 然后报模块不存在。
- **装完要刷新页面**（F5）或重启 DSH：客户端模块图是页面加载时的快照，新 bundle 要重新拉，
  否则设置里暂时看不到 Stellar —— 不是装坏了。

## 第一次装

**省事版**：拿到仓库后双击根目录的 **`首次启动.bat`**。它会依次检查 Node 版本、装依赖、
从 `config.example.json` 复制出一份 `config.json`、建 `state/`、收紧它的 ACL、装进 DSH、
对齐 DSH 端口；缺什么补什么，**已有的 `config.json` 绝不覆盖**，重跑只是跳过已完成的步骤。

> 机器上只有 DSH、没装 Node？`首次启动.bat` / `start.bat` / `配置.bat` 和 `bootstrap.mjs` 都会回退到
> DSH 自带的 node 与 pnpm，不需要另外装。找不到 DSH 的 CLI（桌面版的 `dsh.cmd` 不在 PATH 里）时，
> `setup-dsh.mjs` 会把该手动跑的那条命令打印出来，**不会**回滚已经写好的 profile。

跑完给你一张表，写清楚还差哪几项要手动填（主人 QQ、白名单、SnowLuma 端口）。

**命令版**：

```powershell
git clone --depth 1 <本仓库地址> stellar
cd stellar
node scripts/bootstrap.mjs             # 问一句再动手（有这个 node 就用它，没有就用 DSH 自带的）
node scripts/bootstrap.mjs --dry-run   # 只看计划，什么都不改
```

> 用 `npm run bootstrap` / `npm run bootstrap:check` 也一样（等价的两条 script）。
> 之所以主推 `node ...` 直接写：只有 DSH、没装 Node 的机器上 `npm` 这个命令本身就不存在。

> 只有一条 `.ps1` 想分给别人：`powershell -ExecutionPolicy Bypass -File <本仓库>/scripts/bootstrap.ps1`
> —— 它负责找 node / 下载仓库，然后交给同一个 `bootstrap.mjs`，判定逻辑只有一份。

填配置不想手写 JSON 就双击 **`配置.bat`** —— 本地页面（只听 `127.0.0.1`、带一次性令牌），
路径自己选、只改表单里的键、先校验再落盘、改之前自动备份。文件不存在时能按模板新建。

最后重启 DSH → 设置 → Stellar → **诊断 → 一键安装（全部）**（自动发现 SnowLuma、写白名单、起桥接）。

前置：Windows + Node ≥22.13（可由 DSH 提供）+ DSH 0.2.1-rc.2 或更新 + SnowLuma2（第三方，需自己装并扫码）。详见 [INSTALL.md](docs/guides/getting-started/INSTALL.md)。

---

## 目录

- [一、这是什么](#一这是什么)
- [二、安装（新用户从这里开始）](#二安装新用户从这里开始)
- [三、日常使用](#三日常使用)
- [四、能力总览](#四能力总览)
- [五、架构一图](#五架构一图)
- [六、文档地图](#六文档地图)
- [七、安全与边界](#七安全与边界摘要)
- [八、常见问题](#八常见问题faq)
- [九、开发](#九开发)
- [十、许可与合规](#十许可与合规)

---

## 一、这是什么

一个跑在**你自己电脑上**的双进程系统：

- **一条腿在 DSH 里**：`stellar` 插件 —— 设置窗口、B站 生物钟、记忆维护、看板。
- **一条腿是独立进程**：`src/bridge.js` —— QQ 收发、会话映射、控制台、安全闸门。

合起来，它让 agent 能：

1. **在 QQ 里当一个群友**：自己判断要不要看、要不要说、说几条、引用谁；说完能判断“这段可以结束了”，带着“下次怎么接”潜水。
2. **在 B站 当一个用户**：有自己的作息、偏好、每日额度；看视频会打分、会评论、会回帖、会发动态，想发的话还能自己做一条 vlog。
3. **还会逛 QQ空间**：看「好友爱看」公开动态、给高分点赞、挑几条评论，自己发说说。
4. **记得住**：聊过的话切成话题、生日这类私人信息单独存成「重要事实」、看过的视频与刷过的动态写进见闻区；问「我生日什么时候」她查得到。
5. **会主动找你**：从近期记忆里提炼「我想弄明白/想做点什么」，在安静时段外主动分享或索取；也会按你记的待办到点提醒指定的人。

> 它**不做**：不代你登录/扫码/绕过平台风控，不做多用户，不把控制台暴露到公网，
> 不删除任何不可恢复的数据。完整边界见 [BOUNDARIES.md](docs/guides/operations/BOUNDARIES.md)。

> 只有文字与图片：`config.json` 里的 `socialV2.voice` / `tools.sendVoice` 是两个死键（为保持两份配置字节一致而保留），改了不会生效。

---

## 二、安装（新用户从这里开始）

### 2.1 环境要求

| 需要 | 版本 / 说明 | 必装？ |
| --- | --- | --- |
| Windows | 10/11（沙箱 ACL 与 `.bat` 启动器按 Windows 写） | ✅ |
| Node.js | **≥ 22.13**。没单独装也行：DSH 桌面版自带一份 node（`~/.dsh/dsh-runtimes/*/dependencies/node/bin/node.exe`），启动脚本与 `bootstrap.mjs` 会自动回退到它 | ✅（可由 DSH 提供） |
| DeepSeek Harness（DSH） | **`0.2.1-rc.2 或更新`**，能正常打开 Web GUI | ✅ |
| SnowLuma2 | 第三方 QQ 运行时，**自己去官方 Releases 下载**并扫码登录 | ✅（只玩 B站/记忆也要它来收 QQ） |
| ffmpeg | 抽帧看视频、剪 vlog 时才需要（PATH 里、`<仓库>/bin/`、或 `~/.dsh/stellar/bili/bin/` 任一处） | ⭕ 按需 |

> ⚠️ **Stellar 不下载、不安装、不打包 SnowLuma**（EULA §5.4）。它只做“检测已安装 + 一键打开窗口 + 连接状态”，
> 登录与扫码始终由你自己完成。

### 2.2 两条安装路线：exe（最省事）或命令行

**A. Windows exe（推荐给不想碰命令行的人）**

1. 去 [Releases](https://github.com/lpfaxe/Stellar/releases) 下载 `Stellar.exe`；
2. 把它放进一个空文件夹（或者随便哪里都行），双击；
3. 它会问解压到哪个目录（默认 `%USERPROFILE%\Stellar`），回车确认；
4. 解压完问「现在做首次启动检查吗」，回车 → 它会调 `首次启动.bat`（装依赖、生成配置、对齐 DSH 端口）；
5. 打开 DSH → 设置 → Stellar → 诊断 → 一键配置，填主人 QQ 与白名单，再点「启动QQ」。

以后要启动：还是双击同一个 `Stellar.exe`（放在程序目录里时它是菜单：首次检查 / 启动桥接 / 打开控制台）。

> 这个 exe **只是引导器**：自带一份程序压缩包，解压 + 调现有的 `.bat`。它不装 DSH、不装 SnowLuma、不写注册表；
> 卸载 = 删掉那个文件夹。没签名，首次运行 Windows 会提示「未知发布者」，点「更多信息 → 仍要运行」。
> 想自己构建：`node scripts/build-windows-exe.mjs`（产物在 `dist/`，不进仓库）。

**B. 命令行**（开发者、或想跟着 git 更新的人）

### 2.3 五步装好（命令行路线）

> 第一次装、或卡在某一步：看 [INSTALL.md](docs/guides/getting-started/INSTALL.md)（手把手，含 SnowLuma 配置、白名单、排错表）。

```bash
# 1) 取代码
git clone <本仓库地址> stellar
cd stellar

# 2) 装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM bug）
npm install
#    没有 npm（只装了 DSH）？直接跑第 4 步，bootstrap 会用 DSH 自带的 pnpm 装

# 3) 复制配置模板（也可以直接跳到第 4 步，bootstrap 会替你复制）
copy config.example.json config.json

# 4) 装进 DSH（preset + 三个 MCP server + stellar bundle，幂等，可重复跑）
node scripts/setup-dsh.mjs

# 5) 重启 DSH → 设置里出现 Stellar →
#    在「概览」点「启动QQ」（或命令行 npm start / start.bat）
```

`setup-dsh.mjs` 做三件事：

1. 把 `qq-chat` / `qq-chat-v2` / `bili-slim` 三条 **agent preset** 插进 DSH profile（DSH 0.1.7 起的 bundle patch 机制）；
2. 在 profile 的 `cordis.patch.yml` 挂 **三个 MCP server**（QQ 工具 / SnowLuma 探活 / 只读联网搜索）；
3. 在 profile `package.json` 注册唯一一个 bundle：`stellar`。

> 需要装到别的 profile：`node scripts/setup-dsh.mjs <profile名>`（默认自动探测，兜底 `web`）。

### 2.4 最小配置（只填这 4 处）

打开仓库根目录的 `config.json`：

| 位置 | 填什么 | 不填会怎样 |
| --- | --- | --- |
| `snowluma.wsUrl` / `httpUrl` / `accessToken` | SnowLuma 的 OneBot WS、HTTP、token（**HTTP 与 WS 端口可能是两个不同的值**） | 桥接连不上 QQ，控制台显示“未连接” |
| `ownerQQ` | 你自己的 QQ 号（`closed-agent` 模式只认这个人） | 管理员功能失效 |
| `allow.private` / `allow.groups` | 允许她接触的私聊 / 群（数组） | **白名单为空 = 谁都不响应**（不是全放行） |
| `consoleToken` | 控制台令牌；留空会自动生成到 `state/console-token` | 控制台需要令牌才能进 |

最小可用示例（把占位符换成你的）：

```jsonc
{
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "<SnowLuma token>" },
  "ownerQQ": 1000000001,
  "allow": { "private": [1000000001], "groups": [100000004] },
  "consoleToken": ""
}
```

> 其余 20 多个顶层键都有默认值，全部含义见 [DATA-AND-CONFIG.md §1](docs/guides/operations/DATA-AND-CONFIG.md)。
> 装好之后**建议一切都在设置页里改**（保存即生效，且会自动备份）。

### 2.5 首次验证

```bash
node scripts/test-audit.mjs                     # 离线回归（不联网、不发消息；等价 npm run test:audit）
node scripts/check-onebot-status.mjs            # OneBot 连通性（只读）
node scripts/verify-dsh-020-adaptation.mjs      # 对本机 DSH 版本逐项复核
```

真机验证三件事：**在群里 @ 她 → DSH 里出现对应会话 → 回复回到 QQ**。

想先看一眼它现在的状态，双击 **`启动控制台.bat`**（见 [3.7](#37-两个控制台)）：桥接 / DSH / SnowLuma 三个灯、今天花了多少、在聊几个会话、她手上有哪些待办、最近日志。

### 2.6 安装常见失败

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 设置页找不到 Stellar | bundle 没装上 / DSH 没重启 | 重跑 `setup-dsh.mjs`，重启 DSH |
| 桥接起来了但收不到消息 | SnowLuma 未登录 / token 不对 / WS 端口不是 3001 | 控制台「运行总览」看状态；对照 `config.json` 的 `snowluma.*` |
| 群里 @ 她没反应 | 白名单没加这个群 / 模式不对 / 已暂停 | 看「访问与安全」页；确认 `allow.groups` |
| agent 只会说话、不调工具 | MCP 没挂上 / 工具被安全守卫隐藏 / 工具开关关了 | 重跑 `setup-dsh.mjs`；看设置页工具开关 |
| 控制台 401 | 没带令牌 | 用 `http://127.0.0.1:3100/?token=<consoleToken>` |
| `npm install` 后启动报 ESM 错 | postinstall 补丁没跑 | `npm rebuild` 或手动 `node scripts/patch-snowluma-sdk.mjs` |
| 面板打开一片空白 / 花费显示 “—” | 还没跑过桥接，没有数据 | 正常；先跑一次 `首次启动.bat`，再刷新 |

更多故障与恢复见 [BOUNDARIES.md §3](docs/guides/operations/BOUNDARIES.md)。

---

## 三、日常使用

### 3.1 设置页（DSH → 设置 → Stellar）

**7 个标签**：概览 / 她 / QQ / B站 / 记忆 / 角色 / 高级。

| 标签 | 你在这能干什么 |
| --- | --- |
| 概览 | 三个状态点（QQ / B站 / 生物钟）、一键启动或停止各平台、组件更新、诊断入口 |
| 她 | 三档运行模式（正常 / 摸鱼 / 最低限度）点一下立即生效、待办事项（列出来 / 加一条 / 完成 / 取消，可指定提醒谁）、主动搭话的节奏与「试一次」 |
| QQ | SnowLuma 地址与 token、白名单、管理员、二代仿真各项开关、工具开关 |
| B站 | 扫码登录、作息窗口、偏好、每日额度、评论与动态开关；下部折叠着「观看历史」（她看过的视频、打分、收藏） |
| 记忆 | 新记忆库的只读概览（话题 / 重要事实 / 见闻区 / 侧写 / 后台作业）；下面才是叙事/向量两种方式的切换、向量索引与语义搜索、Embedding 包安装、双向脱敏同步；**写操作在浏览器面板或 `stellar_memory_*` 工具** |
| 角色 | 人格卡与记忆库整包切换、新建 / 复制 / 存档 / 回档 |
| 高级 | 三个子页签：**扩展**（第三方扩展的启用 / 停用 / 参数 / 重载）、**全部参数**（三份配置的全部键，可搜索可改）、**诊断**（新手体检、一键安装、自检、备份与恢复） |

### 3.2 四种桥接模式

| 模式 | 她是谁 | 能干什么 |
| --- | --- | --- |
| `chat` | 普通群友 | 白名单内聊天，工具面受安全守卫限制 |
| `closed-agent` | 只理管理员 | 私聊 owner，可用完整 DSH 工具 |
| `reserved` | 一代仿真群友 | 状态机 + 空格分条 + `[SILENT]` |
| `reserved2` | 二代仿真群友（**默认**） | 一切皆工具：自己看消息、发言、等待、潜水、收尾 |

> 另有**三档运行模式**（面板 / 设置页里切，和上面这层是两回事）：
> **正常**（照常跑每日任务）、**摸鱼**（只写日志，多刷多看多聊；周六日默认）、**最低限度**（只回消息，说完就睡；优先级最高）。
> 三档之外还有「跟随默认」——不手动指定时按 `config.runMode` → 周末 → 正常 的顺序推。

### 3.3 让她主动找你（可选）

设置页「目的」：节奏、安静时段；先点**预览**（零副作用）再「试一次」。
硬闸门：安静时段 / 每日上限 / 主人在聊 / token 额度。载体固定走 QQ 桥接。

### 3.4 B站（可选，但这是她的“日常”）

设置页 **B站** → 扫码登录 → 填作息窗口（例如 `20:00–24:00`）→ 选偏好 → 设额度。
她会在窗口内自己看视频、打分、评论、发动态；**默认不分享到 QQ**（可开）。

面板「设置 → 她每天做什么」能逐项开关与调数量：刷视频（每天几次 / 几条 / 每周上限）、发动态（四个时段各一条）、
刷好友爱看（看几条 / 赞几条 / 评几条 / 几点开始）、发说说（每周几条 / 每天几点提醒），改完下一轮 tick 就按新值跑。

### 3.5 角色与记忆

- **角色包** = 人格卡 + 记忆 + B站 行为账本，整包切换；新建 / 复制 / 存档 / 回档都在设置页「角色」。
- **出厂人格是空白的**：`roles/示例角色.md` 是一份填空模板（你是谁、说话风格、性格、梗、回复示例），复制到
  `~/.dsh/stellar/characters/<id>/persona.md` 再改；不填她就没性格。
- **记忆**在这几层：

| 层 | 存什么 | 在哪看 |
| --- | --- | --- |
| 缓存 | 原始消息（等你和她都说过话才成话题） | 面板「记忆」顶部 |
| 话题 | 一段对话的摘要 + 重要性 + 归属人 | 面板「话题目录」 |
| 重要事实 | 生日 / 忌口 / 过敏 / 地址 / 电话 / 称呼 / 约定 | 面板「重要事实」（可注入、可改、可删） |
| 见闻区 | 她自己在 B站 看了什么、在好友爱看刷到什么（自己写 ≤400 字） | 面板「B站记忆」「好友爱看记忆」 |
| 人物侧写 | 一句话记住一个人（≤50 字，每日复核） | 面板「通讯录 → 人物侧写」 |

> 记忆按**对象**分：问她「你知道我的生日吗」，她查的是你；问「你昨天和 XX 聊了什么」，她查 XX，再看能不能说。
> 隐私分三级：`normal`（谁问都能说）/ `private`（只在跟本人说话时提）/ `secret`（只本人私聊或面板）。

### 3.6 待办与提醒

你说「后天提醒我买东西」，她记下来，到点提醒**你**；说「提醒阿橙带伞」，就提醒阿橙（`targetKey` / `targetName`）。
面板「她的事项」可以替她加一条、指定提醒谁、删掉旧的；到点由调度器叫她起来发消息，发完自动收尾。

### 3.7 两个控制台

**① 完整面板（推荐）** —— 双击仓库根目录的 **`启动控制台.bat`**，浏览器打开 `http://127.0.0.1:3300/`。

七个页面：**概览 / 她今天 / 通讯录 / 记忆 / 鱼缸小镇 / 运行日志 / 设置**，共 37 张卡。
概览有运行状态、快捷操作（自检 / 启动 SnowLuma / 重连 DSH / 重启 DSH / 紧急停止）、运行模式切换、花费看板、
待办审批；「她今天」有每日任务打卡、B站 与空间动态、视频清单、日报、待办、图片池；
「通讯录」管白名单与人物侧写；「记忆」看话题 / 事实 / 见闻区 / 侧写；「设置」是每日任务、能力开关、白名单、远程访问。

**第一次打开是空的，这是正常的** —— 它读的是 `~/.dsh/stellar/` 和仓库里的 `config.json`，你还没跑过就没有内容：

| 卡片 | 空的原因 | 什么时候有 |
| --- | --- | --- |
| 她此刻在做什么 / 运行状态 | 桥接没起过 | 跑过 `首次启动.bat` 之后 |
| 通讯录 | 还没人跟它说过话 | 收到第一条私聊 / 群消息后自动建档 |
| 记忆库 / 重要事实 | 缓存没攒够 | 聊几轮，切分后出话题；生日这类自动进事实 |
| B站 / 空间 | 还没刷过 | 调度器按生物钟跑一轮后 |
| 花费 | 没有用量 | 有对话后按价目折算 |

- 只监听 `127.0.0.1`；换端口 `set STELLAR_PANEL_PORT=3301`。
- 页面拿不到桥接的 `consoleToken`，由面板后端转发时自带。
- 面板口令与审计日志写在 `~/.dsh/stellar/`，**不写进仓库目录**（`.gitignore` 已兜）。
- 想让同一 WiFi 的手机连：`set STELLAR_PANEL_HOST=0.0.0.0`；要出门也能连，见「设置 → 远程访问」里的隧道。

**② 桥接自带单页控制台** —— `http://127.0.0.1:3100/?token=<consoleToken>`。
它不需要面板进程，桥接跑着就有：运行模式 / 会话映射 / 挂起审批 / 活动日志 / 人格与角色 / 一代仿真 / 二代仿真 /
黑话库 / MCP 工具 / 白名单 / 静默开关 / DSH 模型与思考强度 / 安全拦截通知 / 访问令牌 / 测试发送 / 桥接控制 / 令牌与花费。

细节见 [stellar-manager/README.md](stellar-manager/README.md)。

### 3.8 检查更新

**设置 → 概览 → 更新**：检查 `Stellar 本体`（走 git：`fetch` 只读 + `merge --ff-only`，本地有改动会拒绝）
以及 `config.json` 的 `updates.components[]` 里登记的其他组件（`git` / `release` 两种来源，release 会下 zip 并校验 sha256）。
DSH 启动后会自动查一次，有更新时打开概览会弹窗，可勾「不再提示本次」。

### 3.9 鱼缸小镇（只有一个接口，默认不启用）

小镇（[fishbowltown.com](https://fishbowltown.com)）是她在别处的「私人时间」：记最近三天见过谁、玩过什么。
本仓库**只留接口，默认关着**——`town.enabled` 默认 `false`，没有访问码，装完不连、不醒、不花钱：

- 想用：在 `%DSH_HOME%/fishbowl-town/settings.json` 填自己的 `fbo_…` 接入码，再把 `%DSH_HOME%/stellar/bili.config.json` 的 `town.enabled` 改成 `true`。两步都做才动。
- 会花钱的动作（坐下 / 玩牌 / 请客）已经注册成 10 个 `stellar_town_*` 工具（`stellar_town_now` 一次给全「此刻 / 大厅 / 今天 / 三天回顾」，`stellar_town_album` 把镇上相册镜像到本地、直接返回可发图的绝对路径），但只有 `town.enabled` 与 `town.actions` 都开着、且没超每日上限时才会真执行；默认两个都是关的，执行期由 `townActionPreflight` 直接拒掉（不是「没装工具」）。
- 记忆只到 3 天，单独一个 `town.db`，不进备份、不进安装清单。
- 细节：[SUBSYSTEM-TOWN.md](docs/guides/subsystems/SUBSYSTEM-TOWN.md)。

---

## 四、能力总览

| 子系统 | 你能看到的能力 | 细节 |
| --- | --- | --- |
| **QQ** | 群 / 私聊收发、引用回复、分条、表情包、图片 / 动图、拍一拍、合并转发展开、上线补历史、提问 / 审批回传、四种桥接模式 | [ARCHITECTURE.md](docs/guides/architecture/ARCHITECTURE.md) |
| **B站** | 扫码登录、看视频 / 打分 / 收藏、评论与回帖、发动态（含图文）、弹幕、私信、三连、直播间监听、每日 vlog、分享到 QQ；**58 条 CLI 命令** | [SUBSYSTEM-BILI.md](docs/guides/subsystems/SUBSYSTEM-BILI.md) |
| **QQ空间** | 看自己的 / 好友的 / 通讯录里某个人的说说、点赞、评论与回复、删自己发的评论；「好友爱看」公开流（看 → 打分 → 点赞 → 评论） | [SUBSYSTEM-BILI.md](docs/guides/subsystems/SUBSYSTEM-BILI.md) |
| **记忆** | 话题切分、重要事实（生日 / 忌口 / 过敏 / 地址 / 电话）、见闻区（B站 / 好友爱看）、人物侧写、风格参考库、三级隐私、按人查询 | [MEMORY.md](docs/guides/features/MEMORY.md) |
| **人格** | 多角色整包切换、自动存档 / 回档、管理员双身份、跨平台身份对齐、风格参考片段注入 | [CHARACTER_PERSONA.md](docs/guides/features/CHARACTER_PERSONA.md) · [CROSS_PLATFORM_IDENTITY.md](docs/guides/features/CROSS_PLATFORM_IDENTITY.md) |
| **主动** | 目标假设 → 主动搭话 / 分享、对话收尾（带「下次怎么接」）、二代 proactive | [PURPOSE_OUTREACH.md](docs/guides/features/PURPOSE_OUTREACH.md) · [CONVERSATION_CLOSURE.md](docs/guides/features/CONVERSATION_CLOSURE.md) |
| **日常** | 三档运行模式（正常 / 摸鱼 / 最低限度）、生物钟、每日任务清单、待办提醒、安静时段 | 本文 §3.2 / §3.6 |
| **图片** | 网图池（每天清空、最多 30 张、可单删全删）、B站 封面池、每日截图留存 | 面板「她今天」 |
| **额度** | 每日 token 额度（QQ / B站 / 好友爱看 / 小镇 / 其他 / 总额，80% 提醒、100% 停）、消费看板、按价目折算成本 | [TOKEN_USAGE_CONSOLE.md](docs/guides/operations/TOKEN_USAGE_CONSOLE.md) |
| **工具面** | **84 个 MCP 工具**（`src/mcp-snowluma-safe.js` 71 个：36 个 `qq_*` + 35 个 `stellar_*`；`src/town-tools.js` 10 个 `stellar_town_*`；宿主级 1 个 + 联网搜索 2 个 —— 合计 45 个 `stellar_*`）、三个 MCP server、两代 preset、fail-closed 工具守卫 | [AGENT-TOOLS-AND-PRESETS.md](docs/guides/subsystems/AGENT-TOOLS-AND-PRESETS.md) |
| **界面** | 设置页 7 个标签、完整面板 7 个页面 / 37 张卡、桥接自带单页控制台 | [UI-AND-CONSOLE.md](docs/guides/subsystems/UI-AND-CONSOLE.md) |

---

## 五、架构一图

```
┌──────────────── 用户可见 ────────────────┐
│ DSH Web GUI     面板 :3300    控制台 :3100 │
└──────┬──────────────┬─────────────┬──────┘
┌──────▼──────────────▼─────────────▼──────────────────────────┐
│ DSH 宿主  └─ stellar 插件（bundle）                            │
│     设置页 · 设置 API · B站 调度 · 记忆维护 · 额度 · 扩展宿主   │
└──────┬───────────────────────────────────────────────────────┘
       │ HTTP（会话 Cookie） + 子进程管理
┌──────▼───────────────────────────────────────────────────────┐
│ QQ 桥接进程（node src/bridge.js，单实例）                       │
│   OneBot WS · DSH 客户端 · 控制台 :3100 · 三个 MCP server       │
└──┬────────────┬──────────────┬───────────────────────────────┘
   │ WS         │ stdio        │ HTTP
┌──▼────────┐ ┌─▼──────────┐ ┌─▼─────────────────┐
│ SnowLuma2 │ │ DSH MCP    │ │ B站 / 空间 / 搜索  │
│（第三方）  │ │ 客户端      │ │（命令行与 HTTP）    │
└───────────┘ └────────────┘ └───────────────────┘
```

- **两套状态根**：桥接数据在 `<仓库根>/state/`，插件数据在 `~/.dsh/stellar/`。
- **三份配置**：`<仓库>/config.json`（QQ 与桥接）、`~/.dsh/stellar/config.json`（合体层）、`~/.dsh/stellar/bili.config.json`（B站调度）。
- **DSH 端口会漂移**：桥接与插件都用 `discoverDshBaseUrl()` 发现，不要硬编码。

完整说明（含数据流与重启矩阵）：[ARCHITECTURE.md](docs/guides/architecture/ARCHITECTURE.md)。

---

## 六、文档地图

| 步 | 读什么 | 读到什么程度 |
| --- | --- | --- |
| 1️⃣ 5 分钟 | **本文** | 它是什么、怎么装 |
| 2️⃣ 15 分钟 | [ARCHITECTURE.md](docs/guides/architecture/ARCHITECTURE.md) | 几个进程、怎么分层、改什么要重启什么 |
| 3️⃣ 按需 | 下面分册 | 改哪个子系统翻哪本 |

| # | 文档 | 行数 | 什么时候翻它 |
| --- | --- | --- | --- |
| 1 | [ARCHITECTURE.md](docs/guides/architecture/ARCHITECTURE.md) | 115 | 总纲：进程、分层、一条消息的旅程、改什么要重启什么 |
| 2 | [DATA-AND-CONFIG.md](docs/guides/operations/DATA-AND-CONFIG.md) | 111 | 三份配置的每个键、状态文件全表、备份与回滚 |
| 3 | [BOUNDARIES.md](docs/guides/operations/BOUNDARIES.md) | 135 | 能做到什么、做不到什么、坏了怎么恢复 |
| 4 | [MEMORY.md](docs/guides/features/MEMORY.md) | 154 | 记忆怎么切、怎么存、怎么注入、隐私三级 |
| 5 | [UI-AND-CONSOLE.md](docs/guides/subsystems/UI-AND-CONSOLE.md) | 94 | 设置页 7 页签与面板 7 页签 / 37 张卡 |
| 6 | [SUBSYSTEM-BILI.md](docs/guides/subsystems/SUBSYSTEM-BILI.md) | 240 | B站 59 条命令、空间功能、鱼群与弹幕 |
| 7 | [AGENT-TOOLS-AND-PRESETS.md](docs/guides/subsystems/AGENT-TOOLS-AND-PRESETS.md) | 232 | 84 个工具、守卫、两代 preset |
| 8 | [CHARACTER_PERSONA.md](docs/guides/features/CHARACTER_PERSONA.md) | 137 | 角色包怎么放、人格卡怎么起作用 |
| 9 | [PURPOSE_OUTREACH.md](docs/guides/features/PURPOSE_OUTREACH.md) | 556 | 她为什么会主动找人说话 |
| 10 | [CROSS_PLATFORM_IDENTITY.md](docs/guides/features/CROSS_PLATFORM_IDENTITY.md) | 151 | QQ 号与 B站 号怎么算同一个人 |
| 11 | [CONVERSATION_CLOSURE.md](docs/guides/features/CONVERSATION_CLOSURE.md) | 136 | 一段对话怎么算结束 |
| 12 | [FOLDER_MAP.md](docs/FOLDER_MAP.md) | 86 | 目录里都是什么 |
其它：DSH 装配 [DSH_SETUP.md](docs/guides/getting-started/DSH_SETUP.md) · SnowLuma 排错 [SNOWLUMA_TROUBLESHOOT.md](docs/guides/getting-started/SNOWLUMA_TROUBLESHOOT.md) ·
安全基线 [SECURITY_BASELINE.md](docs/guides/operations/SECURITY_BASELINE.md) · 全部索引 [docs/README.md](docs/README.md)。

---

## 七、安全与边界（摘要）

- **群友碰不到你的机器**：仿真会话的工具面是白名单、fail-closed，本地执行能力全部被 restrict。
- **发送必须命中白名单**：没有“管理员例外”这种后门。
- **身份靠会话令牌，不靠自报**：`stellar_*` 主人工具要带唤醒提示里的【会话令牌】，桥接回验后才认；
  内部调度会话另有一枚短期 operator 令牌（10 分钟、只存内存、登记在脱敏集合里）。
- **控制台只接受本机回环** + 令牌（定长比较）+ Host / Origin 校验 + 写操作强制 JSON。
- **密钥不落日志**；`state/` 与 `config.json` 用 icacls 切断 ACL 继承（原子写之后也会重新收紧）。
- **不可逆删除 = 事故**：清理一律先隔离到 `_backups/` 或 `memory-trash/`。
- **不承诺**提示注入的语义层 100% 防护（真正的边界是工具面与白名单）。
- **隐私闸**：出站文本在离开本机前多一道确定性检查 —— 主人的生日 / 所在城市 / 住址 / 手机号 / 身份证、
  通讯录里别人的 QQ 号（公开面还包括别人的备注与昵称），命中即拒绝发送。覆盖 QQ 私聊 / 群聊出站、
  B站 动态 / 评论 / 私信、QQ空间说说与评论、视频脚本（`vlog render` / `vlog publish`，命中退出码 8，不渲染不发布）。
  实现在 [plugins/stellar/tools/lib/privacy-guard.mjs](plugins/stellar/tools/lib/privacy-guard.mjs)。
- **文件读取有闸**：`stellar_file_read` 的本地路径必须在工作区内、URL 必须过公网白名单（挡 SSRF）。
  扫描件 PDF 会自动走 Windows 自带 OCR（零安装），详见 [DOCUMENTS.md](docs/guides/features/DOCUMENTS.md)。

详见 [SECURITY_BASELINE.md](docs/guides/operations/SECURITY_BASELINE.md)、[BOUNDARIES.md](docs/guides/operations/BOUNDARIES.md)、[RULES.md](RULES.md)。

---

## 八、常见问题（FAQ）

| 问题 | 回答 |
| --- | --- |
| 能不装 SnowLuma 吗？ | QQ 部分不能（它负责登录与收发）。只想要 B站 / 记忆 / 空间可以，但她听不到 QQ 消息。 |
| 能不用 DSH 吗？ | 不能，插件与 preset 都跑在 DSH 里。 |
| 会自己发消息吗？ | 默认不会。主动搭话要显式开「目的」；二代模式下发言必须调工具。 |
| 数据会上传吗？ | 只有拼进提示词的文本会发给模型 API；不想让黑话词条出机就关 `slang.autoResearch`。 |
| 支持 Linux / macOS 吗？ | 暂不支持（沙箱 ACL 与启动脚本按 Windows 写）。 |
| 能多用户 / 远程吗？ | 面板默认只听回环；要远程得自己开隧道或改 `STELLAR_PANEL_HOST`，并配上口令。 |
| 改名 / 换角色会丢记忆吗？ | 不会。角色包整包隔离，切换带快照，可回档；记忆按对象存在 `memory.db` 里。 |
| 记忆存哪？ | `~/.dsh/stellar/characters/<id>/memory/memory.db`（SQLite）。删它等于让她失忆。 |
| 花多少钱？ | 只有调模型才花钱；面板「花费」按价目折算，可设每日额度。 |

---

## 九、开发

```bash
npm run test:audit              # 默认门禁（210 个脚本，其中 180 条进 audit；离线；需要完整面板的几条在公开仓库里自动 SKIP）
npm run test:regressions        # 桥接 / 协议回归
npm run privacy-scan:strict     # 发布前隐私扫描（0 命中才可发布）
npm run guard:check             # DSH 升级后先跑（asar 会话护栏补丁是否还在）
node scripts/setup-dsh.mjs      # 重装 preset + MCP
node scripts/release-manifest.mjs    # 生成安装清单（对 git HEAD 算哈希）
```

> **发布顺序固定**：先 commit 代码 → 再 `node scripts/release-manifest.mjs` → 单独提交清单 → 再 push。
> 顺序反了，`--verify` 会一直红（清单里哈希对不上 HEAD）。

目录结构见 [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)；代码分层与“改什么要重启什么”见
[ARCHITECTURE.md](docs/guides/architecture/ARCHITECTURE.md)。

---

## 十、许可与合规

- 本仓库 **MIT**。
- **SnowLuma2 是第三方专有组件**，不随仓库分发、不打包；按 EULA §5.4，本程序不对它做安装 / 部署 / 代扫码。
  SnowLuma 的许可若有疑问，请联系其作者。
- 请自行遵守 QQ / B站 服务条款与当地法律；本项目不提供绕过风控的能力。
- 第三方组件与合规边界详见 [LICENSE](LICENSE)。

