// 参数/极坐标：正圆等比、cardioid、范围与错误码。
import assert from 'node:assert/strict';
import { plotCurve } from '../src/diagram/curve-plot.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (error) { failures += 1; console.error('FAIL ' + name + ': ' + error.message); }
}
function expectCode(fn, code) {
  try { fn(); }
  catch (error) { assert.equal(error.code, code, error.message); return; }
  throw new Error('应当抛出 ' + code);
}

check('参数圆是正圆（x/y 跨度相等）', () => {
  const r = plotCurve({ curves: [{ x: 'cos(t)', y: 'sin(t)' }] });
  const sx = r.meta.xRange[1] - r.meta.xRange[0];
  const sy = r.meta.yRange[1] - r.meta.yRange[0];
  assert.ok(Math.abs(sx - sy) < 0.01, 'x/y 跨度应相等：' + sx + ' vs ' + sy);
  assert.ok(r.meta.xRange[0] < -1 && r.meta.xRange[1] > 1);
  assert.equal(r.width, 512);
});

check('极坐标 cardioid 朝右，r 别名生效', () => {
  const r = plotCurve({ curves: [{ r: '1 + cos(theta)', range: [0, 2 * Math.PI] }] });
  assert.ok(r.meta.xRange[1] > 1.9 && r.meta.xRange[0] > -0.7, JSON.stringify(r.meta.xRange));
  assert.equal(r.meta.curves[0].kind, 'polar');
});

check('多条曲线与自定义范围', () => {
  const r = plotCurve({ curves: [
    { x: 'sin(3t)', y: 'sin(2t)', range: [0, 2 * Math.PI] },
    { kind: 'polar', r: 'theta/4', range: [0, 5 * Math.PI] },
  ] });
  assert.equal(r.meta.curves.length, 2);
  assert.equal(r.meta.curves[1].kind, 'polar');
});

check('错误码可行动', () => {
  expectCode(() => plotCurve({ curves: [] }), 'NO_CURVES');
  expectCode(() => plotCurve({ curves: [{ x: 'cos(t)' }] }), 'EMPTY_EXPRESSION');
  expectCode(() => plotCurve({ curves: [{ r: 'foo(theta)' }] }), 'EXPR_ERROR');
  expectCode(() => plotCurve({ curves: [{ x: 'cos(t)', y: 'sin(t)', range: [0, 0] }] }), 'BAD_RANGE');
});

if (failures) { console.error('\n' + failures + ' 项失败'); process.exit(1); }
console.log('\n✅ 曲线图通过');