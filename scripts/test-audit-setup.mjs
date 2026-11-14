// Offline integration tests. Every setup invocation receives its own repository and DSH_HOME.
// QQ_BRIDGE_TEST_YAML_ROOT is only useful when auditing with an intentionally read-only
// node_modules tree; normal installs resolve the declared js-yaml dependency directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parserRoot = process.env.QQ_BRIDGE_TEST_YAML_ROOT || path.dirname(require.resolve('js-yaml/package.json'));
const yaml = (await import(pathToFileURL(path.join(parserRoot, 'dist/js-yaml.mjs')).href)).default;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-audit-setup-'));
// ComSpec 必须是反斜杠路径：宿主若注入 C:/Windows/System32/cmd.exe，cmd 一解析
// argv 就报「命令语法不正确」（连 cmd /c echo hi 都失败），夹具里跑 dsh.cmd 会
// 被伪装成「插件装不上」。真实 Windows 环境本来就是反斜杠，这里只是归一畸形值。
const winComspec = process.platform === 'win32'
  ? String(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe').replace(/\//g, '\\')
  : '';
let failures = 0;

// Node v24.12.0（本机 Windows + 中文路径）上 `fs.cpSync` 会在原生层直接崩进程：
// exit 3221226505 / 0xC0000409，stdout 与 stderr 都是空的，连 try/catch 都进不去。
// 同一份目录换成 ASCII 路径就正常，`fs/promises.cp` 与手写递归也都正常——只有同步 cpSync 崩。
// 仓库在 `C:\Desktop\...`，所以夹具复制一律走这个手写递归，别再改回 cpSync。
function copyTreeSync(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      copyTreeSync(path.join(from, entry.name), path.join(to, entry.name));
    }
    return;
  }
  fs.copyFileSync(from, to);
}
function fixture(name, patch = '') {
  const base = path.join(sandbox, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/setup-dsh.mjs'), path.join(repo, 'scripts/setup-dsh.mjs'));
  // setup-dsh.mjs 直接从仓库源生成 bundle patch，生成器必须一起进夹具。
  fs.copyFileSync(path.join(root, 'scripts/build-agent-preset-patches.mjs'), path.join(repo, 'scripts/build-agent-preset-patches.mjs'));
  // setup-dsh 现在用 dsh-locate 去找 DSH 自带的 CLI（桌面版 dsh.cmd 不在 PATH），也得进夹具。
  fs.copyFileSync(path.join(root, 'scripts/dsh-locate.mjs'), path.join(repo, 'scripts/dsh-locate.mjs'));
  copyTreeSync(path.join(root, 'dsh'), path.join(repo, 'dsh'));
  copyTreeSync(path.join(root, 'plugins'), path.join(repo, 'plugins'));
  copyTreeSync(parserRoot, path.join(repo, 'node_modules/js-yaml'));
  fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true });
  const patchFile = path.join(home, 'profiles/web/cordis.patch.yml');
  fs.writeFileSync(patchFile, patch);
  fs.writeFileSync(path.join(home, 'profiles/web/package.json'), JSON.stringify({
    name: 'fixture-profile', dependencies: { existing: '1.0.0' },
    dsh: { profile: { bundles: ['existing'] } },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { PATH: path.dirname(process.execPath), DSH_HOME: home, HOME: home, USERPROFILE: home, QQ_BRIDGE_SKIP_DSH_INSTALL: '1' });
  // ComSpec 必须是反斜杠路径：正斜杠的 cmd.exe 一解析 argv 就报「命令语法不正确」。
  if (process.platform === 'win32') env.ComSpec = winComspec;
  const run = (profile = 'web', extraEnv = {}) => spawnSync(process.execPath, [path.join(repo, 'scripts/setup-dsh.mjs'), profile], {
    env: { ...env, ...extraEnv }, cwd: repo, encoding: 'utf8', timeout: 15000,
  });
  return { repo, home, patchFile, run };
}

function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  test('shared inserts, quoted IDs, flow YAML and unrelated nested arrays survive repeat setup', () => {
    const source = `# user patch\n- insert:\n    - id: mcp-snowluma\n      name: old\n    - id: custom\n      name: custom-plugin\n      config:\n        empty:\n          []\n        nested:\n          - id: mcp-snowluma-host\n            value: keep\n- insert:\n    - id: 'mcp-snowluma-host' # previous setup\n      name: old\n- {insert: [{id: mcp-web-search-safe, name: old}]}\n`;
    const f = fixture('structured', source);
    const originalCustom = yaml.load(source)[0].insert[1];
    for (let i = 0; i < 2; i++) {
      const result = f.run();
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const doc = yaml.load(fs.readFileSync(f.patchFile, 'utf8'));
      const entries = doc.flatMap((op) => op.insert || []);
      assert.deepEqual(entries.find((entry) => entry.id === 'custom'), originalCustom);
      for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
        assert.equal(entries.filter((entry) => entry.id === id).length, 1, `${id} duplicate`);
      }
      assert.equal(entries.find((entry) => entry.id === 'mcp-snowluma').config.toolCallTimeoutMs, 725000);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(f.home, 'profiles/web/package.json')));
    assert.equal(pkg.dependencies.existing, '1.0.0');
    assert.deepEqual(pkg.dsh.profile.bundles, ['existing', 'stellar']);
    assert.ok(
      fs.readdirSync(path.join(f.home, 'profiles/web')).some((name) => name.startsWith('package.json.bak-')),
      '写 profile package.json 前必须留备份',
    );
  });

  test('legacy root [] is repaired without altering literal strings', () => {
    const f = fixture('legacy', `[]\n- insert:\n    - id: custom\n      name: custom\n      config:\n        text: |\n          []\n          keep me\n`);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(yaml.load(fs.readFileSync(f.patchFile, 'utf8'))[0].insert[0].config.text, '[]\nkeep me\n');
  });

  test('malformed patch fails before replacing user configuration or presets', () => {
    const source = '- insert: [broken\n';
    const f = fixture('malformed', source);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(f.patchFile, 'utf8'), source);
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false);
  });

  test('profile traversal is rejected before filesystem changes', () => {
    const f = fixture('traversal');
    const result = f.run('../../escape');
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'escape')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false);
  });

  test('existing mode, DSH settings and non-link plugin directory remain untouched', () => {
    const f = fixture('preserve', '[]\n');
    fs.mkdirSync(path.join(f.repo, 'state'), { recursive: true });
    const mode = '{"mode":"closed-agent","closedAgentPreset":"custom"}\n';
    fs.writeFileSync(path.join(f.repo, 'state/mode.json'), mode);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.repo, 'state/mode.json'), 'utf8'), mode);
    const blocker = fixture('plugin-conflict', '[]\n');
    fs.mkdirSync(path.join(blocker.home, 'plugins/stellar'), { recursive: true });
    fs.writeFileSync(path.join(blocker.home, 'plugins/stellar/keep.txt'), 'keep');
    assert.notEqual(blocker.run().status, 0);
    assert.equal(fs.readFileSync(path.join(blocker.home, 'plugins/stellar/keep.txt'), 'utf8'), 'keep');
  });

  // 这条要真起 cmd.exe 去跑 dsh.cmd。跑测试的宿主若没给 ComSpec/PATH（例如 DSH 的
  // PTC run_code 里 process.env 是空的），setup-dsh.mjs 会拿到 ENOENT，边界就测不成。
  // 那种情况下跳过并说明原因，别让整条基线被环境假失败钉死。
  //
  // 光有 ComSpec 也不算数：宿主给的 ComSpec 可能是**正斜杠**路径
  // （C:/Windows/System32/cmd.exe）。那样 spawn 起得来，但 cmd 解析 argv 时会报
  // 「命令语法不正确」——连 cmd /c echo hi 都失败（反斜杠路径才正常）。所以这里
  // ① 把 ComSpec 归一成反斜杠（真实 Windows 环境里本来就是反斜杠，斜杠是宿主注入的
  //   畸形值，夹具修正它是合理的）；② 真跑一次最小命令探活，探不通才跳过——否则
  // 失败原因会伪装成「setup-dsh 装不上」，把人引去查插件安装。
  function cmdShimUsable() {
    if (process.platform !== 'win32' || !winComspec) return false;
    const r = spawnSync(winComspec, ['/d', '/c', 'echo ok'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return r.status === 0 && String(r.stdout || '').trim() === 'ok';
  }
  const canSpawnCmdShim = cmdShimUsable();
  if (process.platform === 'win32' && !canSpawnCmdShim) {
    console.log('SKIP Windows runs the npm .cmd shim: 宿主起不了可用的 cmd.exe（ComSpec 缺失或不可执行），边界测不成');
  }
  if (canSpawnCmdShim) test('Windows runs the npm .cmd shim with literal profile arguments', () => {
    const f = fixture('windows-cli');
    const bin = path.join(f.repo, 'bin');
    fs.mkdirSync(bin);
    const capture = path.join(bin, 'called.json');
    const cli = path.join(bin, 'fake-dsh.mjs');
    fs.writeFileSync(cli, `import fs from 'node:fs'; fs.writeFileSync(process.env.QQ_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), home: process.env.DSH_HOME}));\n`);
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    const profile = 'test&name%CD%!';
    const result = f.run(profile, {
      PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
      QQ_BRIDGE_SKIP_DSH_INSTALL: '0', QQ_TEST_CAPTURE: capture,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(capture), `CLI was not invoked: ${result.stdout}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)), { args: ['plugin', '--profile', profile, 'install'], home: f.home });
  });

  if (process.platform === 'win32') test('install that trims bundles rolls profile back to backup', () => {
    const f = fixture('rollback');
    const bin = path.join(f.repo, 'bin');
    fs.mkdirSync(bin);
    const cli = path.join(bin, 'trim-dsh.mjs');
    fs.writeFileSync(cli, `import fs from 'node:fs'; import path from 'node:path';
const file = path.join(process.env.DSH_HOME, 'profiles', 'web', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.dsh.profile.bundles = ['existing'];
fs.writeFileSync(file, JSON.stringify(pkg));
`);
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    const result = f.run('web', {
      PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
      QQ_BRIDGE_SKIP_DSH_INSTALL: '0',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /已回滚 profile/);
    const pkg = JSON.parse(fs.readFileSync(path.join(f.home, 'profiles/web/package.json'), 'utf8'));
    assert.deepEqual(pkg.dsh.profile.bundles, ['existing'], '回滚后不能留下 stellar 或丢失原 bundle');
    assert.equal(pkg.dependencies.existing, '1.0.0');
    assert.equal(pkg.dependencies.stellar, undefined);
  });
} finally {
  // Resolve the exact fixture root before removing this test's temporary files.
  assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
