// PDF 读额度守卫：主人按会话快照豁免；非主人 10 分钟 2 次，拒绝文案不能有 NaN。
// 2026-11-27 主人被限流的根因：takePdfSlot 是 async 而 guard 是同步执行守卫。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-pdf-guard-'));
process.env.DSH_HOME = HOME;

const CONTEXT_DIR = path.join(ROOT, 'state', 'turn-context');
const ownerKey = 'private:pdfguardowner' + process.pid;
const guestKey = 'private:pdfguardguest' + process.pid;
const safe = (k) => k.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
const ctxFile = (k) => path.join(CONTEXT_DIR, safe(k) + '.json');
const budgetFile = path.join(HOME, 'stellar', 'state', 'pdf-budget.json');

function writeContext(key, isOwner) {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(ctxFile(key), JSON.stringify({
    key, kind: 'private', isOwner, userId: key.split(':')[1] || '', at: Date.now(),
  }), 'utf8');
}

let pass = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

const mod = await import(pathToFileURL(path.join(ROOT, 'plugins', 'stellar', 'qq-tool-restrict.mjs')).href);
const fakeTools = { restrict() {}, guard(fn) { this._guard = fn; } };
mod.apply({ tools: fakeTools });
const guard = (key) => fakeTools._guard({
  name: 'mcp__snowluma__stellar_pdf',
  arguments: { key, action: 'read', chapter: 7 },
});

try {
  writeContext(ownerKey, true);
  check('主人私聊读 PDF 不限、不写额度文件', () => {
    assert.equal(guard(ownerKey), undefined);
    assert.equal(fs.existsSync(budgetFile), false);
  });

  writeContext(guestKey, false);
  check('非主人前两次放行', () => {
    assert.equal(guard(guestKey), undefined);
    assert.equal(guard(guestKey), undefined);
  });
  check('非主人 10 分钟内第 3 次拒绝且文案可行动', () => {
    const denied = guard(guestKey);
    assert.equal(typeof denied, 'string');
    assert.match(denied, /PDF 读得太频繁/);
    assert.doesNotMatch(denied, /NaN/);
    assert.match(denied, /大约 \d+ 分钟后能再读/);
  });
  check('额度文件用临时 DSH_HOME，不污染真实状态', () => {
    const state = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    assert.equal(state.allowed.length, 2);
  });
} finally {
  for (const key of [ownerKey, guestKey]) {
    try { fs.unlinkSync(ctxFile(key)); } catch { /* ignore */ }
  }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n' + pass + '/4 PASS');
if (pass !== 4) process.exitCode = 1;
