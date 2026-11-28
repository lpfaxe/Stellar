// 本地绘图 MCP server（stdio）：函数图、参数/极坐标曲线、思维导图。
// 只生成 PNG 到 stellar/generate/diagram/，不联网、不执行 shell、不读用户文件。
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { plotFunction } from './diagram/function-plot.js';
import { plotCurve } from './diagram/curve-plot.js';
import { drawMindmap } from './diagram/mindmap.js';
import { renderSvgToPng } from './diagram/render.js';

export const SERVER_NAME = 'diagram';

const numberPair = z.array(z.number()).length(2);

const functionSchema = z.object({
  expression: z.string().min(1).max(200).describe('y 关于 x 的表达式，例如 "sin(x)" 或 "x^2 - 1"'),
  label: z.string().max(60).optional().describe('图例文字；默认 "y = 表达式"'),
  color: z.string().max(9).optional().describe('十六进制颜色，例如 "#dc2626"'),
  domain: numberPair.optional().describe('这一条曲线的定义域 [a, b]'),
  tangentAt: z.number().optional().describe('在该 x 处画切线'),
  integral: numberPair.optional().describe('在该区间 [a, b] 画积分阴影'),
});

const curveSchema = z.object({
  kind: z.enum(['parametric', 'polar']).optional().describe('默认：有 r 就是 polar，有 x/y 就是 parametric'),
  x: z.string().max(200).optional().describe('参数方程 x(t)'),
  y: z.string().max(200).optional().describe('参数方程 y(t)'),
  r: z.string().max(200).optional().describe('极坐标 r(theta)'),
  range: numberPair.optional().describe('参数范围；默认 [0, 2π]'),
  label: z.string().max(60).optional(),
  color: z.string().max(9).optional(),
});

const mindNodeSchema = z.lazy(() => z.object({
  text: z.string().max(64).optional().describe('节点文字，建议不超过 32 字'),
  name: z.string().max(64).optional(),
  label: z.string().max(64).optional(),
  children: z.array(mindNodeSchema).max(12).optional().describe('子节点，最多 12 个'),
}));

function failureContent(err) {
  const code = err && err.code ? err.code : 'INTERNAL_ERROR';
  const message = err && err.message ? err.message : String(err);
  const hint = err && err.hint ? err.hint : '检查参数后重试；如果反复失败，把这条错误原样告诉用户。';
  return {
    isError: true,
    content: [{ type: 'text', text: '绘图失败（' + code + '）：' + message + '\n下一步：' + hint }],
  };
}

async function finish(result, prefix) {
  const out = await renderSvgToPng(result.svg, { width: result.width, prefix });
  const meta = result.meta || {};
  const lines = [
    '已生成' + (prefix === 'mindmap' ? '思维导图' : prefix === 'curve' ? '曲线图' : '函数图') + '：' + out.file,
    '尺寸：' + out.width + '×' + out.height + '（PNG，' + out.bytes + ' 字节）',
  ];
  if (meta.nodeCount) lines.push('节点：' + meta.nodeCount + ' 个，' + (meta.depth + 1) + ' 层');
  if (meta.xRange) lines.push('坐标范围：x [' + meta.xRange.map((v) => Number(v).toFixed(3)).join(', ') + ']，y [' + meta.yRange.map((v) => Number(v).toFixed(3)).join(', ') + ']');
  if (Array.isArray(meta.integrals) && meta.integrals.length) lines.push('积分近似值：' + meta.integrals.map((i) => i.value.toFixed(4)).join('、'));
  if (Array.isArray(meta.warnings) && meta.warnings.length) lines.push('提示：' + meta.warnings.join('；'));
  lines.push('把上面的 PNG 路径传给 qq_send_image 的 imagePath 即可发送；不要再用 image_generate 重画。');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

export function createDiagramServer() {
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });

  server.tool(
    'plot_function',
    '精确画一元函数图 y=f(x)：1–4 条曲线，支持定义域、自动 y 范围、渐近线断线、切线、积分阴影。只做大学高数上册的 2D 笛卡尔图，不做 3D/隐函数/向量场。生成 PNG 后用 qq_send_image 发送。',
    {
      functions: z.array(functionSchema).min(1).max(4).describe('要画的函数，按顺序着色'),
      xRange: numberPair.optional().describe('x 范围，默认 [-5,5]；含三角函数时默认 [-2π,2π]'),
      yRange: numberPair.optional().describe('y 范围；不传自动按 2%–98% 分位取'),
      width: z.number().min(320).max(1200).optional().describe('画布宽，默认 512'),
      height: z.number().min(320).max(1200).optional().describe('画布高，默认 512'),
      title: z.string().max(120).optional(),
      grid: z.boolean().optional(),
    },
    async (args) => {
      try {
        const result = plotFunction(args);
        return await finish(result, 'function');
      } catch (err) { return failureContent(err); }
    },
  );

  server.tool(
    'plot_curve',
    '精确画参数曲线 (x(t), y(t)) 或极坐标曲线 r(θ)：1–3 条，支持自定义参数范围。几何形状自动等比，不会画扁。生成 PNG 后用 qq_send_image 发送。',
    {
      curves: z.array(curveSchema).min(1).max(3),
      width: z.number().min(320).max(1200).optional().describe('画布宽，默认 512'),
      height: z.number().min(320).max(1200).optional().describe('画布高，默认 512'),
      title: z.string().max(120).optional(),
      grid: z.boolean().optional(),
      xRange: numberPair.optional(),
      yRange: numberPair.optional(),
    },
    async (args) => {
      try {
        const result = plotCurve(args);
        return await finish(result, 'curve');
      } catch (err) { return failureContent(err); }
    },
  );

  server.tool(
    'draw_mindmap',
    '画层级思维导图：根居中、一级分支自动分到左右两侧，最多 5 层 / 60 节点 / 每节点 12 个子节点；文字建议不超过 32 字。自动收窄画布，超过 1600×1400 会报 TOO_LARGE。生成 PNG 后用 qq_send_image 发送。',
    {
      tree: mindNodeSchema.describe('根节点 { text, children: [...] }'),
      width: z.number().min(320).max(1600).optional().describe('画布宽；不传自动'),
      height: z.number().min(320).max(1400).optional().describe('画布高；不传自动'),
    },
    async (args) => {
      try {
        const result = drawMindmap(args.tree, { width: args.width, height: args.height });
        return await finish(result, 'mindmap');
      } catch (err) { return failureContent(err); }
    },
  );

  return server;
}

async function main() {
  const server = createDiagramServer();
  await server.connect(new StdioServerTransport());
  console.error('[mcp-diagram] ready');
}

const entry = String(process.argv[1] || '');
if (entry && path.basename(entry) === 'mcp-diagram.js') {
  main().catch((err) => {
    console.error('[mcp-diagram] fatal: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}