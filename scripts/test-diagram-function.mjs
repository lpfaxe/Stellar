// 函数图核心：默认 512、自动范围、定义域、切线/积分、渐近线断线、错误码、真渲染。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plotFunction } from '../src/diagram/function-plot.js';
import { renderSvgToPng } from '../src/diagram/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures += 1; console.error('FAIL ' + name + ': ' + error.message); }
}
function expectCode(fn, code) {
  try { fn(); }
  catch (error) { assert.equal(error.code, code, error.message); return; }
  throw new Error('应当抛出 ' + code);
}

await check('默认 512×512，三角函数默认 [-2π, 2π] 且 y 不被压扁', () => {
  const r = plotFunction({ functions: [{ expression: 'sin(x)' }] });
  assert.equal(r.width, 512);
  assert.equal(r.height, 512);
  assert.ok(Math.abs(r.meta.xRange[0] + 2 * Math.PI) < 1e-9);
  assert.ok(Math.abs(r.meta.xRange[1] - 2 * Math.PI) < 1e-9);
  assert.ok(r.meta.yRange[0] > -2 && r.meta.yRange[1] < 2, JSON.stringify(r.meta.yRange));
  assert.match(r.svg, /<svg[^>]+width="512"/);
});

await check('多条曲线、定义域与切点/积分元数据', () => {
  const r = plotFunction({ width: 420, height: 420, functions: [
    { expression: 'x^2', tangentAt: 1 },
    { expression: 'sin(x)', domain: [0, Math.PI], integral: [0, Math.PI] },
  ] });
  assert.equal(r.meta.functions.length, 2);
  assert.deepEqual(r.meta.functions[1].domain, [0, Math.PI]);
  assert.ok(r.meta.tangents[0].slope > 1.9 && r.meta.tangents[0].slope < 2.1);
  assert.ok(Math.abs(r.meta.integrals[0].value - 2) < 0.01);
});

await check('tan 的渐近线断开（一条 path 内多个子路径）', () => {
  const r = plotFunction({ functions: [{ expression: 'tan(x)' }] });
  const curve = (r.svg.match(/<path[^>]*stroke="#2563eb"[^>]*>/g) || [])[0];
  assert.ok(curve, '应找到函数曲线 path');
  const moves = (curve.match(/M/g) || []).length;
  assert.ok(moves >= 3, 'tan 应断成多段，实际 M 数 ' + moves);
});

await check('参数错误有可行动 code', () => {
  expectCode(() => plotFunction({ functions: [] }), 'NO_FUNCTIONS');
  expectCode(() => plotFunction({ functions: [{ expression: 'x;' }] }), 'EXPR_ERROR');
  expectCode(() => plotFunction({ functions: [{ expression: 'sin(x)', domain: [2, 1] }] }), 'BAD_DOMAIN');
});

await await check('真渲染 PNG 并有尺寸/字节数', async () => {
  const r = plotFunction({ functions: [{ expression: 'sin(x)' }] });
  const out = await renderSvgToPng(r.svg, { width: r.width, prefix: 'test-function' });
  try {
    assert.ok(fs.existsSync(out.file));
    assert.ok(fs.statSync(out.file).size > 5000);
    assert.equal(out.width, 512);
  } finally {
    for (const f of [out.file, out.svgFile]) { try { fs.unlinkSync(f); } catch {} }
  }
});

if (failures) { console.error('\n' + failures + ' 项失败'); process.exit(1); }
console.log('\n✅ 函数图通过');