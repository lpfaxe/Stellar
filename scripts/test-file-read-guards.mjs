// 回归（2026-11-13）：stellar_file_read 的两道闸 —— 路径白名单 + URL 只许公网。
//
// 规则本身在 src/file-read-guard.js（单独成模块就是为了这里能直接 import 测）。
// 修前：path 只要 isAbsolute 就直接采信（能读 ~/.dsh/.credentials.yaml），url 直接 fetch
// （实测能打到 127.0.0.1:3300/api/status 拿到含明文口令的 200）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertReadableLocalPath, assertPublicHttpUrl, isPrivateAddress, fileReadRoots } from '../src/file-read-guard.js';

const fixtureRoots = [];
test.after(() => {
  for (const dir of fixtureRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-fileread-'));
  fixtureRoots.push(root);
  const workspace = path.join(root, 'ws');
  const stellar = path.join(workspace, 'stellar');
  const dshHome = path.join(root, 'dshhome');
  fs.mkdirSync(path.join(stellar, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dshHome, 'stellar'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'note.txt'), '工作区里的普通文本', 'utf8');
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-fixture', 'utf8');
  fs.writeFileSync(path.join(root, 'outside.txt'), '根外文件', 'utf8');
  return { root, workspace, stellar, dshHome, opts: { workspaceRoot: workspace, stellarRoot: stellar, dshHome } };
}

test('读工作区里的普通文件 → 放行', () => {
  const f = makeFixture();
  const real = assertReadableLocalPath('note.txt', f.opts);
  assert.equal(path.basename(real), 'note.txt');
});

test('密钥/凭据文件 → 拒绝（即使就在可读根里）', () => {
  const f = makeFixture();
  for (const name of ['.credentials.yaml', 'panel-token.txt', 'id_rsa', 'server.pem', '.env.local']) {
    const target = path.join(f.workspace, name);
    fs.writeFileSync(target, 'secret', 'utf8');
    assert.throws(() => assertReadableLocalPath(target, f.opts), /密钥|凭据/, name + ' 必须被拦');
  }
});

test('可读根之外 → 拒绝，并告诉它能读哪里', () => {
  const f = makeFixture();
  // fixture 建在系统临时目录下，而 tmpdir 本身是允许根（截图/落盘文件在那儿），
  // 所以要挑一个真的不在白名单里的路径：Windows 目录。
  const outside = path.join(process.env.SystemRoot || 'C:\\Windows', 'win.ini');
  assert.ok(fs.existsSync(outside), '样本文件必须真实存在，否则测的是「读不到」而不是「不在白名单」');
  assert.throws(() => assertReadableLocalPath(outside, f.opts), /不在可读范围内/);
  const roots = fileReadRoots(f.opts).map((r) => r.dir);
  assert.ok(roots.includes(fs.realpathSync(f.workspace)), '工作区应在白名单里');
  assert.ok(roots.includes(fs.realpathSync(path.join(f.dshHome, 'stellar'))), 'DSH 目录应在白名单里');
});

test('软链指向根外 → 按真实路径拒绝', () => {
  const f = makeFixture();
  const link = path.join(f.workspace, 'pretend.txt');
  try {
    fs.symlinkSync(path.join(f.root, 'outside.txt'), link);
    assert.throws(() => assertReadableLocalPath(link, f.opts), /不在可读范围内/);
  } catch (e) {
    // Windows 非管理员可能建不了软链：跳过而不是假通过
    if (e && e.code === 'EPERM') return;
    throw e;
  }
});

test('本机/内网 URL → 拒绝', async () => {
  for (const url of [
    'http://127.0.0.1:3300/api/status',
    'http://localhost:3100/api/status',
    'http://[::1]:3100/api/status',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.0.3:3300/api/status',
    'http://10.0.0.5/a.txt',
    'http://172.16.3.4/a.txt',
    'http://0.0.0.0:3300/',
    'file:///C:/Windows/win.ini',
    'http://printer.local/a.txt'
  ]) {
    await assert.rejects(() => assertPublicHttpUrl(url), /内网|本机|http\(s\)|合法/, url + ' 必须被拦');
  }
});

test('公网地址 → 放行', async () => {
  const ok = await assertPublicHttpUrl('http://93.184.216.34/files/a.txt');
  assert.match(ok, /^http:\/\/93\.184\.216\.34\/files\/a\.txt$/);
});

test('isPrivateAddress 覆盖各私有段与公网', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip + ' 应判为内网');
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1']) {
    assert.equal(isPrivateAddress(ip), false, ip + ' 应判为公网');
  }
});

// 接线检查：规则写对了但 MCP 侧没调用等于没修。
test('mcp-snowluma-safe.js 的 file_read 真的走了这两道闸', () => {
  const src = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ assertReadableLocalPath, assertPublicHttpUrl \} from '\.\/file-read-guard\.js';/);
  assert.match(src, /const abs = assertReadableLocalPath\(wantedPath,/);
  assert.match(src, /if \(!allowPrivate\) await assertPublicHttpUrl\(url\);/);
  assert.match(src, /fetchFileBuffer\(wantedUrl\)/, '模型传的 url 必须走默认（公网校验）分支');
  assert.match(src, /await fileDownloadUrl\(file, key, \{ allowOwnerFallback: isOwner \}\)/, 'OneBot 给的下载地址要能取到（群文件没有私聊取址接口）');
  assert.match(src, /\{ allowPrivate: true \}/, 'OneBot 给的下载地址允许本机端口');
});
