/**
 * 这一条依赖 stellar-manager（控制台，端口 3300）的源码做源码级断言。
 * 公开仓库**不发布**控制台目录，所以这里先探测：缺了就跳过（打印原因并以 0 退出），
 * 有就照常跑。真实仓库里 stellar-manager 与 stellar 同级，6 条断言全部生效。
 */
import fsProbe from 'node:fs';
import pathProbe from 'node:path';
import { fileURLToPath as urlProbe } from 'node:url';
const scriptsDir = pathProbe.dirname(urlProbe(import.meta.url));
// 控制台源码的两个候选位置：仓库自己那份（发布仓库里是最小控制台，没有 lib/auth.js），
// 以及「stellar 与 stellar-manager 同级」的完整部署布局。先看前者，避免发布仓库里
// 因为机器上碰巧存在 ../stellar-manager 就把断言跑到别人家的目录上。
const repoRoot = pathProbe.resolve(scriptsDir, '..');
// 先认**本仓库自己的** stellar-manager（存在就用它，不管里面是完整面板还是最小控制台），
// 只有本仓库里根本没有这个目录时，才回退到「stellar 与 stellar-manager 同级」的完整部署布局。
// 这样发布仓库不会因为开发机上碰巧有 ../stellar-manager 就把断言跑到别人的目录里。
const ownManager = pathProbe.join(repoRoot, 'stellar-manager');
const siblingManager = pathProbe.resolve(repoRoot, '..', 'stellar-manager');
const panelRoot = (() => {
  try { if (fsProbe.statSync(ownManager).isDirectory()) return ownManager; } catch {}
  return siblingManager;
})();
// 公开仓库里 stellar-manager 只是一个空占位（仅 README.md），所以判定的是「有没有控制台源码」：
// server.mjs 与 lib/auth.js 是这批断言真正要读的两个文件，缺一个就跳过。
const panelSrc = (() => {
  try {
    return fsProbe.existsSync(pathProbe.join(panelRoot, 'server.mjs'))
      && fsProbe.existsSync(pathProbe.join(panelRoot, 'lib', 'auth.js'));
  } catch { return false; }
})();
if (!panelSrc) {
  console.log('SKIP 敏感文件 ACL 收紧：仓库自带的 stellar-manager 是最小控制台（只有 server.mjs，没有 lib/auth.js）；这条断言的是完整面板，只在完整部署里跑');
  process.exit(0);
}
// 回归（2026-11-13）：敏感文件写完必须重新收紧 ACL。
//
// 事故：stellar/config.json 手工 icacls 加固（去掉 Authenticated Users:M）之后，桥接每次
// 回写 dsh.baseUrl 都走 atomicWriteJson（临时文件 + rename）→ rename 出来的是**新文件**，
// DACL 从父目录继承，加固就悄悄退回「任何本机账户可改 consoleToken/ownerQQ」。
// 这条测试钉住三件事：敏感名判定、非敏感不跑 icacls、收紧后 isHardened 为真。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  hardenSensitiveFile,
  isHardened,
  isSensitiveFile,
  resolveAclUser,
  SENSITIVE_BASENAMES
} from '../src/state-acl.mjs';

const fixtureDirs = [];
test.after(() => {
  for (const dir of fixtureDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-acl-'));
  fixtureDirs.push(root);
  return root;
}

test('resolveAclUser 在环境变量缺失时回退到 os.userInfo（DSH 子进程里 %USERNAME% 会空）', () => {
  const saved = process.env.USERNAME;
  try {
    delete process.env.USERNAME;
    const name = resolveAclUser();
    assert.ok(name.length > 0, '回退后仍要拿到一个用户名');
    assert.equal(name, String(os.userInfo().username));
    process.env.USERNAME = 'UnitTestUser';
    assert.equal(resolveAclUser(), 'UnitTestUser', '有环境变量时优先用它');
  } finally {
    if (saved === undefined) delete process.env.USERNAME; else process.env.USERNAME = saved;
  }
});

test('敏感文件白名单就这几个名字，且大小写不敏感', () => {
  // 2026-11-13 加第 4 项：cloudflare-tunnel-token.txt 是能把隧道带进账号的凭据
  // 2026-11-16 加第 5 项：panel-sessions.json 里是面板会话 sid（读到就能冒充已登录）
  // 2026-11-21 加第 6/7 项（安全审计 S11）：小镇插件的 settings.json 里有 fbo_ 访问码，
  // town.db 是她在镇上的私事（谁来过、说过什么）——两者都只该当前账户能读。
  assert.deepEqual([...SENSITIVE_BASENAMES].sort(), ['bili.config.json', 'cloudflare-tunnel-token.txt', 'config.json', 'panel-sessions.json', 'panel-token.txt', 'settings.json', 'town.db']);
  assert.equal(isSensitiveFile('C:\\x\\config.json'), true);
  assert.equal(isSensitiveFile('C:/x/PANEL-TOKEN.TXT'), true);
  assert.equal(isSensitiveFile('C:/x/bili.config.json'), true);
  assert.equal(isSensitiveFile('C:/x/Cloudflare-Tunnel-Token.txt'), true);
  assert.equal(isSensitiveFile('C:/x/settings.json'), true);
  assert.equal(isSensitiveFile('C:/x/state/town/town.db'), true);
  assert.equal(isSensitiveFile('C:/x/notes.json'), false);
  assert.equal(isSensitiveFile('C:/x/config.json.bak'), false);
  assert.equal(isSensitiveFile(''), false);
});

test('atomicWrite 之后的敏感文件：不收紧就带继承宽松项，收紧后 isHardened 为真', () => {
  const dir = fixture();
  const file = path.join(dir, 'config.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, '{}\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  // rename 出来的新文件继承父目录 DACL：这正是生产里加固被冲掉的那一步。
  if (process.platform === 'win32') {
    assert.equal(isHardened(file), false, 'rename 后应当还是继承来的宽松 ACL（用于证明下面那步是必要的）');
  }
  const result = hardenSensitiveFile(file);
  assert.equal(result.ok, true, '收紧应当成功：' + result.detail);
  assert.equal(isHardened(file), true, '收紧后不应再带继承 ACE 或宽松主体');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n', '收紧 ACL 不能动内容');
});

test('非敏感文件直接跳过，不跑 icacls', () => {
  const dir = fixture();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{}\n', 'utf8');
  const result = hardenSensitiveFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true, '白名单外应当 skipped，避免拖慢每次普通写');
});

test('两处 atomicWrite 都真的接了收紧（源码级钉子）', () => {
  // 只测 state-acl 本身不够：真正的回归是「有人删掉调用点」，那时代码照跑、ACL 照松。
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.ok(bridge.includes("import { hardenDir, hardenSensitiveFile, manualDirCommand } from './state-acl.mjs'"),
    'bridge.js 必须导入 hardenSensitiveFile');
  const calls = bridge.match(/hardenSensitiveFile\(file\)/g) ?? [];
  assert.equal(calls.length, 2, 'atomicWriteJson 与 atomicWriteText 各要调一次，实际 ' + calls.length);
  const panel = fs.readFileSync(pathProbe.join(panelRoot, 'lib', 'util.js'), 'utf8');
  assert.ok(panel.includes('hardenSensitiveFile(file)'), '面板的 atomicWriteJson 也要调');
  const auth = fs.readFileSync(pathProbe.join(panelRoot, 'lib', 'auth.js'), 'utf8');
  assert.ok(auth.includes('hardenSensitiveFile(TOKEN_FILE)'), '口令轮换写新 token 后也要收紧');
});
