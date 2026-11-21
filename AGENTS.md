# AGENTS.md — 在这个仓库干活前先读这篇

> DSH 会把本文件自动注入本工作区的每个会话。**别在这里写人设或业务规则**（那些在 `roles/`、`RULES.md`）；
> 这里只写「怎么在这个仓库干活，才不会把东西干坏」。
> 文档索引：[`docs/README.md`](docs/README.md)；使用规则：[`RULES.md`](RULES.md)；发布流程：[`docs/RELEASE.md`](docs/RELEASE.md)。

## 0. 每次开工的固定动作

1. 读 [`docs/guides/architecture/ARCHITECTURE.md`](docs/guides/architecture/ARCHITECTURE.md)：进程拓扑、数据流、改什么要重启什么。
2. 跑 `git status --porcelain` 和 `git log --oneline -5`，确认工作区干净、最近提交是什么。
3. 带着具体问题查对应文档（目录见 [`docs/README.md`](docs/README.md)，路径见 [`docs/FOLDER_MAP.md`](docs/FOLDER_MAP.md)）。
4. 最后再读代码。**别相信会话记忆，相信文件**：半天前的「我记得改过」通常是错的。

## 1. 十条铁律（违反任何一条都算事故）

1. **先分析，再动手**：写清「现象 → 根因 → 影响面 → 修法 → 怎么验证」。分析没到能预判失败点，就只做只读排查。
2. **先算收益再选路线**：至少比较 2 条（收益/成本/风险/回滚难度）。**收益不佳就回退换路线**，别因为「已经写了这么多」硬撑。
3. **不补屎山**：宁可回退重写 30 行，也不在错地基上叠 300 行补丁。判断标准：新代码让「下一次改动」更容易了吗？没有就别合。
4. **不盲目跑探针**：`scripts/setup-dsh.mjs`、`首次启动.bat`、任何会启动服务 / 发 QQ 消息 / 写 `~/.dsh` 的脚本，先说明目的、预期输出、失败后果，再跑；跑完先看日志再下结论。
5. **改完必测**：至少 `node scripts/test-audit.mjs`；碰桥接或协议加 `npm run test:regressions`；碰插件跑对应 `plugins/stellar/scripts/test-*.mjs`。
6. **删改必隔离**：任何删除 / 覆盖前先备份，或改名为 `*.bak-<时间戳>`。**禁止**对配置 / 会话 / 记忆库做不可逆删除。
7. **密钥红线**：`config.json`、`state/`、`~/.dsh` 里的 token 不进代码、不进日志、不进回复；输出前脱敏。
8. **文档同步**：改了行为就改文档；改了机制就把「为什么」写进对应文档，别只改代码。
9. **小步提交**：一次一件事；提交信息写「现象 + 修法」，别写 update / fix。
10. **不确定就问**：涉及删除、发布、对外发送、改用户数据时停下来问用户，不要「先做了再说」。

## 1.5 讲透逻辑

每次修 bug / 加功能，交付说明都要写清**彻底的逻辑**，不能只报「改好了」：

1. **链路**：这段代码在哪个进程/文件，上游从哪来、下游到哪去；还有谁读这个文件/接口（`grep`，不凭记忆）。
2. **机制**：为什么会这样——契约、时序、所有权、编码层面的原因，不是「哪行写错了」。
3. **爆炸半径**：进程数 × 读者数 ×（静默=3 / 报错=1）；是否碰用户数据、密钥、花钱。
4. **取舍**：至少两条备选路线，为什么选这条（收益 / 成本 / 风险 / 回滚）。
5. **生效与重启**：谁读这个文件、要重启哪个进程（见 §4）。
6. **验证**：命令 + 预期输出，不能只写「应该没问题」。
7. **回滚与残余**：怎么退回去、还有什么没验证。

## 1.6 失败必须可见且可行动

**不容忍静默错误**：每次修 bug / 加功能，失败路径和成功路径一样是交付物。

1. **看得见**：失败要出现在用户当前界面（弹窗 / 红字 / 状态点 / toast 至少其一）；只写日志 = 没做。
2. **给下一步**：错误文案说清「在哪失败 + 现在该点什么」；能自动恢复的给重试按钮。
3. **接口结构化**：`ok:false` 同时带 `code`（机器读）、`error`（人读）、`hint`（下一步）。
4. **前端不许吞**：收到 `ok:false` 必须展示，不得只 `console.log`。
5. **失败有测试**：新增失败路径至少一条断言钉住 `code` 与 `hint` 非空。

判据、弹窗/toast 选择、禁止清单见 [`docs/guides/development/ERROR-REPORTING.md`](docs/guides/development/ERROR-REPORTING.md)。

## 1.7 发布纪律：三条门禁，缺一条就不许发

本仓库发布的版本号写在 `package.json`，安装清单必须与仓库文件逐字节一致。以下刚性步骤按顺序跑完才算发布完成；任何一条没过就停手。

1. **清单从 git 对象生成，不是工作区**

   ```bash
   git status --porcelain                       # 必须干净
   node scripts/release-manifest.mjs            # 内容取自 HEAD 的 blob，不受 CRLF 影响
   git add release/install-manifest.json
   git commit -m "release: 重新生成安装清单"
   node scripts/release-manifest.mjs --verify-ref HEAD   # 必须「问题 0 个」
   ```

   **顺序不能反**：先生成清单再提交，提交前跑 `--verify-ref HEAD` 一定假红（那一刻 HEAD 里还是旧清单）。
2. **发布走 git 对象，不是工作区文件**
   远端拿到的必须是 commit 里的字节。`.gitattributes` 把 `*.bat` / `*.cmd` / `*.ps1` 标成 `-text`，避免 CRLF 被转换后哈希对不上。
3. **发完必须核对真实制品**

   ```bash
   node scripts/release-manifest.mjs --verify <解压目录>   # 必须「不符 0 / 缺失 0」
   node scripts/privacy-scan.mjs --strict                  # 必须无敏感信息
   ```

## 1.8 同一时间只有一个会话写代码

**同一个工作区，同一时间只允许一个会话改文件。** 第二个会话请先复制一份目录或用 `git worktree add`。

- 开工前先跑 `git status --porcelain`；**工作区里的脏文件不全是你的 → 停手**。
- **禁止 `git add -A` / `git add .` / `git commit -a`**；只 add 自己改过的明确路径。
- 提交前核对 `git diff --cached --stat`；出现不是自己的文件 → `git restore --staged <file>`。
- 禁止在别人可能正在写时执行 `git switch` / `checkout` / `reset` / `stash` / `clean`。
- **运行时也串行**：桥接重启、B站 tick、发布，同一时间只允许一个会话做。

## 2. 环境事实

- DSH 数据目录 `~/.dsh`；插件数据在 `~/.dsh/stellar/`。
- Web GUI / 网关：**端口会漂移**（DSH 桌面端每次启动挑空闲回环端口）。用 `discoverDshBaseUrl()` 或 `state/dsh-port.json`，**别硬编码**。
- 桥接控制台：`http://127.0.0.1:3100`（需要 `consoleToken`）；面板：`http://127.0.0.1:3300`（**本机也要登录**：带 `?code=<panel-token.txt 里那串>` 打开一次换 Cookie，之后 30 天免输入；局域网 / 隧道另需口令）。
- SnowLuma：第三方专有运行时，**不随仓库分发、不打包**；本程序只探测、不部署（EULA §5.4）。
- 会话日志：`~/.dsh/sessions/<项目目录>/session-<id>/session.v4.jsonl.zstd`，zstd 压缩，别当文本读。
- 记忆库：`~/.dsh/stellar/characters/<角色>/memory/memory.db`（SQLite，schema_version 4）。

## 3. 交付定义（Done 的标准）

代码 + 测试通过 + 文档更新 + 回滚路径 + 一句话「怎么验证」+ **给用户的完整逻辑说明（按 §1.5 七步）**
+ **失败路径的可见报告与建议（§1.6，含失败分支测试）**。缺一项都不算完成。

## 4. 改动生效层级

| 改了什么 | 怎么生效 |
| --- | --- |
| `src/bridge.js`、`plugins/stellar/lib/scheduler.js` | 重启桥接（`restart.bat`，或杀掉进程让守护拉起） |
| `plugins/stellar/**`、`src/mcp-*.js`、`dsh/agent-presets/**` | 必须重启 DSH（会关掉当前 GUI 窗口）；改 preset 源 YAML 后**先**跑 `node scripts/build-agent-preset-patches.mjs` |
| `roles/*.md`、`config.json`、`~/.dsh/stellar/config.json` | 插件即时读取，无需重启 |
| `stellar-manager/**` | 重启面板 |
| `docs/**`、`*.md` | 不用重启；若改了正文请重生成安装清单 |
