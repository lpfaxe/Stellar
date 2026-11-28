// PDF 纯函数单测：章标题、目录、图注、插图裁切框。
import assert from 'node:assert/strict';
import { parseChapterHeading, parseTocChapters, findCaption, normalizeFigureLabel, estimateFigureCrop } from '../plugins/stellar/tools/lib/pdf/parse.mjs';

let pass = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

check('parseChapterHeading 中文/阿拉伯数字', () => {
  assert.deepEqual(parseChapterHeading('第7章 固体的结构与性质'), { num: 7, title: '固体的结构与性质' });
  assert.deepEqual(parseChapterHeading('第 12 章  过渡元素'), { num: 12, title: '过渡元素' });
  assert.deepEqual(parseChapterHeading('第七章'), { num: 7, title: '' });
});

check('parseTocChapters 取章名与右侧页码', () => {
  const lines = [
    { text: '第1章 物质的状态', x: 100, y: 100, w: 300, h: 30 },
    { text: '1', x: 800, y: 100, w: 20, h: 20 },
    { text: '第2章 化学反应的方向', x: 100, y: 150, w: 300, h: 30 },
    { text: '27', x: 800, y: 150, w: 24, h: 20 },
  ];
  const out = parseTocChapters([{ page: 15, width: 1000, height: 1400, lines }]);
  assert.deepEqual(out.map((c) => [c.num, c.printedStart]), [[1, 1], [2, 27]]);
  assert.equal(out[1].title, '化学反应的方向');
});

check('normalizeFigureLabel 容忍 OCR 分隔符', () => {
  assert.equal(normalizeFigureLabel('图7.5'), '7-5');
  assert.equal(normalizeFigureLabel('图 7，14'), '7-14');
  assert.equal(normalizeFigureLabel('图7—16'), '7-16');
  assert.equal(normalizeFigureLabel('图7'), '');
});

check('findCaption captionOnly 先认图注，再认正文引用', () => {
  const text = '如图 7.5 所示，NaCl 晶胞。\n图 7.5 NaCl 的晶体结构';
  const strict = findCaption(text, '7-5', { captionOnly: true });
  assert.equal(strict.line, '图 7.5 NaCl 的晶体结构');
  const loose = findCaption('如图 7.5 所示', '7-5');
  assert.equal(loose.line, '如图 7.5 所示');
});

check('estimateFigureCrop 7-5 通栏图注向上裁', () => {
  const W = 3400, H = 4950;
  const lines = [
    { text: '按晶胞的组成、结构在三维空间重复排列。晶胞可看作为晶体的缩影。', x: 300, y: 2200, w: 2800, h: 70 },
    { text: '图 7.5 NaCl 的晶体结构', x: 1200, y: 2760, w: 900, h: 55 },
    { text: '7.1.3 单晶体和多晶体', x: 300, y: 2920, w: 500, h: 60 },
  ];
  const crop = estimateFigureCrop(lines, lines[1], W, H);
  assert.ok(crop.y > 2200 && crop.y < 2700, JSON.stringify(crop));
  assert.ok(crop.y + crop.h <= 2760);
  assert.ok(crop.w > 2000);
});

check('estimateFigureCrop 7-14 右栏图注留在本栏', () => {
  const W = 3400, H = 4950;
  const lines = [
    { text: '若晶体中掺入杂质，会造成置换缺陷。', x: 200, y: 300, w: 1300, h: 60 },
    { text: '(a) 空穴', x: 1450, y: 1000, w: 220, h: 40 },
    { text: '(b) 置换', x: 1950, y: 1000, w: 220, h: 40 },
    { text: '(c) 间充', x: 2450, y: 1000, w: 220, h: 40 },
    { text: '图 7.14 晶体点缺陷示意图', x: 2321, y: 1432, w: 754, h: 55 },
    { text: '晶体中的缺陷对晶体的物理、化学性质产生影响。', x: 300, y: 1700, w: 1300, h: 60 },
  ];
  const crop = estimateFigureCrop(lines, lines[4], W, H);
  assert.ok(crop.x >= 1632, JSON.stringify(crop));
  assert.ok(crop.y < 1432 && crop.y + crop.h <= 1432);
  assert.ok(crop.h > 500, JSON.stringify(crop));
});

console.log('\n' + pass + '/6 PASS');
if (pass !== 6) process.exitCode = 1;