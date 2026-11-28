// 绘图 MCP server 端到端：stdio 握手、三个工具真渲染、错误可行动、清理产物。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'mcp-diagram.js')],
  cwd: ROOT,
  stderr: 'pipe',
});
const client = new Client({ name: 'dsh-mcp-diagram-test', version: '0.0.0' });
const made = [];
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (error) { failures += 1; console.error('FAIL ' + name + ': ' + error.message); }
}
function textOf(result) {
  return (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}
function fileOf(result) {
  const m = textOf(result).match(/已生成[^：]*：(.+?\.png)/);
  assert.ok(m, '结果里应有 PNG 路径：' + textOf(result).slice(0, 200));
  return m[1].trim();
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('工具清单固定为三个', () => {
    assert.deepEqual(names, ['draw_mindmap', 'plot_curve', 'plot_function']);
  });

  const fn = await client.callTool({ name: 'plot_function', arguments: { functions: [{ expression: 'sin(x)', tangentAt: 1 }] } });
  check('plot_function 真出 PNG', () => {
    assert.ok(!fn.isError, textOf(fn));
    const file = fileOf(fn);
    made.push(file);
    assert.ok(fs.existsSync(file), '文件不存在：' + file);
    assert.ok(fs.statSync(file).size > 5000);
    assert.match(textOf(fn), /尺寸：512×512/);
  });

  const curve = await client.callTool({ name: 'plot_curve', arguments: { curves: [{ r: '1 + cos(theta)' }] } });
  check('plot_curve 真出 PNG', () => {
    assert.ok(!curve.isError, textOf(curve));
    const file = fileOf(curve);
    made.push(file);
    assert.ok(fs.existsSync(file));
    assert.match(textOf(curve), /已生成曲线图/);
  });

  const mind = await client.callTool({ name: 'draw_mindmap', arguments: { tree: { text: '高数上册', children: [{ text: '极限' }, { text: '导数' }] } } });
  check('draw_mindmap 真出 PNG', () => {
    assert.ok(!mind.isError, textOf(mind));
    const file = fileOf(mind);
    made.push(file);
    assert.ok(fs.existsSync(file));
    assert.match(textOf(mind), /节点：3 个，2 层/);
  });

  const bigTree = {
    text: '根',
    children: Array.from({ length: 12 }, (_, i) => (i === 0
      ? { text: '分支1', children: [{ text: '层3', children: [{ text: '层4', children: [{ text: '层5' }] }] }] }
      : { text: '分支' + (i + 1) })),
  };
  const big = await client.callTool({ name: 'draw_mindmap', arguments: { tree: bigTree } });
  check('draw_mindmap 支持 5 层 / 12 分支', () => {
    assert.ok(!big.isError, textOf(big));
    const file = fileOf(big);
    made.push(file);
    assert.ok(fs.existsSync(file));
    assert.match(textOf(big), /节点：16 个，5 层/);
  });

  const bad = await client.callTool({ name: 'plot_function', arguments: { functions: [{ expression: 'x;' }] } });
  check('坏表达式返回可行动错误', () => {
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /绘图失败（EXPR_ERROR）/);
    assert.match(textOf(bad), /下一步：/);
  });
} catch (error) {
  failures += 1;
  console.error('FAIL 端到端：' + (error?.stack || error));
} finally {
  try { await client.close(); } catch {}
  for (const file of made) {
    for (const f of [file, file.replace(/\.png$/, '.svg')]) { try { fs.unlinkSync(f); } catch {} }
  }
}

if (failures) { console.error('\n' + failures + ' 项失败'); process.exit(1); }
console.log('\n✅ 绘图 MCP 端到端通过');
