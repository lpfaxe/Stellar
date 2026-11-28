/**
 * 夜间电源开关（2026-11-27 主人：晚上不用她，让她关掉或者休眠，但这个开关要装在控制台）。
 *
 * 这里钉住四件事：
 *   1. 默认 23:50 睡眠 / 06:05 唤醒，坏时间不会被写进计划；
 *   2. 保存 = 写计划文件 + 注册/删除计划任务；测试走 STELLAR_POWER_DRY=1，不碰真实任务、不睡；
 *   3. 休眠没启用时明确拒绝，不偷偷改注册表；
 *   4. 面板接线在：GET /api/power、POST /api/power、POST /api/power/now，且都过 requireWrite。
 *
 * 跑法：node scripts/test-panel-power.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelRoots = ['../stellar-manager', '../../stellar-manager'].map((rel) => path.resolve(here, rel));
const panelRoot = panelRoots.find((dir) => fs.existsSync(path.join(dir, 'lib', 'power-plan.js')));
if (!panelRoot) {
  console.log('SKIP 夜间电源：这个仓库布局里找不到 stellar-manager/lib/power-plan.js');
  process.exit(0);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-power-test-'));
process.env.DSH_HOME = tmpHome;
process.env.STELLAR_POWER_DRY = '1';
process.on('exit', () => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

const mod = await import(pathToFileURL(path.join(panelRoot, 'lib', 'power-plan.js')).href);
const { DEFAULT_PLAN, PLAN_FILE, normalizePlan, nextRuns, readPowerPlan, savePowerPlan, sleepNow } = mod;

const serverSrc = fs.readFileSync(path.join(panelRoot, 'server.mjs'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(panelRoot, 'public', 'index.html'), 'utf8');
const bootSrc = fs.readFileSync(path.join(panelRoot, 'public', 'js', 'boot.js'), 'utf8');
const powerSrc = fs.readFileSync(path.join(panelRoot, 'public', 'js', 'power.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(panelRoot, 'public', 'style.css'), 'utf8');

test('默认值与坏值：23:50 / 06:05 / sleep，enabled 只认 true', () => {
  // 任务名是所有权边界：原 Stellar Morning Wake 是更早的 06:00 保活任务，绝不能被这个开关占用。
  assert.equal(mod.SLEEP_TASK, 'Stellar Night Sleep');
  assert.equal(mod.WAKE_TASK, 'Stellar Night Wake');
  assert.notEqual(mod.WAKE_TASK, 'Stellar Morning Wake');
  assert.deepEqual(DEFAULT_PLAN, { version: 1, enabled: false, sleepAt: '23:50', wakeAt: '06:05', mode: 'sleep', updatedAt: '', updatedBy: '' });
  const a = normalizePlan({});
  assert.equal(a.sleepAt, '23:50');
  assert.equal(a.wakeAt, '06:05');
  assert.equal(a.mode, 'sleep');
  const b = normalizePlan({ enabled: 'yes', sleepAt: '25:00', wakeAt: '6:5', mode: 'nap' });
  assert.equal(b.enabled, false, 'enabled 必须严格 === true');
  assert.equal(b.sleepAt, '23:50', '坏时间回默认');
  assert.equal(b.wakeAt, '06:05');
  assert.equal(b.mode, 'sleep');
});

test('nextRuns：今晚睡、明早醒，唤醒总在睡眠之后', () => {
  const from = new Date(2026, 10, 27, 15, 0, 0);
  const r = nextRuns({ sleepAt: '23:50', wakeAt: '06:05' }, from);
  const sleep = new Date(r.sleepAt);
  const wake = new Date(r.wakeAt);
  assert.equal(sleep.getHours(), 23);
  assert.equal(sleep.getMinutes(), 50);
  assert.equal(wake.getHours(), 6);
  assert.equal(wake.getMinutes(), 5);
  // 6 小时 15 分钟：只要跨了一个本地日、且不是同一时刻就算对（不手算月末日期）
  const gap = wake.getTime() - sleep.getTime();
  assert.ok(gap >= 6 * 3600 * 1000 && gap <= 7 * 3600 * 1000, '睡眠到唤醒应约 6 小时 15 分，实际 ' + gap);
});

test('保存启用：写计划文件；关闭：计划文件变 disabled', async () => {
  const on = await savePowerPlan({ enabled: true, sleepAt: '23:40', wakeAt: '06:10', mode: 'sleep' }, { by: 'test' });
  assert.equal(on.plan.enabled, true);
  assert.equal(on.plan.sleepAt, '23:40');
  assert.equal(on.plan.wakeAt, '06:10');
  assert.equal(on.plan.updatedBy, 'test');
  assert.equal(on.dryRun, true);
  const saved = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  assert.equal(saved.enabled, true);
  assert.equal(saved.sleepAt, '23:40');
  assert.equal(readPowerPlan().wakeAt, '06:10');

  const off = await savePowerPlan({ enabled: false }, { by: 'test' });
  assert.equal(off.plan.enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')).enabled, false);
});

test('坏输入明确拒绝：同一分钟 / 非法时间 / 没启用的休眠', async () => {
  await assert.rejects(() => savePowerPlan({ enabled: true, sleepAt: '23:50', wakeAt: '23:50' }), /同一分钟/);
  await assert.rejects(() => savePowerPlan({ enabled: true, sleepAt: '24:00', wakeAt: '06:05' }), /睡眠时间/);
  await assert.rejects(() => savePowerPlan({ enabled: true, sleepAt: '23:50', wakeAt: '6:05' }), /唤醒时间/);
  await assert.rejects(() => savePowerPlan({ enabled: true, mode: 'hibernate' }), /休眠没启用/);
});

test('立即睡眠：dry-run 只记录，不真的睡', async () => {
  const r = await sleepNow({ mode: 'sleep', by: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.mode, 'sleep');
  await assert.rejects(() => sleepNow({ mode: 'hibernate' }), /休眠没启用/);
});

test('面板接线：三个路由都在 requireWrite 之后，审计与日志都有', () => {
  const getAt = serverSrc.indexOf("url.pathname === '/api/power' && req.method === 'GET'");
  assert.ok(getAt > 0, '没找到 GET /api/power');
  const getBlock = serverSrc.slice(getAt, getAt + 420);
  assert.match(getBlock, /powerStatus\(\)/);
  assert.match(getBlock, /canWrite: scope !== 'public'/);

  const postAt = serverSrc.indexOf("url.pathname === '/api/power' && req.method === 'POST'");
  assert.ok(postAt > 0, '没找到 POST /api/power');
  const postBlock = serverSrc.slice(postAt, postAt + 1400);
  assert.match(postBlock, /if \(!requireWrite\(req, res\)\) return/);
  assert.match(postBlock, /await savePowerPlan\(/);
  assert.match(postBlock, /appendAudit\('power-plan'/);
  assert.match(postBlock, /appendAudit\('power-plan-rejected'/);
  assert.match(postBlock, /logEvent\('power-plan'/);

  const nowAt = serverSrc.indexOf("url.pathname === '/api/power/now' && req.method === 'POST'");
  assert.ok(nowAt > 0, '没找到 POST /api/power/now');
  const nowBlock = serverSrc.slice(nowAt, nowAt + 900);
  assert.match(nowBlock, /if \(!requireWrite\(req, res\)\) return/);
  assert.match(nowBlock, /await sleepNow\(/);
  assert.match(nowBlock, /appendAudit\('power-now'/);
  assert.match(nowBlock, /3 秒后进入/);
});

test('前端：开关、两个时间、方式、保存与立即睡眠都在，脚本已挂', () => {
  for (const id of ['powerEnabled', 'powerSleepAt', 'powerWakeAt', 'powerMode', 'powerSave', 'powerNow', 'powerState', 'powerHint', 'powerMsg']) {
    assert.match(htmlSrc, new RegExp('id="' + id + '"'), '缺少 #' + id);
  }
  assert.match(htmlSrc, /<script src="\/js\/power\.js"><\/script>/);
  assert.match(bootSrc, /loadPower/);
  assert.match(bootSrc, /every\(120000, function \(\) \{ if \(window\.loadPower\) loadPower\(\); \}\)/);
  assert.match(powerSrc, /api\('\/api\/power'\)/);
  assert.match(powerSrc, /method: 'POST'/);
  assert.match(powerSrc, /\/api\/power\/now/);
  assert.match(powerSrc, /3 秒后/);
  assert.match(powerSrc, /confirm\(/);
  assert.match(cssSrc, /\.power-box/);
});
