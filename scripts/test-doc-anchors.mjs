#!/usr/bin/env node
// 文档锚点门禁的自测：用一个临时小仓库验证「该拦的拦、该放的放」。
// 为什么要有它：门禁本身坏了（永远 exit 0）比没有门禁更糟 —— 它会让所有人以为锚点是活的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'check-doc-anchors.mjs');

function makeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function run(root, extra = []) {
  const r = spawnSync(process.execPath, [script, '--root', root, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 1) 干净的锚点：文件存在、不带行号 → strict 也通过
{
  const root = makeRoot({
    'src/a.js': 'export function alpha() {}\n',
    'docs/x.md': '看 src/a.js 的 alpha()。\n'
  });
  const r = run(root, ['--strict']);
  assert.equal(r.code, 0, '干净仓库应当通过：' + r.out);
  assert.match(r.out, /没有错误/);
  fs.rmSync(root, { recursive: true, force: true });
}

// 2) 行号锚点 → strict 失败、非 strict 只警告（给存量文档留迁移期）
{
  const root = makeRoot({
    'src/a.js': 'line1\nline2\n',
    'docs/x.md': '见 src/a.js:2 那段。\n'
  });
  const strict = run(root, ['--strict']);
  assert.equal(strict.code, 1, 'strict 应当拦住行号锚点');
  assert.match(strict.out, /行号锚点易漂移/);
  const loose = run(root);
  assert.equal(loose.code, 0, '非 strict 不应失败（否则老文档全红）');
  assert.match(loose.out, /警告 1 条/);
  fs.rmSync(root, { recursive: true, force: true });
}

// 3) 行号越界 → 一律失败（这条不是风格问题，是锚点已经指到文件外）
{
  const root = makeRoot({
    'src/a.js': 'only-one-line\n',
    'docs/x.md': '见 src/a.js:99。\n'
  });
  const r = run(root);
  assert.equal(r.code, 1, '越界行号必须失败');
  assert.match(r.out, /行号超出文件行数/);
  fs.rmSync(root, { recursive: true, force: true });
}

// 4) 代码目录里的路径不存在 → strict 失败；运行期路径（state/）只提示
{
  const root = makeRoot({
    'docs/x.md': '见 src/gone.js 与 state/runtime.json。\n'
  });
  const strict = run(root, ['--strict']);
  assert.equal(strict.code, 1, 'strict 应当拦住代码目录的失效路径');
  assert.match(strict.out, /src\/gone\.js/);
  assert.doesNotMatch(strict.out, /✗ .*state\/runtime\.json/);
  fs.rmSync(root, { recursive: true, force: true });
}

// 5) 白名单豁免（本来就不入库的本地文件）
{
  const root = makeRoot({
    'scripts/doc-anchor-allow.txt': 'scripts/local-only.json\n',
    'docs/x.md': '规则在 scripts/local-only.json。\n'
  });
  const r = run(root, ['--strict']);
  assert.equal(r.code, 0, '白名单里的路径不该报错：' + r.out);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('文档锚点门禁：5 组断言通过（干净通过 / 行号锚点 strict 拦 / 越界拦 / 失效代码路径拦 / 白名单豁免）');
