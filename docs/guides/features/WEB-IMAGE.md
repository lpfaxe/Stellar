# 找图准确性（`stellar_web_image`）

> 2026-11-27 新增。`stellar_web_image` 从「Bing 搜图 + 按网页顺序下载」改成三条路：
> 中文优先百度、结构式走 PubChem、药品包装用 OCR 硬校验。工具名与调用方式不变，
> 只是多了 `mode` 和 `chemical` 两个参数。

## 1. 三种模式

| 模式 | 用途 | 走哪条路 | 判据 |
| --- | --- | --- | --- |
| `photo` / `auto` | 风景、人物、物品、插画参考 | 中文百度 / 英文 Bing，按标题、来源、真实像素排序 | 最短边 ≥500px、12KB–12MB、比例 0.3–3.4；只返回前几张并附图 |
| `structure` | 化学结构式 | PubChem 按 SMILES / CAS / 英文名查 CID，下载 1000×1000 PNG | CID 必须解析成功；中文名查不到就要求 CAS/英文名，不猜 |
| `product` | 药品/试剂包装、实物 | 拼「通用名 + 商品名 + 规格 + 厂家」再搜；来源页优先厂家/监管库 | OCR 同时命中「药品名」和「规格」才算 `[已核对]`；否则 `[候选]` |

`mode` 省略时按 `auto` 处理。结构式不要用 `image_generate` 重画——生成模型会改双键位置、
漏原子、把取代基画到错误位置；宁可返回 `NEED_IDENTIFIER` 让主人补 CAS。

普通图/包装图如果关键词搜出来的前几张不准，用下面第 5 节的**预加载两阶段**：先看联系表，
再 `pick` 1–5 张落盘；预加载不占每天 30 张。

## 2. 为什么中文先走百度

2026-11-27 实测 Bing 的 `images/async`：查「雪山 小镇 风景」返回京剧、医院、抗日英雄；
查「雪山 小镇」返回神笔马良 PPT；但单字「雪山」和「cat」正常。**这不是解析 bug，是 Bing
对多词中文查询本身返回了错结果**。百度 `image.baidu.com/search/acjson` 对中文多词稳定，
且返回 `width/height` 真实尺寸与来源页。

分工：含中文 → 先百度，空结果再退 Bing；纯英文/数字 → 先 Bing，空结果再退百度。
两个引擎都失败才返回 `NO_CANDIDATES`。

百度结果里 `replaceUrl[0].ObjURL` 是原图直链，优先用它；`middleURL/thumbURL` 只有约 500px，
当原图下载失败时再退。`objURL` 是加密串，不要用。

## 3. 结构式（PubChem）

- 查询顺序：SMILES → CAS → 英文名 → 中文别名表里的英文名/CAS。中文名不会直接发给 PubChem
  （实测「阿司匹林」404）。
- 本地别名表 `plugins/stellar/tools/lib/webimg/chem/aliases.mjs` 目前 133 条常用中文名，
  人工核对，覆盖无机/有机/药物常用名。别名表是**唯一**的中文→CAS/英文名入口。
- 下载：`/rest/pug/compound/cid/<CID>/PNG?record_type=2d&image_size=1000x1000`，白底、无字。
- 缓存：`~/.dsh/stellar/chem-images/cid-<CID>.png` + `.json`，30 天 / 最多 300 张；
  同一 CID 命中缓存不重复下载。缓存不占用每日 30 张普通图额度。
- 多个 CID 时返回候选列表（最多 8 个），默认用第一个；要精确指定就给 CAS 或 SMILES。

## 4. 药品包装的 OCR 校验

1. 查询拼上 `manufacturer/brand/strength/dosageForm`（例如「阿司匹林 拜耳 100mg 药盒」）。
2. 下载后先过 `acceptableImage`；再做 Windows OCR。
3. 规格匹配前把 OCR 文本里的 `O→0`、`I/l/|→1` 纠偏（只用于规格，不动药名，否则
   `aspirin` 的 i 会被换成 1）。800px 药盒小字常把 `100mg` 认成 `1 OOmg`，所以固定
   2 倍放大后再 OCR。
4. 药名和规格**同时**命中 → `[已核对]`；只命中一条 → `[候选：未通过包装文字校验]`，
   回复里必须说明「不是同款/请核对」，不能把候选说成找到了。
5. 没有厂家或规格时只给候选，不声称同款。

OCR 只看包装上的印刷字，不判断药片颜色/形状；同一种药不同规格的盒子可能长得很像。

## 5. 预加载两阶段（30–100 条候选 → 联系表 → pick）

普通图和药品包装在“标题看起来对、下下来却不对”时，用两阶段找图；结构式不需要（PubChem CID 已经确定）。

1. **预加载**：`stellar_web_image` 的 `action=search` 加 `preload: 100`（30–100）。
   - 候选数：`max(60, preload)` 条；百度最多 4 页（120 条），Bing 最多 5 页（100 条）。
   - 只下载 **24 张**（通用图/包装图同一上限），落到 `~/.dsh/stellar/webimg-preload/<session>/`。
   - 拼一张 4 列、每格 360×300 的 `sheet.jpg`，每格左上角是 `#01` 这种编号；同时返回标题、尺寸、字节数、来源页。
   - **这一步不写 `web-images`，不占每天 30 张。**
2. **挑图**：`action=pick`，带 `session` 和 `picks: [1,4,7]`（最多 5 张）。
   - 只有 pick 成功才调用 `addWebImage`，写进 `~/.dsh/stellar/web-images/<日期>/`，这时才消耗 30 张额度。
   - 存完删整个预加载会话；没被选中的临时图也一起删。
   - 编号必须是联系表上有的；越界返回 `BAD_PICKS`，过期返回 `PRELOAD_EXPIRED`，额度不足返回 `DAILY_LIMIT`。
3. **发送**：pick 返回的 `file` 是本地完整路径，直接交给 `qq_send_image`；别拿预加载临时路径发，pick 后会删。

CLI 对照：

```bash
node bili.mjs webimg search "雪山 小镇 风景" --preload 100 --json
node bili.mjs webimg pick --session p-20261127060226-4c872f --picks 1,14,23 --json
node bili.mjs webimg preload-status
```

成本口径：本地搜索、下载、拼联系表、OCR 都 **不花 token**；只有联系表图片和标题列表进入模型上下文才计费。
一次预加载大约多 3–6k token（一张联系表 + 24 行标题，视图片大小而定）；不要返回 100 条原始候选。
用 `preload` 的场景是“普通关键词搜出来的图不够准”，不是每次都要开；简单查询仍可直接 `search`。

## 6. 排序与过滤

- 下载前粗排：标题命中查询词 +12/词；标题零命中 −35；可信来源 +25；`mm.bing.net` 等
  缩略图域 −40；HTTPS +2。
- 下载后精排：最短边 / 12（上限 60）；标题零命中 −55；可信来源 +18；比例 0.55–1.9 +8，
  <0.35 或 >2.6 −18；≥50KB +4；最短边 <500 −30。
- `acceptableImage` 硬门槛：最短边 ≥500px、12KB–12MB、比例 0.3–3.4。不满足直接丢，
  不拿缩略图凑数。

## 7. 额度与状态

- 普通图/实物图：每天 30 张，目录 `~/.dsh/stellar/web-images/<YYYY-MM-DD>/`，跨天清空；
  单次最多 10 张。
- 预加载：临时目录 `~/.dsh/stellar/webimg-preload/<session>/`，TTL 1 小时、最多 10 个目录；
  **预加载本身不占 30 张**，只有 `pick` 成功落盘才占。`manifest.json` 记编号/尺寸/标题，`sheet.jpg` 是联系表。
- 结构式：独立缓存 `~/.dsh/stellar/chem-images/`，30 天 / 300 张，不占每天 30 张。
- 找不到图时返回明确失败码，不返回空清单让模型自己编。

## 8. 失败码

| code | 含义 | 下一步 |
| --- | --- | --- |
| `NEED_IDENTIFIER` | 中文名认不出对应化合物 | 给英文名、CAS 或 SMILES；不要猜 |
| `AMBIGUOUS_COMPOUND` | 多个 CID | 用 CAS/SMILES 指定，或从候选里挑 |
| `PUBCHEM_UNAVAILABLE` | PubChem 网络/5xx | 稍后重试，或直接给 CAS |
| `PRODUCT_UNVERIFIED` | 有图但 OCR 没双命中 | 当候选发，并说明未核对 |
| `IMAGE_TOO_SMALL` | 结构图小于 800px | 换 CID 或稍后重试 |
| `NO_CANDIDATES` | 两个引擎都没有可用结果 | 换更具体的词，或让主人发参考图 |
| `PRELOAD_EXPIRED` | 预加载会话超过 1 小时或已被清理 | 重新 `search preload=...`，拿新 session |
| `BAD_PICKS` | 编号不在联系表里 / 超过 5 张 | 看联系表编号，重挑 1–5 张 |
| `DAILY_LIMIT` | pick 时今天已满 30 张 | 明天再存，或先 `del`/`clear` 腾位置 |

## 9. 装配与重启

- MCP 工具在 `stellar/src/mcp-snowluma-safe.js`（`stellar_web_image`），命令在
  `plugins/stellar/tools/commands/webimg.mjs`，核心在 `plugins/stellar/tools/lib/webimg/`；
  预加载会话与联系表在 `lib/webimg/preload.mjs` + `contact-sheet.ps1`。
- 改 MCP schema、命令代码或 `lib/webimg/` 里的实现，都需要主人手动重启 DSH 才生效：
  MCP server 与工具进程各自常驻，ESM 模块按进程缓存，不会在两次调用之间热重载。
- 规则文件 `plugins/stellar/tools/rules/image.md` 已写明三模式与「结构式不要生图」。

## 10. 已知边界

- 中文别名表只有 133 条；生僻药名/商品名会返回 `NEED_IDENTIFIER`，这是有意的。
- PubChem 只给 2D 结构式，不给晶胞/轨道/反应式；这些仍要用其他来源或绘图工具。
- OCR 依赖 Windows 自带引擎；非 Windows 或 OCR 不可用时，药品包装只能给候选。
- 百度/Bing 的页面结构会变；解析失败时先看 `search-baidu.mjs` / `search-bing.mjs` 的选择器。
- 预加载只下载前 24 张候选（候选池 60–100 条），不是把 100 张全下；标题不代表画面内容时
  要看联系表。联系表格子 360×300，小字/细结构可能看不清，必要时 `pick` 后在本地再看原图。
- 图片版权只记录来源页，不判断许可证；对外发送前由使用者自行确认。

## 11. 改动检查单

- [ ] 新增/改模式时同步 MCP schema、CLI 参数、`rules/image.md` 与本文件。
- [ ] 改别名表后跑 `node scripts/test-webimg-chem.mjs`。
- [ ] 改排序/门槛后跑 `test-webimg-rank.mjs`，并至少真机看一次「雪山 小镇 风景」。
- [ ] 改 OCR 放大/纠偏后跑 `test-webimg-verify.mjs`，并用一张 800px 药盒真图复核。
- [ ] 改 schema 后跑 `test-mcp-web-image.mjs`。
- [ ] 改预加载/联系表后跑 `test-webimg-preload.mjs`；真机看一眼联系表编号是否清楚。
- [ ] 全量 `node scripts/test-audit.mjs` 绿后再写快照。
