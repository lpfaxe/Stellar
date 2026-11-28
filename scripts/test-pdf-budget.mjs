// PDF 深度读取额度：非主人每天 5 次、每 10 分钟 2 次；主人不限。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-pdf-budget-'));
process.env.DSH_HOME = HOME;
const { takePdfSlot, pdfBudgetStatus, budgetFile } = await import('../plugins/stellar/tools/lib/pdf/budget.mjs');

let pass = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

const base = new Date('2026-11-27T10:00:00+08:00').getTime();
await check('主人不限、不写状态', async () => {
  const r = takePdfSlot({ now: base, isOwner: true });
  assert.equal(r.ok, true);
  // guard 是同步执行守卫：返回 Promise 会让调用方读到 undefined 字段，
  // 2026-11-27 主人被限流就是这样来的（waitMs 变 NaN）。
  assert.equal(typeof r.then, 'undefined', 'takePdfSlot 必须是同步函数');
  assert.equal(fs.existsSync(budgetFile()), false);
});

await takePdfSlot({ now: base, isOwner: false });
await takePdfSlot({ now: base + 1000, isOwner: false });
const third = takePdfSlot({ now: base + 2000, isOwner: false });
await check('10 分钟窗口第 3 次拒绝', () => {
  assert.equal(third.window, true);
  assert.equal(Number.isFinite(third.waitMs), true, '窗口拒绝必须带有限 waitMs（否则文案出现 NaN）');
});

const later = base + 11 * 60 * 1000;
await takePdfSlot({ now: later, isOwner: false });
await takePdfSlot({ now: later + 1000, isOwner: false });
const windowSixth = await takePdfSlot({ now: later + 2000, isOwner: false });
await check('窗口内的第 3 次拒绝', () => assert.equal(windowSixth.window, true));
await takePdfSlot({ now: later + 11 * 60 * 1000, isOwner: false });
const sixth = await takePdfSlot({ now: later + 11 * 60 * 1000 + 1000, isOwner: false });
await check('每天第 6 次拒绝', () => assert.equal(sixth.daily, true));

await check('状态文件可读且计数正确', () => {
  const s = JSON.parse(fs.readFileSync(budgetFile(), 'utf8'));
  assert.equal(s.allowed.length, 5);
  assert.equal(pdfBudgetStatus({ now: later }).usedDaily, 5);
});

await check('次日重置', async () => {
  const nextDay = new Date('2026-11-28T09:00:00+08:00').getTime();
  const r = await takePdfSlot({ now: nextDay, isOwner: false });
  assert.equal(r.ok, true);
  assert.equal(pdfBudgetStatus({ now: nextDay }).usedDaily, 1);
});

console.log('\n' + pass + '/6 PASS');
if (pass !== 6) process.exitCode = 1;