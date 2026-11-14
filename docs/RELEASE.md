# 发布流程（RELEASE）

> 本文件描述**这个仓库**怎么发版。任何会话发布前都要重读这里 + 现读仓库状态，不要凭记忆。
> 仓库只有一个长期分支 `main`，发布就是往 `main` 推一个「清单与文件逐字节一致」的提交。

## 一、发布到底是什么

用户拿到仓库后，`release/install-manifest.json` 是他校验本地文件有没有被改坏的唯一依据：
清单里每个路径都对着一个 sha256。所以一次发布 = **代码提交 + 清单提交**，两件事分开做、顺序固定。

```
① git commit 代码/文档改动
② node scripts/release-manifest.mjs        # 按 HEAD 的 blob 生成清单
③ git add release/install-manifest.json && git commit
④ git push
```

**顺序反了一定假红**：清单算的是 HEAD 里的字节，你还没提交新代码就校验，当然对不上。

## 二、三条门禁（缺一条就不许推）

| # | 门禁 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 全部测试 | `node scripts/test-audit.mjs` | `Audit suite: 159/159` |
| 2 | 清单与 HEAD 逐字节一致 | `node scripts/release-manifest.mjs --verify-ref HEAD` | `问题 0 个` |
| 3 | 没有隐私与凭据 | `node scripts/privacy-scan.mjs --strict` | 「未发现敏感信息」 |

推完再核对一次线上：`node scripts/release-manifest.mjs --verify-ref origin/main` 必须同样是「问题 0 个」。

## 三、版本号

版本号在 `package.json` 与 `CHANGELOG.md` 两处，改法：

```bash
node scripts/version.mjs bump patch     # 或 minor / major
node scripts/version.mjs check          # 复核三处是否一致
```

| 改了什么 | 升哪一位 |
| --- | --- |
| 修 bug、改文案、补文档 | patch |
| 加功能、加工具、加配置项（旧配置仍能读） | minor |
| 改了配置格式 / 协议 / 目录结构，旧数据要迁移 | major |

CHANGELOG 只写`## [x.y.z] - YYYY-MM-DD` 一个新段，分「新增 / 修复 / 变更」三节；历史段不要无限增长。

## 四、推之前自己问四个问题

1. **`git status --porcelain` 干净吗？** 有脏文件先确认是不是自己改的。
2. **`git ls-files` 里有没有不该进仓库的东西？** 特别看 `config.json`（在 `.gitignore` 里）、`state/`、`node_modules/`、任何 `*.log`。
3. **新增的图片/文档带没带本机信息？** 截图里出现真实 QQ 号、群名、路径都不行；`privacy-scan --strict` 会查，但它只认规则表。
4. **`.gitattributes` 有没有漏？** `*.bat` / `*.cmd` / `*.ps1` 必须是 `-text`，否则换行被转换后哈希对不上。

## 五、发布后

- 在 GitHub 上打 tag：`git tag -a vX.Y.Z -m "Stellar vX.Y.Z" && git push origin vX.Y.Z`；
- Release 的标题只写 `Stellar vX.Y.Z`，不要塞功能清单——那些写在 body 与 CHANGELOG 里；
- 用 GitHub 的「Download ZIP」下一个包，解压后跑 `node scripts/release-manifest.mjs --verify <解压目录>`，必须「不符 0 / 缺失 0」。

## 六、出错怎么回滚

| 情况 | 处理 |
| --- | --- |
| 提交了但没推 | `git reset --hard HEAD~1`，改完重来 |
| 已推送，清单对不上 | 补一个提交只改清单（不要 force push 改写历史） |
| 推错了 tag | 删远端 tag（`git push origin :refs/tags/vX.Y.Z`）后重打；Release 删掉重建 |
| 用户升级后坏了 | 让用户回退到上一版 zip；定位后发 patch，**不要改写已发布 tag** |

## 七、已知坑

1. **中文路径**：`git` 默认转义非 ASCII 路径，脚本要 `-c core.quotePath=false` 才能正确读文件名。
2. **清单与工作区**：`release-manifest.mjs` 读的是 git 对象，所以工作区脏着也能生成——但那不是你想要的清单，先提交再生成。
3. **本机没装 git**：`release-manifest.mjs` 的 git 模式会失败并回退到 worktree 模式（`source=worktree`），这种清单**不能**用于发布。
4. **不要用 `git add -A`**：运行时会往 `state/` 写东西，`add -A` 有可能把临时文件带进去。只 add 明确的路径。
5. **`npm publish` 不适用**：这是 `private: true` 的仓库，只走 GitHub。

## 八、发布记录

| 版本 | 日期 | 提交 | 说明 |
| --- | --- | --- | --- |
| 1.0.0 | 2026-11-14 | `main` | 首个公开版本：QQ × B站 × QQ空间，记忆库重建，完整面板随仓库发布 |
