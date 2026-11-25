#!/usr/bin/env node
// 文档锚点门禁：防止「路径:行号」式锚点随代码漂移。
//
// 背景：bridge.js 从 1.5 万行涨到 1.9 万行后，旧文档里的 src/bridge.js:13929 全部错位，
// 抽样 1798 处符号锚点只有 17% 还落在 ±3 行内。结构性解法不是「再对齐一次数字」，
// 而是不再写易漂移的数字：锚点写成「文件 + 符号名」（src/bridge.js 的 sendWakePromptV2()）。
//
// 规则（对 docs/**/*.md 与仓库根 README.md / AGENTS.md）：
//   1) path:123 / path:123-130 / path#L123 视为行号锚点。--strict 下报错，
//      提示改成「文件 + 符号名」；非 strict 只警告（给存量文档留迁移期）。
//   2) 行号必须 <= 目标文件行数，否则一律报错（多半是文件已缩水或锚点写错）。
//   3) 不带行号的路径必须真实存在，否则报错（文件改名/删除后文档没跟上）。
//
// 用法：
//   node scripts/check-doc-anchors.mjs            # 检查并打印汇总（存量违规只警告）
//   node scripts/check-doc-anchors.mjs --strict   # 有任何行号锚点即失败（发布前用）
//   node scripts/check-doc-anchors.mjs --list     # 逐条打印违规位置
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const LIST = argv.includes('--list');
const rootArg = argv.indexOf('--root');
const ROOT = rootArg >= 0 ? path.resolve(argv[rootArg + 1]) : path.resolve(HERE, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'state', 'dist', '.tmp', '_backups']);

// 白名单：文档可以引用「本来就不入库」的路径（本地规则文件、按需生成的文件）。
// 每行一个仓库相对路径，# 开头是注释。白名单只豁免「路径不存在」，不豁免行号锚点。
function readAllow() {
  const out = new Set();
  try {
    const text = fs.readFileSync(path.join(ROOT, 'scripts', 'doc-anchor-allow.txt'), 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      out.add(line);
    }
  } catch { /* 没有白名单文件就是空 */ }
  return out;
}
const ALLOW = readAllow();
const MD_EXT = new Set(['.md']);

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

// 文件索引：绝对路径 -> 行数（按需读，不缓存内容）
const files = walk(ROOT);
const relOf = new Map();
const byBasename = new Map();
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  relOf.set(rel, f);
  if (!byBasename.has(f)) byBasename.set(f, rel);
}
/** 解析引用：先按仓库相对路径精确匹配，再按「同后缀」唯一匹配（文档常只写 client.js:6565）。 */
function resolveRef(ref) {
  const exact = relOf.get(ref);
  if (exact) return exact;
  const hits = [];
  for (const [rel, abs] of relOf) {
    if (rel === ref || rel.endsWith('/' + ref)) hits.push(abs);
    if (hits.length > 2) return null;
  }
  return hits.length === 1 ? hits[0] : null;
}

const lineCountCache = new Map();
function linesOf(abs) {
  if (lineCountCache.has(abs)) return lineCountCache.get(abs);
  let n = 0;
  try {
    const text = fs.readFileSync(abs, 'utf8');
    n = text.length ? text.split('\n').length : 0;
  } catch { n = -1; }
  lineCountCache.set(abs, n);
  return n;
}

// 只认「像仓库内文件」的引用：带已知扩展名
// 扩展名必须「长的在前」，否则 package.json 会被 js 抢先截成 package.js
const FILE_RE = /(?:^|[\s(\[|"`'（【])((?:[\w.@-]+\/)*[\w.@-]+\.(?:jsonl|yaml|json|mjs|cjs|ps1|bat|html|css|yml|md|js))(?::(\d+)(?:-(\d+))?|#L(\d+))?/g;

const DOC_TARGETS = files.filter((f) => {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  return rel.startsWith('docs/') || rel === 'README.md' || rel === 'AGENTS.md';
});

const lineAnchors = [];
const unresolved = [];
const overRange = [];

for (const doc of DOC_TARGETS) {
  const relDoc = path.relative(ROOT, doc).split(path.sep).join('/');
  const text = fs.readFileSync(doc, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('/') && !/\.(js|mjs|json|html|css|md)\b/.test(line)) continue;
    FILE_RE.lastIndex = 0;
    let m;
    while ((m = FILE_RE.exec(line))) {
      const ref = m[1];
      if (ref.includes('://')) continue;
      const startLine = Number(m[2] || m[4] || 0);
      const endLine = Number(m[3] || m[2] || m[4] || 0);
      const target = resolveRef(ref);
      const where = relDoc + ':' + (i + 1);
      if (!target) {
        // 只对「仓库代码目录里的文件」要求存在：state/、characters/、~/.dsh 下的
        // 运行期文件本来就不在仓库里，按路径猜存在与否只会制造噪音。
        const codeRef = /^(src|plugins|scripts|public|dsh|roles|release|stellar-manager|docs)\//.test(ref)
          && !ALLOW.has(ref);
        unresolved.push({ where, ref, snippet: line.trim().slice(0, 120), hard: codeRef });
        continue;
      }
      if (endLine > 0 && linesOf(target) > 0 && endLine > linesOf(target)) {
        overRange.push({ where, ref: ref + ':' + (m[2] || m[4]) + (m[3] ? '-' + m[3] : ''), lines: linesOf(target) });
      }
      if (startLine > 0) {
        lineAnchors.push({ where, ref: ref + ':' + m[2] + (m[3] ? '-' + m[3] : '') });
      }
    }
  }
}

const problems = [];
for (const u of unresolved) problems.push({
  level: u.hard ? (STRICT ? 'error' : 'warn') : 'info',
  msg: (u.hard ? '路径不存在（代码目录）：' : '路径不存在（运行期/相对路径，跳过）：') + u.ref,
  where: u.where,
  snippet: u.snippet
});
for (const o of overRange) problems.push({ level: 'error', msg: '行号超出文件行数：' + o.ref + '（文件只有 ' + o.lines + ' 行）', where: o.where });
for (const a of lineAnchors) {
  problems.push({
    level: STRICT ? 'error' : 'warn',
    msg: '行号锚点易漂移：' + a.ref + ' → 改成「文件 + 符号名」（如 src/bridge.js 的 sendWakePromptV2()）',
    where: a.where
  });
}

if (LIST) {
  for (const p of problems) console.log('[' + p.level + '] ' + p.where + '  ' + p.msg + (p.snippet ? ' ｜ ' + p.snippet : ''));
}
const errors = problems.filter((p) => p.level === 'error');
const warns = problems.filter((p) => p.level === 'warn');
const infos = problems.filter((p) => p.level === 'info');
const hardMissing = unresolved.filter((u) => u.hard).length;
console.log('文档锚点检查：' + DOC_TARGETS.length + ' 个 md ｜ 行号锚点 ' + lineAnchors.length
  + ' ｜ 代码目录路径不存在 ' + hardMissing + ' ｜ 其它路径不存在 ' + (unresolved.length - hardMissing)
  + ' ｜ 行号越界 ' + overRange.length
  + (STRICT ? ' ｜ strict' : ''));
if (warns.length) console.log('警告 ' + warns.length + ' 条（--list 看明细' + (STRICT ? '；strict 下为错误' : '') + '）');
if (infos.length) console.log('提示 ' + infos.length + ' 条（运行期/相对路径，不算错；--list 可看）');
if (errors.length) {
  for (const e of errors.slice(0, 20)) console.log('✗ ' + e.where + '  ' + e.msg);
  if (errors.length > 20) console.log('✗ …还有 ' + (errors.length - 20) + ' 条');
  process.exit(1);
}
console.log('✓ 没有错误' + (warns.length ? '（行号锚点仅警告）' : ''));
