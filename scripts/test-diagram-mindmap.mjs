// 思维导图：5 层 / 60 节点 / 每节点 12 子，自动画布与超限错误码。
import assert from 'node:assert/strict';
import { drawMindmap } from '../src/diagram/mindmap.js';

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
function chain(depth) {
  let node = { text: '层' + depth };
  for (let i = depth - 1; i >= 1; i -= 1) node = { text: '层' + i, children: [node] };
  return node;
}

check('35 节点高数树收在 1600×1400 内', () => {
  const tree = {
    text: '高数上册',
    children: [
      { text: '函数与极限', children: [
        { text: '数列极限', children: [{ text: '夹逼准则' }, { text: '单调有界' }] },
        { text: '函数极限', children: [{ text: '左右极限' }, { text: '无穷小' }] },
        { text: '连续性', children: [{ text: '间断点分类' }] },
      ] },
      { text: '导数与微分', children: [
        { text: '导数定义', children: [{ text: '切线斜率' }] },
        { text: '求导法则', children: [{ text: '复合函数' }, { text: '隐函数' }] },
        { text: '微分', children: [{ text: '近似计算' }] },
      ] },
      { text: '微分中值定理', children: [
        { text: '罗尔定理' }, { text: '拉格朗日' }, { text: '柯西定理' },
      ] },
      { text: '不定积分', children: [
        { text: '换元法', children: [{ text: '第一类换元' }, { text: '第二类换元' }] },
        { text: '分部积分' },
      ] },
      { text: '定积分', children: [
        { text: '性质', children: [{ text: '线性' }, { text: '区间可加' }] },
        { text: '牛顿-莱布尼茨' },
        { text: '应用', children: [{ text: '面积' }, { text: '体积' }] },
      ] },
    ],
  };
  const r = drawMindmap(tree);
  assert.equal(r.meta.nodeCount, 35);
  assert.equal(r.meta.depth, 3);
  assert.ok(r.width <= 1600 && r.height <= 1400, r.width + '×' + r.height);
  assert.ok(r.width >= 480 && r.height >= 360);
  assert.match(r.svg, /<svg[^>]+width="/);
});

check('5 层链允许，6 层拒绝', () => {
  const r = drawMindmap(chain(5));
  assert.equal(r.meta.depth, 4);
  assert.equal(r.meta.nodeCount, 5);
  expectCode(() => drawMindmap(chain(6)), 'TOO_DEEP');
});

check('一级 12 个分支允许，13 个拒绝', () => {
  const ok = drawMindmap({ text: '根', children: Array.from({ length: 12 }, (_, i) => ({ text: '分支' + (i + 1) })) });
  assert.equal(ok.meta.nodeCount, 13);
  expectCode(() => drawMindmap({ text: '根', children: Array.from({ length: 13 }, (_, i) => ({ text: '子' + i })) }), 'TOO_MANY_CHILDREN');
});

check('12 分支 60 节点宽树收在画布内', () => {
  const branches = Array.from({ length: 12 }, (_, i) => ({
    text: '分支' + (i + 1),
    children: Array.from({ length: i < 11 ? 4 : 3 }, (_, j) => ({ text: '子' + (i + 1) + '.' + (j + 1) })),
  }));
  const r = drawMindmap({ text: '根', children: branches });
  assert.equal(r.meta.nodeCount, 60);
  assert.equal(r.meta.depth, 2);
  assert.ok(r.width <= 1600 && r.height <= 1400, r.width + '×' + r.height);
});

check('指定画布时内容居中且不小于内容', () => {
  const r = drawMindmap({ text: '中心', children: [{ text: '左' }, { text: '右' }] }, { width: 900, height: 600 });
  assert.equal(r.width, 900);
  assert.equal(r.height, 600);
});

check('长文字截断并给警告', () => {
  const r = drawMindmap({ text: '长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长' });
  assert.ok(r.meta.warnings.length >= 1);
});

check('超限与坏树有 code', () => {
  expectCode(() => drawMindmap({ text: '' }), 'EMPTY_TEXT');
  const tooMany = { text: '根', children: Array.from({ length: 12 }, (_, i) => ({ text: '分支' + i, children: Array.from({ length: 5 }, (_, j) => ({ text: '子' + j })) })) };
  expectCode(() => drawMindmap(tooMany), 'TOO_MANY_NODES');
  expectCode(() => drawMindmap(null), 'BAD_TREE');
});

if (failures) { console.error('\n' + failures + ' 项失败'); process.exit(1); }
console.log('\n✅ 思维导图通过');
