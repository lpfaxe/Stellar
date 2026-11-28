// 药品包装文字校验单测：规格变体、数字纠偏、药名匹配。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeForMatch, strengthVariants, matchName, verifyPackaging, ocrAvailable } from '../plugins/stellar/tools/lib/webimg/verify.mjs';

let pass = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

check('normalizeForMatch 去空白/全角/标点', () => {
  assert.equal(normalizeForMatch('阿 司 匹 林（１００ｍｇ）'), '阿司匹林100mg');
});

check('strengthVariants 同时给 mg 与 g 写法', () => {
  const v = strengthVariants('100mg');
  assert.ok(v.includes('100mg'), v.join(','));
  assert.ok(v.includes('100毫克'), v.join(','));
  assert.ok(v.includes('0.1g'), v.join(','));
  assert.deepEqual(strengthVariants(''), []);
});

check('matchName 中文商品名命中通用名', () => {
  assert.equal(matchName('拜阿司匹林肠溶片 100mg', { name: '阿司匹林' }), '阿司匹林');
  assert.equal(matchName('ASPIRIN 100', { nameEn: 'aspirin' }), 'aspirin');
  assert.equal(matchName('布洛芬缓释胶囊', { name: '阿司匹林' }), '');
});

check('verifyPackaging 对坏图返回 ok:false 不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webimg-verify-'));
  const file = path.join(dir, 'bad.png');
  fs.writeFileSync(file, Buffer.from('not a png'));
  const r = verifyPackaging(file, { name: '阿司匹林', strength: '100mg' });
  assert.equal(r.ok, false); assert.equal(r.verified, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n' + pass + '/4 PASS');
if (pass !== 4) process.exitCode = 1;
