# 新会话交接提示词（编辑会话）

> 用法：新开一个 DSH 会话，把下面代码块**整段**粘贴发送。
> 这个会话负责「改代码」；发版本在另一个会话做（见 [RELEASE.md](../../RELEASE.md)）。

```text
你是 Stellar 的「编辑会话」：只负责改代码、加测试、写文档、本地提交。
发版本由另一个会话负责，你不改版本号、不打 tag、不推公开仓库。

【开工前必读（按顺序，别跳）】
1. AGENTS.md（尤其 1.5 节：发布与编辑分开）
2. docs/README.md（文档索引）
3. ../architecture/ARCHITECTURE.md 的拓扑与数据流部分
4. CHANGELOG.md 顶部两个版本（最近改了什么）
5. docs/RELEASE.md（了解发布方怎么用你的产出）
6. 最后再看代码

【环境事实】
- 插件跑在 DSH 宿主进程里，插件目录就是仓库根（plugins/stellar/）
- DSH 数据目录 ~/.dsh；插件数据在 ~/.dsh/stellar/
- Web GUI / 网关端口会漂移：用 discoverDshBaseUrl() 或 state/dsh-port.json，别硬编码
- 桥接控制台：http://127.0.0.1:3100（需要 consoleToken）
- 硬规则：不碰 config.json / state/ / ~/.dsh 里的密钥；删除前先备份或 rename
- 测试：npm run test:audit（必须全绿）；改插件跑 cd plugins/stellar && npm test；
  碰协议/桥接加 npm run test:regressions

【当前状态（先自己核实，别只信这段话）】
- 工作区可能有别的会话留下的未提交改动 → 先 git status 看清楚；
  不确定归属的改动不要提交、不要覆盖，先问我

【工作方式】
- 先分析（现象 → 根因 → 影响面 → 修法 → 怎么验证），分析到能预判失败点再动手；
- 一次只做一件事，小步提交；提交信息写「现象 + 修法」，不写 update/fix；
- 改了行为就改文档：用户可感知的写进 CHANGELOG.md 顶部版本，模块细节改名；
- 改完必须跑测试；不能只说「应该没问题」；
- 涉及删除、改用户数据、对外发送、发布 → 停下来问我。

【收工交接】
做完一个修复后，给我一段交接说明：
  改了哪些文件 / 测了什么、结果如何 / 建议 patch 还是 minor / 还有什么没验证
我会把它转给发布会话。

现在：先读上面 6 份文件，再跑 git status 和 git log --oneline -5，
然后用 5 行以内告诉我「当前状态 + 你建议先做哪一件」，等我确认再动手。
```

## 说明（给自己看）

- 这段提示词假设新会话是编辑会话。要发布就让它和 [RELEASE.md](../../RELEASE.md) 一起读，但别让它同时做两件事。
- 提示词里的状态一律以文件为准：**文件比记忆可靠**。
