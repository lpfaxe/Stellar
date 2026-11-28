// 预加载两阶段：create 不占额度、pick 才落盘、过期/超额清理。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmpBase = (() => {
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    const v = process.env[key];
    if (v && !String(v).startsWith('undefined')) return v;
  }
  const t = os.tmpdir();
  return t.includes('undefined') ? 'C:/Windows/Temp' : t;
})();
const TEST_HOME = fs.mkdtempSync(path.join(tmpBase, 'stellar-preload-'));
process.env.DSH_HOME = TEST_HOME;
process.on('exit', () => { try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preload = await import(pathToFileURL(path.join(ROOT, 'plugins', 'stellar', 'tools', 'lib', 'webimg', 'preload.mjs')).href);
const webImages = await import(pathToFileURL(path.join(ROOT, 'plugins', 'stellar', 'tools', 'lib', 'web-images.mjs')).href);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3eAAAAAElFTkSuQmCC', 'base64');
function makeImage(name) {
  const file = path.join(TEST_HOME, name);
  fs.writeFileSync(file, PNG);
  return { file, width: 1, height: 1, bytes: PNG.length, title: name, page: 'https://example.com/' + name, url: 'https://example.com/' + name + '.png' };
}
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); pass += 1; }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}
let pass = 0;

check('clampPreload 把 30–100 之外的值收进范围', () => {
  assert.equal(preload.clampPreload(0), 0);
  assert.equal(preload.clampPreload(10), 30);
  assert.equal(preload.clampPreload(100), 100);
  assert.equal(preload.clampPreload(200), 100);
});

const items = [makeImage('a.png'), makeImage('b.png')];
const built = preload.createPreload({ query: '测试', mode: 'photo', engine: 'baidu', items, stats: { candidates: 2 } });
check('createPreload 建会话、拼联系表、不写 web-images', () => {
  assert.ok(built.ok, built.error);
  assert.match(built.session, /^p-/);
  assert.ok(fs.existsSync(path.join(built.dir, 'manifest.json')));
  assert.ok(built.sheet && fs.existsSync(built.sheet), 'sheet=' + built.sheet);
  assert.ok(fs.statSync(built.sheet).size > 1000);
  assert.equal(webImages.listWebImages().images.length, 0);
  assert.equal(built.items.length, 2);
});

check('pick 只存选中的编号，并删掉预加载会话', () => {
  const r = preload.pickPreload(built.session, [2]);
  assert.ok(r.ok, r.error);
  assert.equal(r.items.length, 1);
  assert.ok(fs.existsSync(r.items[0].file));
  assert.equal(webImages.listWebImages().images.length, 1);
  assert.ok(!fs.existsSync(built.dir), 'session dir should be removed');
});

check('无效编号/超量 pick 拒绝且不清会话', () => {
  const b = preload.createPreload({ query: '测试2', mode: 'photo', engine: 'baidu', items: [makeImage('c.png')] });
  assert.ok(b.ok, b.error);
  const bad = preload.pickPreload(b.session, [99]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BAD_PICKS');
  assert.ok(fs.existsSync(b.dir));
  const tooMany = preload.pickPreload(b.session, [1, 2, 3, 4, 5, 6]);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'BAD_PICKS');
  const missing = preload.pickPreload('p-00000000-deadbeef', [1]);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PRELOAD_EXPIRED');
  fs.rmSync(b.dir, { recursive: true, force: true });
});

check('每天 30 张额度只在 pick 时检查', () => {
  webImages.clearWebImages({ by: 'test' });
  const small = makeImage('d.png');
  for (let i = 0; i < 29; i += 1) {
    const got = webImages.addWebImage(small.file, { origin: 'test', query: 'fill' });
    assert.ok(got.ok, got.reason);
  }
  assert.equal(webImages.listWebImages().images.length, 29);
  const b = preload.createPreload({ query: '额度', mode: 'photo', engine: 'baidu', items: [makeImage('e.png'), makeImage('f.png')] });
  assert.ok(b.ok, b.error);
  assert.equal(webImages.listWebImages().images.length, 29);
  const denied = preload.pickPreload(b.session, [1, 2]);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'DAILY_LIMIT');
  assert.ok(!denied.hint.includes('NaN'));
  fs.rmSync(b.dir, { recursive: true, force: true });
});

check('cleanupPreloads 清过期目录、保留新目录', () => {
  const keep = preload.createPreload({ query: '保留', mode: 'photo', engine: 'baidu', items: [makeImage('g.png')] });
  const root = preload.preloadRoot();
  const old = path.join(root, 'p-20260101-000000-aaaa');
  fs.mkdirSync(old, { recursive: true });
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(old, oldTime, oldTime);
  const r = preload.cleanupPreloads({ keep: keep.session });
  assert.ok(r.removed >= 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(keep.dir));
  fs.rmSync(keep.dir, { recursive: true, force: true });
});

console.log('\n' + pass + '/6 PASS');
if (pass !== 6) process.exitCode = 1;
