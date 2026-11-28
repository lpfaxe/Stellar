# 绘图工具（mcp-diagram）

> 2026-11-26 新增。解决的是「精确图」：函数图像、参数/极坐标曲线、思维导图。
> **不是**给模型自由作画——这里是确定性渲染：同一份输入每次出同一张图，坐标、刻度、文字都可控。
> 需要画笔触、氛围、插画感时仍用 `image_generate`；但函数图、曲线图、思维导图**一律不要**用它重画。

---

## 0. 一句话

新增第四个 MCP server `diagram`（脚本 `src/mcp-diagram.js`，serverName `diagram`），提供 3 个工具：
本地算点 → 拼 SVG → `@resvg/resvg-js` 栅格化成 PNG → 落到 `generate/diagram/` → 由 `qq_send_image` 发出去。
不调生图模型、不起 Python、不开浏览器、不联网，因此**不消耗 `image_generate` 的每日额度**，也不进 token 账本（本地渲染零 token）。

---

## 1. 三个工具

| 工具 | 作用 | 默认画布 | 数量上限 |
| --- | --- | --- | --- |
| `mcp__diagram__plot_function` | 笛卡尔坐标 `y=f(x)`，可带 `domain` / 切线 / 积分阴影 | 512×512（表情包大小） | 1–4 条曲线 |
| `mcp__diagram__plot_curve` | 参数曲线 `(x(t), y(t))` 或极坐标 `r(θ)` | 512×512，自动等比 | 1–3 条曲线 |
| `mcp__diagram__draw_mindmap` | 文字层级树，左右分栏自动排版 | 按内容自适应，最大 1600×1400 | 最多 60 节点 / 5 层 / 每节点 12 子 |

`width` / `height` 可传 320–1200。函数图默认正方形是为了直接当表情包/群图发；要宽图就显式传尺寸。

---

## 2. 函数图 `plot_function`

### 入参

```json
{
  "functions": [
    { "expression": "sin(x)", "label": "y=sin x" },
    { "expression": "x^2-2", "color": "#dc2626", "domain": [-2, 3], "tangentAt": 1 }
  ],
  "xRange": [-6.28, 6.28],
  "yRange": [-2, 4],
  "title": "函数图",
  "grid": true,
  "width": 512,
  "height": 512
}
```

- `functions`：必填，1–4 条；`expression` 只能是 `x` 的表达式。
- `domain`：可选 `[a,b]`，表示只画这一段（分段函数就写多条不同 `domain`）。
- `tangentAt`：可选数值，画该点切线（中心差分求斜率，虚线 + 圆点）。
- `integral`：可选 `[a,b]`，在曲线与 x 轴之间填色并标 `∫ ≈ 数值`（500 段梯形）。
- `xRange` / `yRange`：可选。不传 `xRange` 时，含三角函数的图默认 `[-2π,2π]`，否则 `[-5,5]`。
  不传 `yRange` 时取所有有限采样值的 **2%–98% 分位**再加 12% 边距——这是为了不让 `tan` / `1/x` 的极端值把整张图压扁。
- `title` / `grid`：可选；默认无标题、有浅网格。

### 表达式语法（安全子集，不用 `eval`）

- 变量：`x`（函数图）、`t` / `theta`（曲线图）。
- 常量：`pi`、`e`；也认 `π`、`θ`。
- 运算：`+ - * / ^`、比较 `< <= > >= == !=`、括号、逗号。
- 函数：`sin cos tan asin acos atan sinh cosh tanh sec csc cot sqrt abs exp ln lg log floor ceil round sign min max pow if`。
  `log(x)` 是常用对数，`log(x, base)` 可换底；`if(cond, a, b)` 惰性求值。
- 隐式乘法：`2x`、`2(x+1)`、`(x+1)(x-1)`、`x sin(x)` 都支持。
- 可写 `y=` / `f(x)=` 前缀；函数名**必须**带括号（`sin x` 会被拒）。
- 上限：表达式 ≤200 字符、token ≤400、AST 节点 ≤400、嵌套 ≤40 层。

被拒的输入：`;`、`[]`、`{}`、引号、属性访问（`x.y`）、`eval`、未知函数名、空表达式。

### 渲染口径

- 采样默认 `width * 2`（400–2000 点）。
- 渐近线：相邻采样点的**屏幕 y 跳变 > 绘图区高度 62%** 就断开，不画竖直连线（`tan`、`1/x` 靠这个）。
- 刻度用 1 / 2 / 5 × 10^k 的 nice step；x 轴端点对齐 π/2 且跨度 ≤20π 时自动用 π 刻度（`−π/2`、`π`、`2π`）。
- 原点只标一个 0；坐标轴箭头、轴标签、图例都在绘图区内避让。

---

## 3. 曲线图 `plot_curve`

```json
{
  "curves": [
    { "kind": "parametric", "x": "sin(3t)", "y": "sin(2t)", "range": [0, 6.283] },
    { "kind": "polar", "r": "1+cos(theta)", "range": [0, 6.283], "label": "心形线" }
  ],
  "title": "曲线",
  "width": 512,
  "height": 512
}
```

- `kind` 可省略：有 `r` 判极坐标，否则按参数曲线。
- `range` 别名 `tRange` / `thetaRange`，默认 `[0, 2π]`，跨度上限 1000π。
- 极坐标内部转成 `x=r cosθ`、`y=r sinθ`。
- 采样默认 1600（宽 ≥700 时 2400），最多 4000。
- 几何**自动等比**并留 8% 边距，所以圆是正圆；跳变超过绘图区 80% 才断线。

---

## 4. 思维导图 `draw_mindmap`

```json
{
  "tree": {
    "text": "高数上册",
    "children": [
      { "text": "函数与极限", "children": [
        { "text": "数列极限", "children": [{ "text": "夹逼准则" }] }
      ] },
      { "text": "导数与微分", "children": [{ "text": "求导法则" }] }
    ]
  },
  "width": 1200,
  "height": 800
}
```

节点别名：`text` / `name` / `label`。

硬限制：

| 项 | 上限 |
| --- | --- |
| 层数 | 5 层（根 + 4 层后代）；正常用 3–4 层 |
| 节点总数 | 60 |
| 每个节点的直接子节点 | 12 |
| 单节点文字 | 32 字（超出截断并加 …，在 `meta.warnings` 里报告） |
| 画布 | 最大 1600×1400，最小 480×360 |

- 根居中；一级分支按子树高度自动分到左右两栏（不是左右各一半）。
- 左侧分支向左展开、文字右对齐；右侧向右展开。连线是三次贝塞尔。
- 根深色底白字；一级分支各一色；二级以下白底彩边。
- 字号会按内容在 16 / 14.5 / 13 / 12px 四档里自动降，仍放不下就报 `TOO_LARGE`，**不会**悄悄裁掉内容。
- 只画文字树：不画图标、图片、链接、自由拖拽。

---

## 5. 限流（只针对非主人）

| 对象 | 每日 | 10 分钟窗口 |
| --- | --- | --- |
| 主人 | 不限 | 不限 |
| 非主人 | 20 张 | 10 张 |

- 判定用 `state/turn-context.json`（15 分钟内有效）的 `isOwner`：主人**既不计数也不写状态**。
- 非主人额度落在 `state/diagram-budget.json`，本地日界 0 点重置；窗口从最早一次算 `waitMs`。
- 模块：`plugins/stellar/lib/diagram-budget.js`，导出 `takeDiagramSlot` / `budgetStatus`。
- 守卫接在 `plugins/stellar/qq-tool-restrict.mjs` 的 `SAFE_EXACT` 分支里（三个工具名精确放行，不做整前缀放行；`mcp__diagram__*` 的任何新工具仍会被拒）。
- 超限时工具直接返回中文原因与还要等多久，不生成半张图。

---

## 6. 输出与发送

- 目录：`stellar/generate/diagram/`（已在 `.gitignore` 里排除）。
- 文件名：`<function|curve|mindmap>-YYYYMMDD-HHmmss-<svg sha1 前 8>.png`，同目录留同名 `.svg` 便于复查。
- 原子写：临时文件 + fsync + rename，权限 0o600；失败清理临时文件。
- 自动清理：保留最近 200 组、7 天以外的删除。
- 工具返回的正文里已有**绝对路径**。主人/群友要图时，把这个路径交给 `qq_send_image`；不要用 `image_generate` 重画。

---

## 7. 失败码

| code | 含义 | 下一步 |
| --- | --- | --- |
| `NO_FUNCTIONS` / `NO_CURVES` | 没给曲线 | 至少给 1 条 |
| `TOO_MANY_FUNCTIONS` / `TOO_MANY_CURVES` | 超数量上限 | 拆成两张，或删掉不必要的那条 |
| `EMPTY_EXPRESSION` | 表达式为空 | 补表达式 |
| `EXPR_ERROR` | 语法/函数名/非法字符 | 按 message 指出的位置改；函数名要带括号 |
| `BAD_RANGE` / `BAD_DOMAIN` | 区间不是 `[a,b]`、a≥b | 检查区间 |
| `RANGE_TOO_LARGE` | 跨度超限 | 缩小范围 |
| `EMPTY_DOMAIN` | `domain` 与 `xRange` 没有交集 | 放宽 `xRange` |
| `NO_FINITE_VALUES` | 整段都算不出有限值 | 换表达式或区间 |
| `BAD_TREE` / `EMPTY_TEXT` | 树结构不合法 / 节点没文字 | 修树 |
| `TOO_DEEP` / `TOO_MANY_NODES` / `TOO_MANY_CHILDREN` | 思维导图超限 | 收窄层级或拆图 |
| `TOO_LARGE` | 排版后仍超画布 | 减少节点或缩短文字 |
| `SVG_UNSAFE` / `SVG_TOO_LARGE` | 内部渲染前自检未过 | 属实现问题，记 PITFALLS |

所有失败都返回 `{ ok:false, code, error, hint }`（MCP 层是 `isError:true` 的文本），`hint` 一律写「下一步」而不是重复错误。

---

## 8. 装配与生效

- `scripts/setup-dsh.mjs`：`MANAGED_MCP_IDS` 四个 id；`servers['mcp-diagram'] = { serverName:'diagram', script: src/mcp-diagram.js, toolCallTimeoutMs: 120000 }`。
- `src/dsh-health.js`：`REQUIRED_MCP_IDS` 含 `mcp-diagram`，体检会检查它。
- 依赖：`@resvg/resvg-js@2.6.2`（写进 `package.json` / `package-lock.json`；发布版 exe 的 `SKIP_DIRS` 不含 node_modules，首次安装仍要 `npm install`）。
- 字体：Windows 下用 `C:/Windows/Fonts/msyh.ttc` 等系统字体（`loadSystemFonts:true` + `defaultFontFamily:'Microsoft YaHei'`）。非 Windows / 无中文字体会退到系统默认，中文可能变豆腐块——这是已知环境边界。
- **装配不是改代码，是真跑一次**：`MANAGED_MCP_IDS` 只是生成器，改完必须在仓库根执行
  `QQ_BRIDGE_SKIP_DSH_INSTALL=1 node scripts/setup-dsh.mjs desktop`，
  然后核对 `~/.dsh/profiles/desktop/cordis.patch.yml` 里真的出现四条 `serverName: diagram`。
  只改代码不跑 setup，DSH 里不会有工具——2026-11-26 就是这样漏的（她的会话里只有 DrawAI 的 `diagram_*`，没有 `mcp__diagram__*`）。
- **生效层级**：profile patch 写入后 DSH 可能热加载（无需重启）；若工具仍不出现，再由**用户手动重启 DSH**。AI 不得自己杀宿主或排「重启 DSH」的任务（PITFALLS #279）。
- **QQ 侧两道引导**：`SCHEMA_SLIM_GLOBAL_TOOLS` 把 DrawAI 的 `diagram_apply/export/read` 从 QQ schema 隐藏；`qq-tool-restrict` 对 `image_generate` 的「函数图/坐标系/y=…」提示词直接拒绝并指向本工具。改这两个文件需要 DSH 重启才生效。
- **模型怎么知道工具存在（2026-11-26 漏点）**：schema 里有不等于她知道。`qq_get_prompt` 的 `enabledTools` 与 `drawing` 块（`src/bridge.js` 的 `GET /api/socialV2/prompt`）必须列出这三个名字，每轮唤醒提示词也要带一行【绘图】；否则她会以 `enabledTools` 为准，回答「没有画图工具」。`bridge.js` 的生效层级是**重启桥接**，不是重启 DSH。

---

## 9. 验证

```bash
cd stellar
node scripts/test-diagram-function.mjs
node scripts/test-diagram-curve.mjs
node scripts/test-diagram-mindmap.mjs
node scripts/test-diagram-budget.mjs
node scripts/test-mcp-diagram.mjs        # 真拉起 stdio server
node scripts/test-audit-regressions.mjs     # R18：enabledTools + 唤醒【绘图】行
node scripts/test-audit-setup.mjs
node scripts/test-setup-dsh-idempotent.mjs
node scripts/test-dsh-health.mjs
node scripts/test-mcp-servers-stdio.mjs  # 真机列工具
```

活体验收：

1. 重启 DSH 后，在会话里能看到 `mcp__diagram__plot_function` 等三个工具；
2. 画 `sin(x)` 与 `tan(x)`——`tan` 的渐近线处必须断开，不能有竖线；
3. 画 `r=1+cos(theta)`——心形线朝右、是正圆比例；
4. 画 60 节点 / 12 分支 / 5 层思维导图——不重叠、不裁切、中文不出豆腐块；
5. 非主人连续画 11 张——第 11 张在 10 分钟内被拒，并说明还要等多久。

---

## 10. 已知边界（别当成 bug 修）

- **不做 3D**（曲面、空间曲线）、**不做隐函数 / 等高线 / 向量场**——这些是下一期或外部计算，不在本工具范围内。
- **不做符号求导/积分**：`tangentAt` / `integral` 都是数值的，给的是近似值。
- 采样是有限点：`sin(1/x)` 在 0 附近的振荡、隐函数相切、跳变点附近的真实形态都会失真。
- 思维导图只排版文字树；要配图标/图片/自由布局，用别的画布工具（DrawAI）。
- 图上的数字/刻度是渲染出来的，不受模型「写字」能力影响；但**表达式本身写错**会如实画错图——先复核表达式。
- 非 Windows 环境字体与路径需另行适配。

---

## 11. 改动检查单

- [ ] 改表达式能力 → 同时改 `src/diagram/expr.js` 函数表、本文件 §2、`test-diagram-function.mjs`
- [ ] 改上限 → 同时改 `function-plot.js` / `curve-plot.js` / `mindmap.js` 常量、`mcp-diagram.js` 的 schema（`children.max`、宽高）、本文件、对应测试
- [ ] 改限流 → 同时改 `diagram-budget.js`、本文件 §5、`test-diagram-budget.mjs`
- [ ] 改工具名/新增工具 → `mcp-diagram.js`、`qq-tool-restrict.mjs` 的 `SAFE_EXACT`、`test-preset-local-tools.mjs`、`test-mcp-diagram.mjs`、工具计数（全开 89 / 默认 85）
- [ ] 改装配 → `setup-dsh.mjs`、`test-audit-setup.mjs`、`test-setup-dsh-idempotent.mjs`、本文件 §8
- [ ] 每次都跑：`test-audit.mjs`、`privacy-scan.mjs --strict`、`check-doc-anchors.mjs --strict`
