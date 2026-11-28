// 绘图额度：非主人 20/天、10/10 分钟；主人不限且不写状态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-diagram-budget-'));
process.env.DSH_HOME = home;
const { takeDiagramSlot, budgetStatus, budgetFile } = await import('../plugins/stellar/lib/diagram-budget.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (error) { failures += 1; console.error('FAIL ' + name + ': ' + error.message); }
}

const day = new Date(2026, 10, 26, 12, 0, 0).getTime(); // 本地时间 2026-11-26 12:00
try {
  check('主人不限，且不创建状态文件', () => {
    const r = takeDiagramSlot({ now: day, isOwner: true });
    assert.equal(r.ok, true);
    assert.equal(r.owner, true);
    assert.equal(fs.existsSync(budgetFile()), false);
  });

  check('前 10 张放行，第 11 张在窗口内拒绝', () => {
    for (let i = 0; i < 10; i += 1) {
      const r = takeDiagramSlot({ now: day + i, isOwner: false });
      assert.equal(r.ok, true, '第 ' + (i + 1) + ' 张应放行');
      assert.equal(r.remainingDaily, 19 - i);
    }
    const r = takeDiagramSlot({ now: day + 10, isOwner: false });
    assert.equal(r.ok, false);
    assert.equal(r.window, true);
    assert.equal(r.daily, false);
    assert.ok(r.waitMs > 9 * 60 * 1000 && r.waitMs <= 10 * 60 * 1000);
  });

  check('窗口过后再放 10 张，当日第 21 张按日额度拒绝', () => {
    const t = day + 11 * 60 * 1000;
    for (let i = 0; i < 10; i += 1) assert.equal(takeDiagramSlot({ now: t + i, isOwner: false }).ok, true);
    const r = takeDiagramSlot({ now: t + 20, isOwner: false });
    assert.equal(r.ok, false);
    assert.equal(r.daily, true);
    assert.ok(r.waitMs > 0);
    assert.equal(budgetStatus(t + 20).dailyUsed, 20);
  });

  check('主人额度用尽后仍然放行', () => {
    const r = takeDiagramSlot({ now: day + 30 * 60 * 1000, isOwner: true });
    assert.equal(r.ok, true);
  });

  check('次日 0 点后重置', () => {
    const next = new Date(2026, 10, 27, 0, 1, 0).getTime();
    const r = takeDiagramSlot({ now: next, isOwner: false });
    assert.equal(r.ok, true);
    assert.equal(r.remainingDaily, 19);
  });
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}

if (failures) { console.error('\n' + failures + ' 项失败'); process.exit(1); }
console.log('\n✅ 绘图额度通过');
