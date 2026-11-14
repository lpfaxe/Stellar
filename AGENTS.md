# AGENTS.md — 在这个仓库干活前先读这篇

> DSH 会把本文件自动注入本工作区的每个会话。**别在这里写人设或业务规则**（那些在 `roles/`、`RULES.md`）；
> 这里只写「怎么在这个仓库干活，才不会把东西干坏」。
> 文档索引：[`docs/README.md`](docs/README.md)；使用规则：[`RULES.md`](RULES.md)。

## 0. 每次开工的固定动作

1. 读 [`docs/guides/architecture/ARCHITECTURE.md`](docs/guides/architecture/ARCHITECTURE.md) 的拓扑与数据流部分，确认你要碰的进程/文件在哪。
2. 跑 `git status --porcelain` 和 `git log --oneline -5`，确认工作区干净、最近提交是什么。
3. 带着具体问题查对应模块文档（`docs/guides/architecture/MODULE-*.md`、`docs/guides/subsystems/SUBSYSTEM-*.md`）。
4. 最后再读代码。**别相信会话记忆，相信文件**：半天前的「我记得改过」通常是错的。

## 1. 十条铁律（违反任何一条都算事故）

1. **先分析，再动手**：写清「现象 → 根因 → 影响面 → 修法 → 怎么验证」。分析没到能预判失败点，就只做只读排查。
2. **先算收益再选路线**：至少比较 2 条（收益/成本/风险/回滚难度）。**收益不佳就回退换路线**，别因为「已经写了这么多」硬撑。
3. **不补屎山**：宁可回退重写 30 行，也不在错地基上叠 300 行补丁。判断标准：新代码让「下一次改动」更容易了吗？没有就别合。
4. **不盲目跑探针**：`setup-dsh.mjs`、`start*.bat`、任何会启动服务/发 QQ 消息/写 `~/.dsh` 的脚本，先说明目的、预期输出、失败后果，再跑；跑完先看日志再下结论。
5. **改完必测**：至少 `npm run test:audit`；碰协议/桥接加 `npm run test:regressions`；碰插件跑对应 `plugins/stellar/scripts/test-*.mjs`。
6. **删改必隔离**：任何删除/覆盖前先备份或 rename 到 `_backups/`。**禁止**对配置/会话/工作区做不可逆删除。
7. **密钥红线**：`config.json`、`state/`、`~/.dsh` 里的 token 不进代码、不进日志、不进回复；输出前脱敏（`********`）。
8. **文档同步**：改了行为就改文档；改了模块细节就把「为什么」写进对应 `docs/guides/architecture/MODULE-*.md`。
9. **小步提交**：一次一件事；提交信息写「现象 + 修法」，别写 update/fix。
10. **不确定就问**：涉及删除、发布、对外发送、改用户数据时停下来问用户，不要「先做了再说」。

## 1.5 发布与编辑分开 + dev/main 双分支

**版本号与发布只能在一个「发布会话」里做**；其它会话只管改代码。代码与发布之间隔一层 `dev`：

- **`dev`（集货区）**：所有日常修复/功能/文档提交到这里；可以随时 commit；**不改 `package.json` 的 version、不打 tag、不发 Release、不推公开仓库**。
- **`main`（稳定线）**：只放「已发布」的状态。只允许两种提交：发布会话从 `dev` 合并（`git merge --no-ff dev`）后做 release commit；热修从 `main` 切 `hotfix/*`，修完立即 patch，再回并 `dev`。
- **发布会话流程**：`git checkout main` → 合并 dev → **现读** `git status/log/package.json` → 跑三条门禁（见 §1.8）→ bump/commit/tag/Release → **把 main 合回 dev**。
- **公开仓库/镜像只同步 `main`**：zip 用户不会拿到半成品。
- **任何发布前必须先问用户**：把「版本号 / 改了什么 / 影响谁 / 验证结果」列出来，等用户明确说「发」再执行。
- 两边不要同时跑 `git` 写操作（会撞 `index.lock`）。

完整流程见 [`docs/RELEASE.md`](docs/RELEASE.md)。

## 1.6 讲透逻辑

用户明确要求：每次修 bug / 加功能，都要让他看到**彻底的逻辑**，不能只报「改好了」。交付说明按这七步写：

1. **链路**：这段代码在哪个进程/文件，上游从哪来、下游到哪去；还有谁读这个文件/接口（`grep`，不凭记忆）。
2. **机制**：为什么会这样——契约、时序、所有权、编码层面的原因，不是「哪行写错了」。
3. **爆炸半径**：进程数 × 读者数 ×（静默=3/报错=1）；是否碰用户数据、密钥、花钱。
4. **取舍**：至少两条备选路线，为什么选这条（收益/成本/风险/回滚）。
5. **生效与重启**：谁读这个文件、要重启哪个进程。
6. **验证**：命令 + 预期输出，不能只写「应该没问题」。
7. **回滚与残余**：怎么退回去、还有什么没验证。

术语与判据见 [`docs/guides/architecture/12-LESSONS-ARCHITECTURE.md`](docs/guides/architecture/12-LESSONS-ARCHITECTURE.md)。

## 1.7 失败必须可见且可行动

**不容忍静默错误**：每次修 bug / 加功能，失败路径和成功路径一样是交付物。

1. **看得见**：失败要出现在用户当前界面（弹窗 / 红字 / 状态点 / toast 至少其一）；只写日志 = 没做。
2. **给下一步**：错误文案说清「在哪失败 + 现在该点什么」；能自动恢复的给重试按钮。
3. **接口结构化**：`ok:false` 同时带 `code`（机器读）、`error`（人读）、`hint`（下一步）。
4. **前端不许吞**：收到 `ok:false` 必须展示，不得只 `console.log`。
5. **失败有测试**：新增失败路径至少一条断言钉住 `code` 与 `hint` 非空。

判据、弹窗/toast 选择、禁止清单见 [`docs/guides/development/ERROR-REPORTING.md`](docs/guides/development/ERROR-REPORTING.md)。

## 1.8 发布纪律：三条门禁，缺一条就不许发

历史上出过「发布物与校验清单不同源」的事故，导致客户端校验失败、自动更新 100% 不可用。以下刚性步骤按顺序跑完才算发布完成；任何一条没过就停手。

1. **清单从 git 对象生成，不是工作区**
   ```bash
   git status --porcelain                                # 必须干净
   node scripts/release-manifest.mjs                     # 内容取自 HEAD 的 blob，不受 CRLF 影响
   node scripts/release-manifest.mjs --verify-ref HEAD   # 必须「问题 0 个」
   ```
2. **发布走 git 对象，不是工作区文件**
   发布脚本必须是 `git show HEAD:<path>` 取内容（`scripts/publish-via-api.mjs` 已如此）；
   **禁止**把工作区字节直接 POST 给 GitHub —— 否则远端存 CRLF，客户端按 LF 校验必然失败。
3. **发完必须核对真实制品**
   ```bash
   curl -sL -o a.zip https://codeload.github.com/<owner>/<repo>/zip/refs/tags/vX.Y.Z
   node scripts/release-manifest.mjs --verify <解压目录>   # 必须「不符 0 / 缺失 0」
   ```
   codeload 不可达时用备用通道：`GH_TOKEN=... node scripts/verify-remote-manifest.mjs <owner>/<repo> vX.Y.Z`（必须「不符 0 / 缺失 0」）。

**给未来的我**：用户反馈「点了更新版本不变」时，先看 `lastApplyFailure.code`：
`verify.staging-mismatch` → 发布侧问题，别让用户重试；`evidence-insufficient` → 缺安装证据，检查 `.installed-manifest.json`；`download.*` → 网络/镜像问题。

## 1.9 多会话协作：一会话一工作树

**同一个工作区，同一时间只允许一个会话写代码。** 第二个及以后的会话必须开独立工作树 + 独立分支。

- 开工前先跑：`git status --porcelain`、`git worktree list`、`git log --oneline -5`；**工作区里的脏文件不全是你的 → 停手**。
- 新会话一律：`git worktree add ..\stellar-<topic> -b feat/<topic> dev`，之后只在那个目录改。
- **禁止 `git add -A` / `git add .` / `git commit -a`**；只 add 自己负责的明确路径。
- 提交前核对 `git diff --cached --stat`；出现不是自己的文件 → `git restore --staged <file>`。
- 禁止在别人可能正在写时执行 `git switch/checkout/reset/stash/clean`。
- **运行时也串行**：QQ 桥接 / DSH 重启、B站 tick、发布，同一时间只允许一个会话做。

完整操作手册：[docs/guides/development/MULTI-SESSION-WORKFLOW.md](docs/guides/development/MULTI-SESSION-WORKFLOW.md)。

## 2. 环境事实

- DSH 数据目录 `~/.dsh`；插件数据在 `~/.dsh/stellar/`。
- Web GUI / 网关：**端口会漂移**。用 `discoverDshBaseUrl()` 或 `state/dsh-port.json`，**别硬编码**。
- 桥接控制台：`http://127.0.0.1:3100`（需要令牌；`consoleToken`）。
- SnowLuma：第三方专有运行时，**不随仓库分发、不打包**；本程序只探测、不部署（EULA §5.4）。
- 会话日志：`~/.dsh/sessions/<项目目录>/session-<id>/session.v4.jsonl.zstd`，zstd 压缩，别当文本读。

## 3. 交付定义（Done 的标准）

代码 + 测试通过 + 文档更新 + 回滚路径 + 一句话「怎么验证」+ **给用户的完整逻辑说明（按 1.6 七步）**
+ **失败路径的可见报告与建议（1.7，含失败分支测试）**。缺一项都不算完成。

## 4. 改动生效层级

| 改了什么 | 怎么生效 |
| --- | --- |
| `src/bridge.js` | 重启桥接进程（`stop.bat` → `start.bat`） |
| `plugins/stellar/**`、`src/mcp-*.js` | 必须重启 DSH（会关掉当前 GUI 窗口） |
| `roles/*.md`、`config.json` | 插件即时读取，无需重启 |
| `dsh/agent-presets/**` | 重跑 `node scripts/setup-dsh.mjs` 后重启 DSH |
