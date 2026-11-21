#!/usr/bin/env node
// town-remove.mjs —— 把「鱼缸小镇」整块从小镇从项目里拆掉（2026-11-21）。
//
// 为什么有这个脚本：小镇是迟早要剔除的功能（用户 2026-11-21 明确说过），所以拆除必须是
// 一条命令、清单可核对，而不是靠人回忆「当时都改了哪几个文件」。
//
// 用法：
//   node scripts/town-remove.mjs            干跑：列出会删的文件、会手工改的核心挂点
//   node scripts/town-remove.mjs --json     同上，机器可读（测试用）
//   node scripts/town-remove.mjs --apply    真删文件（核心文件只打印要改哪几行，不代改）
//
// 它**不改**核心文件：自动改 JS 源码风险太高（删错一个括号就是运行期炸），
// 核心那 70 来行按 REMOVAL_NOTES 手工删，删完跑 scripts/test-town-decoupling.mjs 会告诉你还剩什么。
import fs from 'node:fs';
import path from 'node:path';
import { scan, TOWN_OWNED_PATTERNS, REMOVAL_NOTES } from './town-decoupling-lib.mjs';

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

export function buildPlan() {
  const files = walk(root);
  const result = scan({ root, files });
  return {
    files: result.owned,
    core: result.core,
    unknown: result.unknown,
    notes: REMOVAL_NOTES,
    // 数据目录留着：那是她自己记下的三天的日子，删功能不等于删记忆。
    dataKept: ['%DSH_HOME%/stellar/state/town/']
  };
}

function main(argv) {
  const plan = buildPlan();
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  if (json) { console.log(JSON.stringify({ ...plan, apply }, null, 2)); return 0; }
  console.log('小镇拆除清单（' + plan.files.length + ' 个文件整块属于小镇）');
  for (const file of plan.files) console.log('  - ' + file);
  console.log('\n核心文件里要手工删的接线行（' + plan.core.length + ' 行）：');
  for (const item of plan.core) console.log('  ' + item.file + ':' + item.line + '  ' + item.text.slice(0, 120));
  console.log('\n主线说明：');
  for (const note of plan.notes) console.log('  · ' + note);
  console.log('\n数据保留：' + plan.dataKept.join('、') + '（不动）');
  if (plan.unknown.length) {
    console.log('\n⚠ 还有 ' + plan.unknown.length + ' 处没登记的 town 引用，先补进 CORE_TOWN_ALLOW：');
    for (const item of plan.unknown) console.log('  ' + item.file + ':' + item.line + '  ' + item.text.slice(0, 120));
  }
  if (!apply) {
    console.log('\n干跑结束。真删文件加 --apply（核心文件仍需手工改）。');
    return plan.unknown.length ? 2 : 0;
  }
  let removed = 0;
  for (const rel of plan.files) {
    const abs = path.join(root, rel);
    try { fs.rmSync(abs); } catch (error) { console.error('  删不掉 ' + rel + '：' + error.message); continue; }
    if (fs.existsSync(abs)) { console.error('  删了还在 ' + rel + '（沙箱假成功）'); continue; }
    removed += 1;
  }
  console.log('\n已删 ' + removed + '/' + plan.files.length + ' 个文件。剩下照上面「主线说明」手工改核心文件，');
  console.log('改完 再跑 node scripts/test-town-decoupling.mjs 直到它说「核心文件干净」。');
  return 0;
}

if (import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href.replace(/\\/g, '/')) {
  process.exit(main(process.argv.slice(2)));
}
