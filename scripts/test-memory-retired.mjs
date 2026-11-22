// 回归（2026-11-22）：记忆卡 / 向量记忆 / embedding 三条旧管线在 memory.engine=db 时必须一起停。
//
// 背景（PITFALLS #303）：桥接读 <仓库根>/config.json（engine=db），插件读 <DSH_HOME>/stellar/
// config.json（旧壳，没有 engine 键）⇒ 插件的 cardRetiredNow() 永远返回 false：
//   · B站 每条请求注入 959 字旧记忆卡（QQ 侧被桥接挡住，所以只看 QQ 会以为已经退役）
//   · 向量记忆每 10 分钟跑一次，把 memory-inbox 送去 18765 的 embedding shim（转发到云端）
//   · memory-card-full.jsonl 长到 628 MB
// 这条测试钉住三件事：
//   1. 两边选配置文件的规则是**同一份代码**（src/unified-memory-config.js）；
//   2. engine=db 时两条定时器都不启动、维护函数早退（数据保留）；
//   3. keepalive 不再拉起 18765 的 shim（有该文件时才检查，开发机/CI 可跳过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeMemoryEngine, readMemoryConfig, resolveMemoryConfigFile,
} from '../src/unified-memory-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const tmpRoots = [];

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stellar-memretire-${name}-`));
  tmpRoots.push(dir);
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

test.after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('engine 只认 db：大小写与空白归一，其它值都算 card', () => {
  assert.equal(normalizeMemoryEngine('db'), 'db');
  assert.equal(normalizeMemoryEngine(' DB '), 'db');
  assert.equal(normalizeMemoryEngine('Db'), 'db');
  assert.equal(normalizeMemoryEngine('card'), 'card');
  assert.equal(normalizeMemoryEngine(''), 'card');
  assert.equal(normalizeMemoryEngine(undefined), 'card');
});

test('仓库根 config.json 有 memory 段时优先用它', () => {
  const dir = tmpDir('root-wins');
  const rootFile = writeJson(path.join(dir, 'root.json'), { memory: { engine: 'db', mode: 'vector' } });
  const fallbackFile = writeJson(path.join(dir, 'home.json'), { memory: { engine: 'card' } });
  const resolved = resolveMemoryConfigFile({ rootFile, fallbackFile });
  assert.equal(resolved.source, 'root');
  assert.equal(resolved.file, rootFile);
  const cfg = readMemoryConfig({ rootFile, fallbackFile });
  assert.equal(cfg.engine, 'db');
  assert.equal(cfg.mode, 'vector');
});

test('仓库根没有 memory 段时回退到 DSH_HOME 那份（旧布局）', () => {
  const dir = tmpDir('fallback');
  const rootFile = writeJson(path.join(dir, 'root.json'), { ownerQQ: '1', socialV2: {} });
  const fallbackFile = writeJson(path.join(dir, 'home.json'), { memory: { engine: 'db' } });
  const resolved = resolveMemoryConfigFile({ rootFile, fallbackFile });
  assert.equal(resolved.source, 'fallback');
  assert.equal(resolved.file, fallbackFile);
  assert.equal(readMemoryConfig({ rootFile, fallbackFile }).engine, 'db');
});

test('仓库根 config.json 缺失或坏掉时也回退，不抛错给调用方', () => {
  const dir = tmpDir('broken');
  const rootFile = path.join(dir, 'missing.json');
  const fallbackFile = writeJson(path.join(dir, 'home.json'), { memory: { engine: 'db' } });
  assert.equal(resolveMemoryConfigFile({ rootFile, fallbackFile }).source, 'fallback');
  fs.writeFileSync(rootFile, '{ this is not json');
  assert.equal(resolveMemoryConfigFile({ rootFile, fallbackFile }).source, 'fallback');
});

test('两份都没有可读配置时抛错（调用方自己决定降级）', () => {
  const dir = tmpDir('none');
  assert.throws(() => readMemoryConfig({
    rootFile: path.join(dir, 'a.json'),
    fallbackFile: path.join(dir, 'b.json'),
  }));
});

test('插件判定与桥接同源：旧壳没有 engine 键时也认仓库根的 db', async () => {
  const { memoryEngineNow, memoryPipelineRetiredNow, resetMemoryEngineCache } =
    await import('../plugins/stellar/lib/memory-engine.js');
  const dir = tmpDir('plugin');
  const rootFile = writeJson(path.join(dir, 'root.json'), { memory: { engine: 'db' } });
  // 这正是 2026-11-22 现场：$DSH_HOME/stellar/config.json 是 11-11 的旧壳，没有 engine。
  const fallbackFile = writeJson(path.join(dir, 'home.json'), { memory: { mode: 'hybrid' } });
  resetMemoryEngineCache();
  assert.equal(memoryEngineNow({ rootFile, fallbackFile }).engine, 'db');
  assert.equal(memoryPipelineRetiredNow({ rootFile, fallbackFile }), true);

  const cardRoot = writeJson(path.join(dir, 'root-card.json'), { memory: { engine: 'card' } });
  assert.equal(memoryPipelineRetiredNow({ rootFile: cardRoot, fallbackFile }), false);
});

test('插件读不到配置时按 card 处理（宁可多跑旧卡，也不要把记忆全关掉）', async () => {
  const { memoryEngineNow, memoryPipelineRetiredNow } = await import('../plugins/stellar/lib/memory-engine.js');
  const dir = tmpDir('noconfig');
  const result = memoryEngineNow({
    rootFile: path.join(dir, 'missing-root.json'),
    fallbackFile: path.join(dir, 'missing-home.json'),
  });
  assert.equal(result.engine, 'card');
  assert.equal(memoryPipelineRetiredNow({
    rootFile: path.join(dir, 'missing-root.json'),
    fallbackFile: path.join(dir, 'missing-home.json'),
  }), false);
});

test('桥接不再自己写一套选文件逻辑', () => {
  const source = fs.readFileSync(path.join(REPO, 'src', 'bridge.js'), 'utf8');
  assert.match(source, /import \{ normalizeMemoryEngine, resolveMemoryConfigFile \} from '\.\/unified-memory-config\.js'/);
  assert.match(source, /resolveMemoryConfigFile\(\{ rootFile, fallbackFile: path\.join\(STELLAR_DIR, 'config\.json'\) \}\)/);
  assert.doesNotMatch(source, /if \(!probe \|\| typeof probe\.memory !== 'object'/, '内联探针应该已经删掉');
  assert.match(source, /const engine = normalizeMemoryEngine\(memCfg\.engine\)/);
});

test('记忆卡：退役判定委托共享模块，维护函数早退，定时器不启动', () => {
  const source = fs.readFileSync(path.join(REPO, 'plugins', 'stellar', 'lib', 'memory-card.js'), 'utf8');
  assert.match(source, /import \{ memoryPipelineRetiredNow \} from '\.\/memory-engine\.js'/);
  assert.match(source, /function cardRetiredNow\(\) \{\s*return memoryPipelineRetiredNow\(\);\s*\}/);
  assert.match(source, /if \(cardRetiredNow\(\)\) \{[\s\S]{0,400}?retired: true, changed, status: memoryCardStatusNow\(config\)/);
  assert.match(source, /if \(cardRetiredNow\(\)\) \{[\s\S]{0,400}?started: false, retired: true/);
  // 退役分支必须把三份注入产物清空，否则「停了但提示词还在」。
  assert.match(source, /function clearPromptOutputs\(now\)/);
  assert.match(source, /writeIfDifferent\(pathsNow\(\)\.promptBili, ''\)/);
});

test('向量记忆：定时器启动前就按 engine 挡掉', () => {
  const source = fs.readFileSync(path.join(REPO, 'plugins', 'stellar', 'lib', 'vector-memory.js'), 'utf8');
  assert.match(source, /import \{ memoryPipelineRetiredNow \} from '\.\/memory-engine\.js'/);
  assert.match(source, /if \(memoryPipelineRetiredNow\(\)\) \{[\s\S]{0,300}?started: false, retired: true/);
});

test('embedding shim：keepalive 不再拉起 18765（文件存在时检查）', () => {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const keepalive = path.join(dshHome, 'stellar', 'keepalive.ps1');
  if (!fs.existsSync(keepalive)) {
    // 开发机之外的机器没有这个自启脚本，跳过而不是假装通过。
    return;
  }
  const source = fs.readFileSync(keepalive, 'utf8');
  assert.doesNotMatch(source, /Start-Process[^\n]*embedding-shim\.mjs/, 'keepalive 不该再启动 embedding shim');
  assert.match(source, /Embedding shim \(127\.0\.0\.1:18765\): RETIRED/, '退役必须写清楚，后人才能恢复');
});
