// 钉住 DSH 0.1.7 preset 装配的「防漂移」契约（纯离线，不需要 DSH 在跑）：
//   1. bundle patch（plugins/stellar/presets/*.patch.yml）与仓库权威源
//      （dsh/agent-presets/<preset>/{preset.yml,agent.cordis.yml}）逐字一致；
//   2. patch 的形状符合新机制：insert 一条 @deepseek-ai/dsh-agent-preset 行，
//      config 里带 id/name/description/order/plugins；
//   3. 守卫行只能用「从 profile 目录可解析」的引用方式（裸说明符），
//      不允许任何相对/绝对路径子行名 —— 那正是 0.1.7 下静默装不上的坑；
//   4. 安全边界（qq-tool-restrict 的 fail-closed 白名单）一份实现、两个 preset 共用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 第 4 节会把真守卫插件跑起来，而 qq-tool-restrict 会读 DSH_HOME 下的 emergency-stop.json：
// 主人一按「紧急停止」，这里「白名单应放行」的断言就假失败（2026-11-13 记忆重构停机时踩到）。
// 指到临时目录，断言只反映代码，不反映她此刻是否被暂停。
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-preset-patches-'));
process.env.DSH_HOME = sandboxHome;import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  BUNDLE_DIR, GUARD_SPECIFIER, PRESETS, REPO_ROOT,
  buildPatches, patchFileFor, presetRowId,
} from './build-agent-preset-patches.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const read = (p) => fs.readFileSync(p, 'utf8');
// 每个 preset 的守卫行：QQ 两个共用 qq-tool-restrict（fail-closed 白名单），
// bili-slim 只用 whale-tool-restrict（纯省 token，不做执行期拦截）；
// town-act 用 town-tool-restrict（只放行小镇只读工具的 allowlist）。
const GUARD_ID = { 'qq-chat': 'qq-tool-restrict', 'qq-chat-v2': 'qq-tool-restrict', 'bili-slim': 'whale-tool-restrict', 'town-act': 'town-tool-restrict' };
const load = (p) => yaml.load(read(p));

console.log('## 1. 产物与源不漂移（--check 语义）');
{
  const results = buildPatches({ check: true, log: () => {} });
  for (const { file, changed } of results) {
    ok(!changed, `${path.relative(REPO_ROOT, file)} 与源一致（不一致请跑 node scripts/build-agent-preset-patches.mjs）`);
  }
}

console.log('## 2. patch 形状符合 DSH 0.1.7 的 preset 机制');
for (const name of PRESETS) {
  const file = patchFileFor(name);
  ok(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} 存在`);
  const doc = load(file);
  ok(Array.isArray(doc) && doc.length === 1 && Array.isArray(doc[0]?.insert), `${name}: 顶层是 [ { insert: [...] } ]`);
  const row = doc[0].insert[0];
  ok(row.id === presetRowId(name), `${name}: 行 id = ${presetRowId(name)}（非 preset 名，便于按行定位）`);
  ok(row.name === '@deepseek-ai/dsh-agent-preset', `${name}: 行 name = @deepseek-ai/dsh-agent-preset`);
  ok(row.config?.id === name, `${name}: config.id = ${name}（桥接按这个 id 解析 preset）`);
  const meta = load(path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'preset.yml'));
  ok(row.config.name === meta.name && row.config.description === meta.description && row.config.order === meta.order,
    `${name}: preset.yml 的 name/description/order 原样带进 config`);
  ok(Array.isArray(row.config.plugins) && row.config.plugins.length > 0, `${name}: config.plugins 非空（新机制里必填）`);

  // 与源行列表逐字对比：只允许守卫行的 name 被改写。
  const source = load(path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml'));
  const expected = structuredClone(source);
  for (const r of expected) if (r.name === './qq-tool-restrict.mjs') r.name = GUARD_SPECIFIER;
  assert.deepEqual(row.config.plugins, expected, `${name}: config.plugins 必须与 agent.cordis.yml 完全一致（守卫名除外）`);
  ok(true, `${name}: config.plugins 与 agent.cordis.yml 逐字一致（${expected.length} 行）`);

  // 人格正文是产品本体：单独再钉一次，防止「顺手改写/截断」。
  const srcPersona = source.find((r) => r.id === 'persona');
  const patchPersona = row.config.plugins.find((r) => r.id === 'persona');
  ok(typeof srcPersona?.config?.prefix === 'string' && srcPersona.config.prefix === patchPersona?.config?.prefix,
    `${name}: persona.prefix 逐字一致（${srcPersona?.config?.prefix?.length ?? 0} 字符）`);
}

console.log('## 3. 守卫行引用方式：只用「profile 目录可解析」的裸说明符');
for (const name of PRESETS) {
  const row = load(patchFileFor(name))[0].insert[0];
  const guardId = GUARD_ID[name];
  const guardName = `stellar/${guardId}.mjs`;
  const guard = row.config.plugins.find((r) => r.id === guardId);
  ok(guard !== undefined, `${name}: 有 ${guardId} 守卫行`);
  ok(guard?.name === guardName, `${name}: 守卫行 name = ${guardName}`);
  const bad = row.config.plugins.filter((r) => typeof r.name === 'string' && (r.name.startsWith('.') || path.isAbsolute(r.name)));
  ok(bad.length === 0, `${name}: 没有任何相对/绝对路径子行名（0.1.7 下会按 profile 目录解析而装不上）${bad.length ? `：${bad.map((r) => r.name).join(', ')}` : ''}`);
  const guardFile = path.join(BUNDLE_DIR, guardName.slice('stellar/'.length));
  ok(fs.existsSync(guardFile), `${name}: 守卫实现存在（${path.relative(REPO_ROOT, guardFile)}）`);
}

console.log('## 4. bundle 声明与安全边界');
{
  const pkg = JSON.parse(read(path.join(BUNDLE_DIR, 'package.json')));
  const patches = pkg.dsh?.bundle?.patch;
  ok(Array.isArray(patches), 'stellar 的 dsh.bundle.patch 是数组（一个 bundle 可带多层 patch）');
  for (const name of PRESETS) {
    const declared = `./presets/${name}.patch.yml`;
    ok(patches?.includes(declared), `bundle 列出了 ${declared}`);
    ok(fs.existsSync(path.join(BUNDLE_DIR, declared)), `${declared} 存在`);
  }

  const canonical = path.join(BUNDLE_DIR, 'qq-tool-restrict.mjs');
  const canonicalText = read(canonical);
  for (const needle of ["const SAFE_PREFIXES", "'mcp__snowluma__'", "'mcp__web-search-safe__'", 'SAFE_EXACT', 'return `工具 "']) {
    ok(canonicalText.includes(needle), `权威守卫包含 ${needle}`);
  }
  // 一份实现：QQ 两个 preset 目录下的同名文件必须是 re-export 壳，且导出同名成员。
  const canonicalMod = await import(pathToFileURL(canonical).href);
  for (const name of PRESETS.filter((p) => GUARD_ID[p] === 'qq-tool-restrict')) {
    const shim = path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'qq-tool-restrict.mjs');
    ok(/^export \* from '\.\.\/\.\.\/\.\.\/plugins\/stellar\/qq-tool-restrict\.mjs'$/m.test(read(shim).trim()),
      `${name}/qq-tool-restrict.mjs 是指向唯一实现的 re-export 壳`);
    const shimMod = await import(pathToFileURL(shim).href);
    assert.equal(shimMod.apply, canonicalMod.apply, `${name}: 壳与实现在同一模块实例上`);
    assert.equal(shimMod.name, 'qq-tool-restrict');
    assert.deepEqual(shimMod.inject, ['tools']);
  }
  ok(true, 're-export 壳与权威实现导出同一份 apply/inject');

  // 鲸鱼侧：唯一实现，只 restrict、不挂 guard。
  const townFile = path.join(BUNDLE_DIR, 'town-tool-restrict.mjs');
  ok(fs.existsSync(townFile), 'town-tool-restrict.mjs 存在（town-act 的唯一实现）');
  const townMod = await import(pathToFileURL(townFile).href);
  ok(townMod.name === 'town-tool-restrict' && Array.isArray(townMod.inject) && townMod.inject.includes('tools') && typeof townMod.apply === 'function',
    'town-tool-restrict 导出 name/inject/apply');
  ok(Array.isArray(townMod.ALLOWED_TOOLS) && townMod.ALLOWED_TOOLS.every((n) => String(n).startsWith('mcp__snowluma__stellar_town') || n === 'mcp__snowluma__stellar_rules'),
    'town-tool-restrict 白名单只含小镇工具');
  ok(Array.isArray(townMod.HIDDEN_TOOLS) && townMod.HIDDEN_TOOLS.length > 30, 'town-tool-restrict 隐藏了重工具');
  const whaleFile = path.join(BUNDLE_DIR, 'whale-tool-restrict.mjs');
  ok(fs.existsSync(whaleFile), 'whale-tool-restrict.mjs 存在（bili-slim 的唯一实现）');
  const whaleMod = await import(pathToFileURL(whaleFile).href);
  ok(whaleMod.name === 'whale-tool-restrict' && Array.isArray(whaleMod.inject) && whaleMod.inject.includes('tools') && typeof whaleMod.apply === 'function',
    'whale-tool-restrict 导出 name/inject/apply');
  const whaleDenied = [];
  let whaleGuard = null;
  whaleMod.apply({ tools: { restrict: ({ deny }) => whaleDenied.push(...deny), guard: (fn) => { whaleGuard = fn; } } });
  ok(['univer_new', 'remote_list_hosts', 'acp_status'].every((n) => whaleDenied.includes(n)),
    '鲸鱼 restrict 覆盖 univer / remote / acp');
  ok(whaleGuard === null, '鲸鱼不挂执行期白名单（文件与命令能力保持不变）');

  // fail-closed 复检（独立于 test-audit-setup-guards.mjs 的那份假 ctx 测试）。
  let guardFn;
  const restricted = [];
  canonicalMod.apply({ tools: { restrict: ({ deny }) => restricted.push(...deny), guard: (fn) => { guardFn = fn; } } });
  ok(restricted.includes('pwsh') && restricted.includes('dev_install_package'), 'restrict 名单含本地执行面与开发注入器工具');
  for (const name of ['ask_user_question', 'todo_write', 'mcp__snowluma__qq_send_message', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guardFn({ name }), undefined, `白名单应放行 ${name}`);
  }
  ok(true, '白名单放行 QQ MCP 与无害模型侧工具');
  let deniedAll = true;
  for (const name of ['bash', 'read', 'write', 'dev_future_unknown_tool', 'mcp__other__x', '', null, undefined, 123]) {
    if (typeof guardFn({ name }) !== 'string') deniedAll = false;
  }
  ok(deniedAll, '非法/未知/空工具名一律拒绝（fail-closed）');
}


console.log('## 5. bili-slim 的压缩阈值（2026-11-18 省钱改动）');
{
  // 背景：DSH 的 compaction-basic 默认 thresholdRatio 0.8，而 deepseek-flash 声明 1M 窗口，
  // 等于 80 万 token 才压缩 —— 实际永不触发，B站 会话长期停在 35 万上下文，
  // 每天 100+ 次调用全按 cacheHit 重读（单日 1.14 元、占总花费 80%）。
  const row = load(patchFileFor('bili-slim'))[0].insert[0];
  const compaction = row.config.plugins.find((r) => r.id === 'compaction');
  const basic = compaction?.config?.find?.((r) => r.id === 'compaction-basic');
  ok(basic !== undefined, 'bili-slim 里找得到 compaction-basic 行');
  const cfg = basic?.config ?? {};
  ok(cfg.thresholdRatio === 0.15, `thresholdRatio = 0.15（实得 ${String(cfg.thresholdRatio)}）`);
  ok(cfg.retainRatio === 0.05, `retainRatio = 0.05（实得 ${String(cfg.retainRatio)}）`);
  // 正确性不变量：retain 相对 messageBudget、threshold 相对 contextWindow，
  // 而 messageBudget = contextWindow - reserved，所以只要 retainRatio < thresholdRatio，
  // 就一定满足 DSH 的 `retainTokens < thresholdTokens` 校验（否则插件报错、整条压缩失效）。
  ok(cfg.retainRatio < cfg.thresholdRatio,
    `retainRatio(${cfg.retainRatio}) < thresholdRatio(${cfg.thresholdRatio})：否则 DSH 会拒绝配置`);
  ok(cfg.thresholdRatio < 0.8, '阈值确实低于 DSH 默认 0.8（否则这次改动等于没做）');
}
console.log(failures === 0 ? '\n✅ agent preset patch 契约通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch {}
