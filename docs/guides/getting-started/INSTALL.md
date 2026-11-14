# 手把手安装（Windows）

> 目标：从一台干净的 Windows 电脑，到"她在群里回第一句话"。
> 全程约 **20 分钟**，其中 10 分钟是等下载。
>
> 如果卡住，先看最后的 [§9 出错怎么办](#9-出错怎么办)，那里覆盖了 90% 的失败。

---

## 0. 最省事：双击 `首次启动.bat`

解压/克隆之后，根目录有一个 **`首次启动.bat`**。双击它，剩下的环境检查与基础配置它自己做：

| 它会检查 | 缺了就补 | 补不了就告诉你怎么办 |
| --- | --- | --- |
| Node 版本 ≥ 22.13 | 先用 PATH 里的；没有就用 **DSH 自带的那份 node**（`~/.dsh/dsh-runtimes/.../node/bin/node.exe`），装依赖也走 DSH 自带 pnpm | 两边都找不到才给下载地址，并提示"装完重开窗口" |
| 项目依赖（7 个包） | `npm install`；没有 npm 就用 `node <DSH 自带 pnpm.cjs> install` | 失败时提示加 `--registry=` 换源 |
| `config.json` | 从 `config.example.json` **复制**一份 | - |
| 主人 QQ / 白名单 | —（不知道该填谁，只能你填） | 标黄并写清改哪几行 |
| `state/` 目录 | 建出来 | - |
| `state/` 权限 | 收紧 ACL（当前用户 + SYSTEM + Administrators） | 只会降级告警，不会中断 |
| `@snowluma/*` 的 ESM 补丁 | 补 `.js` 扩展名（幂等） | - |
| 装进 DSH（preset / MCP / bundle） | 跑 `setup-dsh.mjs`（自己去找桌面版的 `dsh.cmd`，不在 PATH 也行） | 没装 DSH 时直接告诉你先装 DSH；找不到 CLI 就打印该手动跑的命令，**不回滚**已写好的 profile |
| DSH 端口 | 把 `config.json` 的 `dsh.baseUrl` 对齐到正在运行的那个 | DSH 没开就跳过，下次再对 |
| SnowLuma | 只探测 3000 / 3001 | **第三方，不代装**：给你下载与扫码的下一步 |

跑完会打印一张表：哪些已就绪、哪些还得你手动填。**再双击一次**是安全的 ——
已经做好的步骤会显示"已存在"并跳过，**`config.json` 永远不会被覆盖**。

命令行等价物（想看清楚它准备做什么）：

```powershell
node scripts/bootstrap.mjs --dry-run                # 只打印计划（= npm run bootstrap:check）
node scripts/bootstrap.mjs                          # 问一句再动手（= npm run bootstrap）
node scripts/bootstrap.mjs --yes                    # 非交互（.bat 用的就是它）
node scripts/bootstrap.mjs --no-install             # 依赖我自己装
node scripts/bootstrap.mjs --skip-dsh --skip-acl    # 这两步先别碰
node scripts/bootstrap.mjs --registry=https://registry.npmmirror.com
node scripts/bootstrap.mjs --json                   # 机器可读（适合 CI）
```

它**不会**做的事（有意为之）：

- 不替你装 Node / DSH / SnowLuma —— 这三个是环境前提，装错版本比不装更麻烦；
- 不猜你的 QQ 号与群号（白名单为空 = 谁都不理，这是设计）；
- 不动已有的 `config.json` / `state/` 内容。

> 日志写在 `state/bootstrap.log`，出问题把它一起发出来。
> 它跑完后仍建议按下面 §1 起把 SnowLuma 装好，然后再双击一次让它把端口写进配置。

---

## 0.1 手动走一遍：开始前，先确认这四样

打开 PowerShell（开始菜单搜 `pwsh` 或 `powershell`），逐条粘贴：

```powershell
node -v          # 需要 >= v22.13.0；报「不是内部或外部命令」也能继续，见下面的回退
git --version    # 需要能输出 git version 2.x
```

> 只装了 DSH、没单独装 Node 也没关系：`首次启动.bat` / `start.bat` / `配置.bat` 和 `bootstrap.mjs`
> 都会自动回退到 DSH 自带的那份 node（`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`），
> 装依赖也走 DSH 自带的 pnpm。这条回退只认「DSH 桌面版至少打开过一次」——它启动时才会把运行时放到位。

再看两样：

| 需要 | 怎么确认 |
| --- | --- |
| **Windows 10/11** | 设置 → 系统 → 关于 |
| **DeepSeek Harness（DSH）** | 能打开 DSH 的 Web 界面；版本需 **0.2.1-rc.2 或更新（rc.3 已能安装，功能未完整回归）** |

少哪个装哪个：

- Node：<https://nodejs.org/> 下 **LTS**（≥22.13），装完**重开终端**再 `node -v`；
- DSH：按你拿到的方式安装，能进 Web GUI 就行；
- SnowLuma：见第 2 步。

> ⚠️ 不要把 git 链接直接丢给 DSH。原因见 [§10 为什么不支持](#10-为什么不能把-git-链接丢给-dsh)。

---

## 1. 装 SnowLuma（收 QQ 必需）

SnowLuma 是第三方的 QQ 运行时，**本项目不打包、不代装**（EULA §5.4），你自己下：

1. 打开 <https://github.com/SnowLuma/SnowLuma/releases/latest>；
2. 下载最新的 Windows 压缩包，解压到一个**路径里没有中文和空格**的目录（例如 `C:\Apps\SnowLuma`）；
3. 运行里面的启动程序，**用你的 QQ 扫码登录**（建议先用小号）；
4. 登录后打开它的 **OneBot v11** 设置，记下三样东西：

| 要记的 | 默认值 | 在哪看 |
| --- | --- | --- |
| HTTP 端口 | `3000` | OneBot / 接口设置 |
| WebSocket 端口 | `3001` | 同上 |
| access token | 可能为空 | 同上（如果有，一定要记下来） |

> 端口被占用时 SnowLuma 会自动换端口，**以它界面上显示的为准**。

> 注入失败（`connect ETIMEDOUT \.\pipe\mojo.…`）、检测不到、控制台连不上、
> 「有正在进行的任务不让关」等，见 [SnowLuma 排错](SNOWLUMA_TROUBLESHOOT.md)。

---

## 2. 拿到 Stellar

```powershell
cd D:\
git clone <你的 GitHub 仓库地址>.git
cd stellar
npm install          # 没有 npm（只装了 DSH）就直接跑 node scripts/bootstrap.mjs，它会用 DSH 自带的 pnpm
```

`npm install` 会顺带跑一个补丁脚本（修 `@snowluma/sdk` 的 ESM 问题），看到 `postinstall` 相关的输出是正常的。

> 别下 ZIP 包：ZIP 没有 `.git`，以后"检查更新"会显示不可用。

---

## 3. 生成配置

### 3.0 方式一：双击 `配置.bat`（推荐）

仓库根目录的 `配置.bat` 会开一个本地配置页面（只监听 `127.0.0.1`，带一次性令牌，关掉窗口就失效），
表单里填完点保存就行：

```text
配置.bat                      打开配置页面
配置.bat --config=C:\cfg\config.json    打开并预先载入指定文件
配置.bat --port=4319 --no-open          固定端口、不自动开浏览器
```

几条它保证的事：

- **路径要你自己选。** 页面不扫盘、不猜你装在哪，用「浏览…」挑文件，或直接粘绝对路径。
- **只写表单里的键。** 保存时是「读旧文件 → 合并 → 写回」，你没碰过的 `pricing`、`social`、`allow` 之类的段落原样保留，不会被抹掉。
- **先校验再落盘。** QQ 号不是数字、端口越界、URL 少协议头这类问题会当场列出来，**一个字节都不写**。
- **改之前自动备份**，文件旁边多一份 `config.json.bak-20261114-005259` 这样的副本；内容和原来一样时不会写、也不会刷备份。
- 文件还不存在时，页面上有「按模板新建」按钮，等价于 `copy config.example.json config.json`。

它只改本地文件，不联网、不启动机器人。

### 3.1 方式二：手写 JSON

不想开页面的话，拷一份模板自己改：

```powershell
copy config.example.json config.json
```

然后用记事本 / VS Code 打开 `config.json`，**只改下面这 4 处**：

#### SnowLuma 连接

```jsonc
"snowluma": {
  "wsUrl": "ws://127.0.0.1:3001",       // 第 1 步记的 WS 端口
  "httpUrl": "http://127.0.0.1:3000",   // 第 1 步记的 HTTP 端口
  "accessToken": ""                      // 有就填，没有留空
}
```

#### 你是谁（管理员）

```jsonc
"ownerQQ": 1000000001                    // 换成你自己的 QQ 号（数字，不要引号）
```

#### 白名单（**最容易漏的一处**）

```jsonc
"allow": {
  "private": [1000000001],               // 允许私聊她的 QQ 号
  "groups":  [100000004]                 // 允许她出现的群号
}
```

> **白名单为空 = 谁都不理**。这不是"全放行"，是"谁都不放行"。第一次装最容易卡在这。

#### 控制台令牌

```jsonc
"consoleToken": ""                       // 留空会自动生成，存在 state/console-token
```

改完保存。**`config.json` 不会被更新覆盖**（它不在 git 里），放心填。

---

## 4. 装进 DSH

> 这一步 `首次启动.bat` / `node scripts/bootstrap.mjs` 都会替你做；手动走的话就是下面这一条。

```powershell
node scripts/setup-dsh.mjs
```

> 不用填 profile：脚本会自己判断（`DSH_PROFILE` → 正在运行的 DSH 进程 → 最近使用过的那套）。
> 想强制指定就加参数：`node scripts/setup-dsh.mjs desktop`。

它做三件事（可重复跑，幂等）：

1. 往 DSH profile 里插 `qq-chat` / `qq-chat-v2` 两条 agent preset；
2. 在 `cordis.patch.yml` 挂三个 MCP server（QQ 工具 / SnowLuma 探活 / 只读搜索）；
3. 在 profile 的 `package.json` 注册 `stellar` bundle。

装到别的 profile：

```powershell
node scripts/setup-dsh.mjs desktop
```

**然后重启 DSH**（不是刷新页面，是退出重开）。

---

## 5. 启动，让它跑起来

重启 DSH 后：**设置 → Stellar → 概览 → 点「启动QQ」**。

或者命令行（`npm start` 与下面这条等价；没有 npm 就用后者）：

```powershell
npm start
node src/bridge.js
```

看到控制台打印 `[bridge] OneBot 已连接` 就说明连上了 SnowLuma。

---

## 6. 第一次验证（三件事）

1. **群里 @ 她** → 她回一句；
2. **DSH 里出现对应会话** → 说明 prompt 投递成功；
3. 打开控制台 → <http://127.0.0.1:3100/>，用 `?token=你的令牌` 进：

```
http://127.0.0.1:3100/?token=<consoleToken>
```

令牌在哪：`state/console-token` 文件，或设置页「概览」。

> 三件事任一没成，去 [§9](#9-出错怎么办)。

---

## 7. 可选组件

装到第 6 节就已经能用了，没有额外必装组件。唯一的可选件是**向量记忆的索引包**，
只在你想把记忆切到向量检索时才需要，见 [features/EMBEDDING_PACKS.md](../features/EMBEDDING_PACKS.md)。

---

## 8. 升级

**设置 → Stellar → 概览 → 更新 → 检查更新**。

- 本体走 git：只做 `--ff-only` 快进，**绝不覆盖你的 `config.json` / `state/`**；
- `updates.components[]` 里登记的其他组件按各自来源更新（git / release zip + sha256）；
- 有本地未提交改动时会**拒绝更新**并说明原因，不会强行合并。

> 什么时候会被拒：你改过仓库里**被跟踪**的文件（例如 `config.example.json`、`roles/*.md`）。
> 角色卡请放 `~/.dsh/stellar/characters/`（设置页「角色」里新建），不要改仓库里的示例文件。

---

## 9. 出错怎么办

| 症状 | 原因 | 解决 |
| --- | --- | --- |
| 设置页没有 Stellar | 没装进 DSH / 没重启 | 重跑 `node scripts/setup-dsh.mjs`，**完全退出 DSH 再开** |
| 桥接起来了，但收不到消息 | SnowLuma 没登录 / token 不对 / 端口不对 | 看控制台「运行总览」；核对 `snowluma.*` 与 SnowLuma 界面上的端口 |
| 群里 @ 她没反应 | 白名单没加群 / 已暂停 / 模式不对 | 设置 → QQ → 白名单；控制台确认没暂停 |
| 她只会聊天，不调工具 | MCP 没挂上 / 工具被安全守卫限制 | 重跑 setup；看设置页工具开关 |
| 控制台 401 | 没带 token | 地址后面加 `?token=…` |
| `npm install` 后启动报 ESM 错 | postinstall 没跑完 | `npm rebuild`，或手动 `node scripts/patch-snowluma-sdk.mjs` |
| 双击 `首次启动.bat` 一闪就没了 | 没装 Node / 版本太旧 | 那个窗口会停住并提示；实在看不到就开 PowerShell 跑 `node scripts/bootstrap.mjs` |
| 想确认它到底会改什么 | — | `npm run bootstrap:check`（只打印计划，不落盘） |
| 更新一直说"本地有改动" | 改过被跟踪的文件 | `git status` 看是哪个；恢复或改成放 `~/.dsh` 里 |

还不行，先点设置页的 **诊断 → 环境体检**（9 项检查，每项都有"怎么补"），
能自动补齐的缺项点 **一键配置**（只补缺的，不覆盖已有值）。

命令行体检：

```powershell
node scripts/verify-dsh-020-adaptation.mjs
npm run test:audit
```

---

## 10. 为什么不能把 git 链接丢给 DSH

DSH 能装"纯前端插件/技能"，但 Stellar 不是那种东西：

| 它需要 | DSH 直接装链接做不到 |
| --- | --- |
| `npm install`（含 postinstall 补丁） | 需要在本机跑一遍依赖安装 |
| 一个**独立进程**（`src/bridge.js`） | 需要能起子进程、写 pid、单实例锁 |
| 往 profile 写 **preset + MCP + bundle** | 需要跑 `setup-dsh.mjs` |
| 一份**要你填的配置** | 链接里没有你的 QQ 号/白名单/端口 |
| SnowLuma 扫码 | 只能你自己扫 |

所以它走的是"**克隆 → 安装 → 配置 → 装进 DSH**"这四步，不是"点一下装好"。

未来会做：把它打成 npm 包 + DSH bundle，让 `dsh plugin add stellar` 一条命令搞定；在那之前，按本文档走。

---

## 11. 安全须知（三句话）

1. **白名单只加你要的群**，别图省事全放行；
2. **`config.json` 里有你的令牌**，别截图、别提交、别发给别人；
3. **先小号试**：确认她说话方式你满意，再放进主群。
