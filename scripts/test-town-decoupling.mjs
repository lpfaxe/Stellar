#!/usr/bin/env node
// test-town-decoupling.mjs —— 「小镇能不能整块删掉」的契约（2026-11-21）。
//
// 用户 2026-11-21 的原话：这个功能迟早要剔除，别把它和项目融得太深。
// 于是把边界钉成可执行的判据：
//   1) 小镇逻辑只能住在 town 独占文件里（src/town-*.js 等），核心文件只允许接线行；
//   2) 核心文件里出现白名单之外的 town 引用 → 失败（谁新加耦合谁修）；
//   3) 拆除清单必须覆盖所有独占文件（新加文件忘了登记 → 失败）。
import fs from 'node:fs';
import path from 'node:path';
import { scan, CORE_TOWN_ALLOW, CORE_TOWN_ALLOW_ANY, TOWN_OWNED_PATTERNS } from './town-decoupling-lib.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('✅ ' + label); }
  else { failed += 1; console.error('❌ ' + label); }
}

const root = path.join(import.meta.dirname, '..');
function walk(dir, acc = [], rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'state', '_backups', '.npm-cache'].includes(entry.name)) continue;
    const next = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), acc, next);
    else acc.push(next);
  }
  return acc;
}
const files = walk(root);
const result = scan({ root, files });

// 1. 没有白名单之外的耦合
ok(result.unknown.length === 0, '核心文件里没有白名单之外的 town 引用（实际 ' + result.unknown.length + ' 处）');
for (const item of result.unknown) console.error('   ' + item.file + ':' + item.line + '  ' + item.text.slice(0, 120));

// 2. 核心文件的耦合规模有上限（写死数字，变多就失败）
const counts = {};
for (const item of result.core) counts[item.file] = (counts[item.file] || 0) + 1;
const limits = {
  'src/bridge.js': 10,
  'src/mcp-snowluma-safe.js': 10,
  'plugins/stellar/lib/scheduler.js': 12,
  'plugins/stellar/lib/run-mode.js': 3,
  'src/capabilities.js': 2,
  'plugins/stellar/tools/lib/config.mjs': 3,
  // 官方插件那一层让位（2026-11-21）：audit 多两行（注释 + test-town-plugin），
  // 面板 server 多 5 行（插件状态查询 + 开关双写）——都是接线，不是逻辑。
  'scripts/test-audit.mjs': 13,
  'stellar-manager/server.mjs': 14,
  'stellar-manager/public/js/core.js': 1,
  'stellar-manager/public/js/boot.js': 1,
  // 小镇在场态（2026-11-22）：activity 认 kind='town'，status 透传 presence，图标加一格。
  'stellar-manager/lib/activity.js': 11,
  'stellar-manager/lib/status.js': 4,
  'stellar-manager/public/js/status.js': 1,
};
for (const [file, limit] of Object.entries(limits)) {
  // 控制台的副本只在发布树里（开发树的面板在仓库外），缺文件就跳过
  if (!fs.existsSync(path.join(root, file))) { ok(true, file + ' 不在本树（跳过）'); continue; }
  const got = counts[file] || 0;
  ok(got > 0 && got <= limit, file + ' 的 town 引用 ' + got + ' 行（上限 ' + limit + '）');
}

// 3. 核心入口只剩一行接线（逻辑不在核心）
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const bridge = read('src/bridge.js');
const mcp = read('src/mcp-snowluma-safe.js');
const scheduler = read('plugins/stellar/lib/scheduler.js');
ok((bridge.match(/townPromptLine\(/g) || []).length === 1, 'bridge 只留一次 townPromptLine 调用');
ok((mcp.match(/registerTownTools\(/g) || []).length === 1, 'mcp 只留一次 registerTownTools 调用');
ok((scheduler.match(/createTownJobs\(/g) || []).length === 1, 'scheduler 只留一次 createTownJobs 调用');
for (const [name, source] of [['bridge', bridge], ['mcp', mcp], ['scheduler', scheduler]]) {
  ok(!/town-client|town-store|town-memory-pure|town-collector|town-actions|town-budget|createTurnPump|collectTownOnce/.test(source),
    name + ' 里没有任何小镇逻辑模块被直接引用（只经 town 盒子）');
}

// 4. 独占文件清单：这些必须都在，且都被 TOWN_OWNED_PATTERNS 认领
const MUST_EXIST = [
  'plugins/stellar/lib/town-jobs.js',
  'src/town-tools.js',
  'src/town-prompt.js',
  'src/town-client.js',
  'src/town-store.js',
  'src/town-collector.js',
  'src/town-turns.js',
  'src/town-memory-pure.js',
  'src/town-actions.js',
  'src/town-budget.js',
  'src/town-snapshot.js',
  'plugins/stellar/tools/rules/town.md',
  'plugins/stellar/town-tool-restrict.mjs',
  'plugins/stellar/presets/town-act.patch.yml',
  'dsh/agent-presets/town-act/preset.yml'
];
for (const rel of MUST_EXIST) {
  ok(result.owned.includes(rel), '拆除清单包含 ' + rel);
}

// 5. 独占文件覆盖完整：工作区里没有漏登记的 town 文件
const suspicious = files
  .map((rel) => rel.split(path.sep).join('/'))
  .filter((rel) => /town/i.test(rel) && !rel.startsWith('node_modules/') && !rel.includes('/node_modules/'))
  .filter((rel) => !TOWN_OWNED_PATTERNS.some((re) => re.test(rel)))
  .filter((rel) => !rel.startsWith('release/') && !rel.startsWith('docs/') && rel !== 'scripts/town-remove.mjs');
ok(suspicious.length === 0, '文件名带 town 的文件都登记成小镇独占（漏了 ' + suspicious.length + ' 个）');
for (const rel of suspicious) console.error('   ' + rel);

// 6. 拆除脚本能在干跑里列出全部（--json）
const removeSrc = read('scripts/town-remove.mjs');
ok(removeSrc.includes('TOWN_OWNED_PATTERNS') && removeSrc.includes('buildPlan'), 'town-remove.mjs 用的是同一份判据');
ok(removeSrc.includes('--apply') && removeSrc.includes('fs.existsSync'), '拆除脚本删完会复查（沙箱 fs.rmSync 会假成功）');

console.log(failed ? '\n❌ 小镇解耦契约：' + passed + ' 通过 / ' + failed + ' 失败' : '\n🎉 小镇解耦契约：' + passed + ' 项通过');
process.exit(failed ? 1 : 0);
