/**
 * 公网来源也能「重启 DSH」（2026-11-25 主人：在外面不方便重启）。
 *
 * 面板原本对公网（Cloudflare 隧道 / 公网 IPv6）一律 403 readonly-public，
 * 于是人不在家时连重启都得回家点。这次只开一个动作，不动 requireWrite 的默认拒绝。
 *
 * 三条不变量在这里钉住：
 *   1. 公网放行的动作只有 restart-dsh，别的仍然拒；
 *   2. 本机/局域网不受影响（照旧全放行）；
 *   3. 公网重启有 60 秒冷却，冷却只对「真的触发过重启的那个来源」生效。
 *
 * 跑法：node scripts/test-panel-remote-restart.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelRoots = ['../stellar-manager', '../../stellar-manager'].map((rel) => path.resolve(here, rel));
const panelRoot = panelRoots.find((dir) => fs.existsSync(path.join(dir, 'lib', 'remote-restart.js')));
if (!panelRoot) {
  console.log('SKIP 公网重启 DSH：这个仓库布局里找不到 stellar-manager/lib/remote-restart.js');
  process.exit(0);
}

const mod = await import(pathToFileURL(path.join(panelRoot, 'lib', 'remote-restart.js')).href);
const { REMOTE_ACTION_ALLOW, REMOTE_RESTART_GAP_MS, noteRemoteWrite, remoteActionAllowed, remoteWriteDecision, resetRemoteWriteState } = mod;

const serverSrc = fs.readFileSync(path.join(panelRoot, 'server.mjs'), 'utf8');
const clockSrc = fs.readFileSync(path.join(panelRoot, 'public', 'js', 'clock.js'), 'utf8');
const statusSrc = fs.readFileSync(path.join(panelRoot, 'public', 'js', 'status.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(panelRoot, 'public', 'index.html'), 'utf8');

test('白名单只认 restart-dsh', () => {
  assert.deepEqual([...REMOTE_ACTION_ALLOW], ['restart-dsh']);
  assert.equal(remoteActionAllowed('restart-dsh'), true);
  for (const act of ['stop', 'resume', 'qzone', 'set-passphrase', 'replan', 'keepalive', 'start-snowluma', 'tunnel-start', 'report-request', '']) {
    assert.equal(remoteActionAllowed(act), false, act + ' 不该被公网放行');
  }
  // 近似名不能被当成那个动作
  for (const act of ['restart', 'restart-dsh ', 'RESTART-DSH', 'restart-dsh2']) {
    assert.equal(remoteActionAllowed(act), false, act + ' 不该被公网放行');
  }
});

test('本机与局域网照旧全放行', () => {
  for (const scope of ['local', 'lan']) {
    for (const act of ['restart-dsh', 'stop', 'qzone']) {
      const r = remoteWriteDecision({ action: act, scope, ip: '10.0.0.2' });
      assert.equal(r.ok, true, scope + '/' + act);
    }
  }
});

test('公网：restart-dsh 放行，其余动作 readonly-public', () => {
  resetRemoteWriteState();
  const ok = remoteWriteDecision({ action: 'restart-dsh', scope: 'public', ip: '1.2.3.4', now: 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.note, 'public-restart');
  const bad = remoteWriteDecision({ action: 'stop', scope: 'public', ip: '1.2.3.4', now: 1000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'readonly-public');
  assert.match(bad.message, /重启 DSH/);
});

test('公网重启 60 秒冷却，按来源分开算', () => {
  resetRemoteWriteState();
  const t0 = 1_800_000_000_000;
  assert.equal(remoteWriteDecision({ action: 'restart-dsh', scope: 'public', ip: '9.9.9.9', now: t0 }).ok, true);
  noteRemoteWrite({ action: 'restart-dsh', scope: 'public', ip: '9.9.9.9', ok: true });
  const again = remoteWriteDecision({ action: 'restart-dsh', scope: 'public', ip: '9.9.9.9', now: Date.now() + 1000 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'too-frequent');
  assert.match(again.message, /秒后才能再点/);
  // 另一个来源不受影响
  assert.equal(remoteWriteDecision({ action: 'restart-dsh', scope: 'public', ip: '8.8.8.8', now: Date.now() + 1000 }).ok, true);
  // 本机不受公网冷却影响
  assert.equal(remoteWriteDecision({ action: 'restart-dsh', scope: 'local', ip: '9.9.9.9', now: Date.now() + 1000 }).ok, true);
  // 冷却窗口就是常量本身，不是随手写的数字
  assert.equal(REMOTE_RESTART_GAP_MS, 60_000);
  resetRemoteWriteState();
});

test('只有「公网 + 真的重启成功」才写冷却', () => {
  resetRemoteWriteState();
  // 本机成功：不写冷却（公网的冷却表不该被本机污染）
  noteRemoteWrite({ action: 'restart-dsh', scope: 'local', ip: '7.7.7.7', ok: true });
  assert.equal(remoteWriteDecision({ action: 'restart-dsh', scope: 'public', ip: '7.7.7.7', now: Date.now() + 500 }).ok, true);
  // 公网但失败（比如 DSH 找不到）：不写冷却，否则一次失败会把人挡在外面一分钟
  noteRemoteWrite({ action: 'restart-dsh', scope: 'public', ip: '6.6.6.6', ok: false });
  assert.equal(remoteWriteDecision({ action: 'restart-dsh', scope: 'public', ip: '6.6.6.6', now: Date.now() + 500 }).ok, true);
  // 公网且不在白名单的动作：什么都不记
  noteRemoteWrite({ action: 'stop', scope: 'public', ip: '5.5.5.5', ok: true });
  assert.equal(remoteWriteDecision({ action: 'restart-dsh', scope: 'public', ip: '5.5.5.5', now: Date.now() + 500 }).ok, true);
  resetRemoteWriteState();
});

test('server.mjs 接线：先读 body 再判公网，restart-dsh 单独记审计', () => {
  const actionAt = serverSrc.indexOf("url.pathname === '/api/action'");
  assert.ok(actionAt > 0, '没找到 /api/action 分支');
  const block = serverSrc.slice(actionAt, actionAt + 2200);
  // 顺序很关键：requireWrite 对公网会直接 return，所以必须先读 body 才能知道 action 是什么
  assert.match(block, /const body = await readBody\(req\)/);
  assert.match(block, /remoteWriteDecision\(\{ action: String\(body\.action \|\| ''\), scope: scopeNow, ip: clientIp\(req\) \}\)/);
  assert.match(block, /if \(!decision\.ok\)/);
  assert.match(block, /code: decision\.code/);
  assert.match(block, /noteRemoteWrite\(\{ action, scope: scopeNow, ip: clientIp\(req\), by: 'panel', ok: Boolean\(result && result\.ok\) \}\)/);
  // 默认拒绝必须还在：别的写路由仍然靠 requireWrite
  assert.match(serverSrc, /if \(!requireWrite\(req, res\)\) return/);
});

test('/api/status 告诉前端「重启能不能点」', () => {
  assert.match(serverSrc, /canRestartDsh: true/);
  assert.match(serverSrc, /remoteActions: \['restart-dsh'\]/);
  assert.match(statusSrc, /s\.access\.canRestartDsh !== false/);
  assert.match(htmlSrc, /id="actScopeNote"/);
  assert.match(clockSrc, /公网操作：这条是故意放行的/);
});
