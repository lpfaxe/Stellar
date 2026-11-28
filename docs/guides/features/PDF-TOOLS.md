# PDF 按章读 + 插图截取（stellar_pdf）

> 一句话：**先看目录，只读要读的那一章；要图就按图注定位裁一张 PNG**。扫描版没有文字层也能读，代价是第一次建索引要 OCR 前 40 页。
>
> 代码：`plugins/stellar/tools/lib/pdf/`（索引 / 页面 OCR / 插图 / 额度四块）+ `src/mcp-snowluma-safe.js` 的 `stellar_pdf` 包装。
> 这一块设计成**可整块切除**：删掉 `tools/lib/pdf/`、`stellar_pdf` 注册块、守卫里的 `pdfBudgetGuard` 与规则里两行即可，不影响其它工具。

## 1. 为什么不用 `stellar_file_read`

`stellar_file_read` 读 PDF 是**整份抽文字**：有文字层的用 pdfjs，没有文字层的扫描件走 Windows OCR，但一次最多 30 页、默认只回开头 12000 字。一本 529 页的教材会变成：

- 只读到前 30 页，第七章根本不在里面；
- 想读后面只能反复整份解析，慢且烧 token；
- 插图被直接丢掉，图上文字在扫描件里还会和正文混在一起。

`stellar_pdf` 把「目录 → 章范围 → 按页缓存 → 图注」拆开，只读需要的那一段。

## 2. 三个 action

| action | 参数 | 返回 |
| --- | --- | --- |
| `outline`（默认） | 文件来源 | 页数、目录来源、印刷页偏移、每章 `num/title/printedStart/pdfStart/confidence/pages` |
| `read` | `chapter` 或 `page` 或 `pages:"199-208"`，可选 `maxChars` | 每页带【PDF N 页（印刷页 M）】标记的正文；超预算给 `nextPage` |
| `figure` | `chapter` + `figure:"7-5"`（或 `page` + `figure`） | 图号、图注原文、PDF 页、宽高、本地 PNG 路径 + 图片内容 |

### 2.1 文件来源

- **主人**：`path`（绝对路径或工作区相对路径）、`url`、`messageId`、`forwardId + name`、`fileId`、`name` 都行。
- **非主人**：只能用**本会话里合并转发**过来的 PDF（`file.fromForward === true`），不能传 `path`/`url`。直接私聊发来的文件只有主人能读。
- URL / 聊天附件会先落到系统临时目录，读完 `finally` 删除；单文件上限 **256MB**。

### 2.2 典型调用

```text
stellar_pdf { key, action:"outline", path:"C:/.../无机化学（第五版）.pdf" }
stellar_pdf { key, action:"read", path:"...", chapter:7 }
stellar_pdf { key, action:"read", path:"...", pages:"204-210", maxChars:8000 }
stellar_pdf { key, action:"figure", path:"...", chapter:7, figure:"7-14" }
```

拿到 `figure` 的本地路径后，要发到 QQ 就再调 `qq_send_image`（`imagePath` 填那个路径）；只在回答里描述就不用发。

## 3. 章节索引怎么来

`buildIndex()` 按优先级：

1. **PDF 自带 outline**：至少 3 章才采用，`confidence=outline`；页数直接来自 `getDestination()`。
2. **目录 OCR**：没有 outline 就 OCR 前 40 页，`parseTocChapters()` 找「第N章 + 右侧页码」，得到 `printedStart`。
3. **印刷页偏移**：`estimateOffset()` 用章首页的页眉页码投票（`PDF 页 - 印刷页`），取众数；例如 529 页教材得到 `+25`。
4. **补缺**：目录 OCR 偶尔漏页码（2026-11-27 实测第 2、5、15 章为 0）。用相邻已知章**线性插值**补一个估计值，`confidence=interpolated`，只当线索。
5. **按需复核**：`resolveChapter()` 对 `estimated/interpolated/toc` 不直接信，围绕估计页 **±14 页**逐页找章标题（前 6 行含「第N章」，或首行正好「第」且下一行≥4 字）；命中改成 `verified` 并写回索引。

`outline` 里的 `confidence` 就是这四档：`outline` / `verified` / `estimated` / `interpolated`。`read` 会在真正读之前把当前章和下一章都复核一遍，所以 `pdfEnd` 是可靠的「下一章起始页 - 1」。

索引缓存：`state/pdf-index/<key>.json`，`key = sha1(size-mtime).slice(0,16)`；PDF 被替换（大小或 mtime 变）自动失效。`INDEX_VERSION` 变了也失效。

## 4. 页面文字与 OCR

`readPageText()`：

1. 先用 pdfjs 的 `getTextContent()` 抽这一页；按 y 坐标分行。
2. 去掉空白后**少于 40 字**才认为「这页没文字层」，转 OCR。
3. OCR 走 `pdf-ocr.ps1`：`Windows.Data.Pdf` 渲染该页（默认宽 1700，实际输出 2 倍像素），`Windows.Media.Ocr` 认字，返回带 bbox 的行。
4. 结果写 `state/pdf-cache/<key>/pNNNN.txt`，下次直接读；按章读 20 页在缓存命中时是秒级。

OCR 的现实边界：

- 中文词之间常被识别出空格，`tidyLine()` 会合并**两个汉字之间**的空格；
- 公式、上下标、小字、图内标签容易错（例如「图 7.5」被认成「图7，5」「图7口9」）；
- 页眉页码可能被认错，所以偏移用「投票 + 章首复核」，不靠单页；
- 扫描版第一次 `outline` 要 OCR 40 页，**约 50 秒**（529 页教材实测 48.9 秒）。不要因为慢就说「读不了」。

## 5. 插图定位与裁切

`figurePdf()`：

1. 在本章正文里找**图注行**：优先「图」开头的行（`findCaption captionOnly=true`），找不到才接受「如图 7-5 所示」这种正文引用。
2. 图号容错：`图7.5` / `图 7，14` / `图7—16` 都归一成 `7-5` / `7-14` / `7-16`；OCR 把 5 认成「巧」、1 认成「儿/口/|」也能救回。
3. 对图注所在页做一次 OCR（宽 1700）拿 bbox，`estimateFigureCrop()` 估算区域：
   - **通栏图注**（居中）：看图注上方/下方的空白，图注紧贴哪边，图就在哪边；用最近的正文行当边界。
   - **栏内图注**（靠左/靠右）：只在本栏找，图内短标签（`(a)`、`(b)`、`OOc` 之类）用来估图的左右和上沿，避免把另一栏正文或图注下方正文带进来。
4. 按 1700 宽重渲染该页 → 用 `crop.ps1`（System.Drawing）裁切 → 等比缩到最长边 **1600px**，输出 PNG 到 `generate/pdf/figure-<图号>_<时间戳>.png`。
5. 找不到图注或裁切区域太小（<120×100）→ 退**整页图**，并在返回里标 `fullPage`；不会编一张图。

输出保留最近 **200 个 / 7 天**，由 `pruneOutputs()` 清理。

## 6. 额度

| 谁 | 额度 | 状态 |
| --- | --- | --- |
| 主人 | 不限 | 不写 `state/pdf-budget.json` |
| 非主人 | 每天 **5 次**、每 **10 分钟 2 次** | `state/pdf-budget.json`，本地日界 0 点重置 |

「一次」按一次 `stellar_pdf` 调用算（outline / read / figure 都算），不是按页。守卫在 `plugins/stellar/qq-tool-restrict.mjs` 的 `pdfBudgetGuard()`：

- 主人判定：优先用工具参数 `key` 读**按会话**的 `state/turn-context/<safe>.json`，读不到才退回全局 `state/turn-context.json`；`isOwner` 15 分钟内有效。按会话读是为了避免两个会话交替时被「最后一条消息」误判；文件名规则必须与 `bridge.js` 的 `turnContextFileFor()` 一致。
- 额度函数必须**同步**：`ctx.tools.guard` 是同步执行守卫，`takePdfSlot()` / `writeState()` 里不能有 `await`（2026-11-27 的 NaN/全拒事故，见 PITFALLS #352）。
- 超日额度 / 超窗口返回中文原因 + 大约等多久，让模型**不要连续重试**；`waitMs` 缺失时兜底「大约 1 分钟」，绝不输出 NaN；
- 守卫自身异常只记 `console.error` 并放行（额度故障不阻断读文件）。

控制台 / B站 会话没有 turn-context，会被当成非主人计数——这是已知边界。

## 7. 安全边界

- 表达式不涉及；这里没有代码执行、没有 shell 参数拼接（PowerShell 用 `execFile` 数组传参）。
- 路径：`assertReadableLocalPath()` 校验；拒绝 `..`、UNC、符号链接逃逸；只读文件。
- URL：`fetchFileBuffer()` 走 `safe-fetch`（禁内网/环回，重定向逐跳复核）。
- 聊天附件：非主人只允许合并转发，且必须 `x-agent-token` 对应的 key 与请求 key 一致。
- 日志只记路径、页数、耗时，不记正文。
- 输出目录只有 `generate/pdf/`，文件名由图号 + 时间戳生成，不采信用户输入做路径。

## 8. 失败码

所有失败都是 `ok:false`（MCP 层 `isError:true`），文案统一「读 PDF 失败（CODE）：message + 下一步：hint」。

| 码 | 含义 | 下一步 |
| --- | --- | --- |
| `PDF_NOT_FOUND` | 路径不存在 | 确认路径 / 重新发一次文件 |
| `PDF_ENGINE_MISSING` | pdfjs 没装 | 仓库根 `npm install` |
| `PDF_TOC_NOT_FOUND` | 前 40 页没找到目录 | 用 `read` + `page` 直接读；或发目录页截图 |
| `PDF_CHAPTER_NOT_FOUND` | 没有这一章 / 附近找不到章标题 | 先 `outline` 看章号；或给正确起始页 |
| `PDF_PAGE_OUT_OF_RANGE` | 页码不在 1–N | 先 `outline` |
| `PDF_FIGURE_NOT_FOUND` | 本章没找到这个图号 | 返回里会列本章能找到的图注；或按页出整页图 |
| `PDF_OCR_FAILED` | OCR 没产出 / 加密 | 确认没加密；把那一页截图发来 |
| `PDF_RENDER_FAILED` | 页面渲染 / 裁切失败 | 改整页图，或截图 |

## 9. 装配与生效

- `stellar_pdf` 属于现有的 `snowluma` MCP server，**不新增 MCP server**，所以 `MANAGED_MCP_IDS` 仍是四个。
- 改了 `src/mcp-snowluma-safe.js` 或 `tools/lib/pdf/` 要**重启 DSH** 才生效（MCP server 是 DSH 拉起的子进程）。
- 改了 `qq-tool-restrict.mjs` 的守卫也要重启 DSH（preset 插件）。
- 重启只能由主人手动做；AI 不得杀宿主（PITFALLS #279）。
- 验证顺序：
  1. `node --check src/mcp-snowluma-safe.js`
  2. `node scripts/test-pdf-parse.mjs` / `test-pdf-budget.mjs` / `test-mcp-pdf.mjs`
  3. `node scripts/test-mcp-servers-stdio.mjs`（snowluma 应为 85 个工具，含 `stellar_pdf`）
  4. 真机：`outline` → `read chapter:7` → `figure 7-14`，看图确认不是整页/错图

## 10. 可切除边界

要整块拿掉 PDF 能力：

1. 删 `plugins/stellar/tools/lib/pdf/` 整个目录；
2. 删 `src/mcp-snowluma-safe.js` 里 `server.tool('stellar_pdf', ...)` 整块；
3. 删 `qq-tool-restrict.mjs` 的 `takePdfSlot` import、`pdfBudgetGuard()` 与 `stellar_pdf` 分支；
4. 删 `tools/rules/file.md` 里的 PDF 两行；
5. 删 `scripts/test-pdf-*.mjs` / `test-mcp-pdf.mjs` 并从 `test-audit.mjs` 去掉；
6. 删 `state/pdf-*` 与 `generate/pdf/`（可选，都是缓存）。

工具计数随之回到 91（snowluma 85、默认 schema 87）。

## 11. 已知边界与后续

- 目录 OCR 只扫前 40 页；目录在 40 页之后的 PDF 会 `PDF_TOC_NOT_FOUND`，目前只能按页读。
- 章标题被 OCR 截断（实测第 13 章「过渡元素 （ 一」少了右括号）只影响显示，不影响页范围。
- 图注跨页、图在下一页、一张页上多个同号子图，目前按「本章第一个图注 + 同页裁切」处理；子图不单独切。
- 表格/流程图没有专门的「表注」定位；要表就按页出整页图。
- 页码偏移按全书一个常数处理；插页/彩色页导致局部偏移时，章首复核能纠正章起点，但章内页码标签可能差 1–2 页。
- 真实 QQ 端到端（>60MB PDF、合并转发、非主人额度）还没跑；本轮验证是本地 stdio + 真 PDF。

## 12. 改动检查单

- [ ] `node --check` 所有改过的 `.mjs`
- [ ] `test-pdf-parse` / `test-pdf-budget` / `test-mcp-pdf` 全绿
- [ ] `test-mcp-servers-stdio` 里 snowluma 工具数 +1
- [ ] 真机 `outline` 的章表没有 `0`（插值后至少不是 0）
- [ ] `read chapter:N` 第一页确实是章首页
- [ ] `figure` 出的图不是整页、不是图注下方正文
- [ ] 非主人第 3 次 10 分钟内调用被拒、第 6 次当天被拒
- [ ] 文档计数：91 个工具 / 默认 schema 87
- [ ] 重启 DSH 后 QQ 会话能看到 `mcp__snowluma__stellar_pdf`
