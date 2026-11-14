/**
 * 把「角色设定参考」目录里的 .txt/.md 切成风格切片并写进记忆库（设计 §6.1）。
 *
 * 用法：
 *   node scripts/index-style-refs.mjs            # 增量索引全部参考文件
 *   node scripts/index-style-refs.mjs --dry      # 只打印会切出什么，不写库
 *   node scripts/index-style-refs.mjs --list     # 列出库里现有切片（按来源分组）
 *   node scripts/index-style-refs.mjs --rebuild  # 按文件重建（保留人工关掉的开关）
 *
 * 为什么单独一个脚本而不是塞进 worker：参考库是静态文本、一年也改不了几次；
 * 跑一次几十毫秒，没必要让 10 分钟一次的 tick 去读目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReferenceText } from '../src/style-refs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REF_DIR = process.env.STELLAR_STYLE_REF_DIR || path.join(path.dirname(ROOT), '角色设定参考');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const LIST = args.has('--list');
const REBUILD = args.has('--rebuild');

function listSources() {
  let ents = [];
  try { ents = fs.readdirSync(REF_DIR, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name))
    .map((e) => path.join(REF_DIR, e.name))
    .sort();
}

async function main() {
  const db = await import('../src/memory-db.js');
  if (LIST) {
    const stats = db.stats();
    console.log('参考库目录：' + REF_DIR);
    console.log('库里切片：' + stats.styleSlices + ' 条');
    const rows = db.listStyleSlices({ limit: 50 });
    for (const r of rows) console.log('  · ' + r.source + ' ' + r.part + ' ' + r.kind + ' ' + r.chars + '字 ' + (r.tags || ''));
    return;
  }
  const files = listSources();
  if (!files.length) {
    console.log('没找到参考文件：' + REF_DIR);
    console.log('放 .txt / .md 进去再跑（目录名/文件名随意，文件名会当 source）。');
    return;
  }
  let total = 0;
  for (const file of files) {
    const source = path.basename(file);
    const text = fs.readFileSync(file, 'utf8');
    const slices = parseReferenceText({ text });
    const byKind = {};
    for (const s of slices) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    console.log(source + '：切出 ' + slices.length + ' 条（' + Object.entries(byKind).map(([k, v]) => k + ' ' + v).join(' / ') + '）');
    for (const s of slices) console.log('  · ' + s.part + ' ' + s.kind + ' ' + s.chars + '字 tags=' + (s.tags.join(',') || '-'));
    total += slices.length;
    if (DRY) continue;
    if (REBUILD) {
      // 重建前先把「人工关掉」的切片记下来，按 text 匹配恢复 —— 否则每次重建都把主人的开关冲掉。
      const off = new Set();
      try {
        for (const row of db.listStyleSlicesBySource(source)) {
          if (Number(row.enabled) === 0) off.add(String(row.text));
        }
      } catch {}
      try { db.deleteStyleSlicesBySource(source); } catch (error) { console.log('  清理旧切片失败：' + error.message); }
      for (const s of slices) {
        const r = db.insertStyleSlice({ source, part: s.part, kind: s.kind, tags: s.tags, mood: s.mood, text: s.text });
        if (r.ok && off.has(String(s.text))) { try { db.setStyleSliceEnabled(r.id, false); } catch {} }
      }
      continue;
    }
    let added = 0;
    let dup = 0;
    for (const s of slices) {
      const r = db.insertStyleSlice({ source, part: s.part, kind: s.kind, tags: s.tags, mood: s.mood, text: s.text });
      if (r.ok && r.duplicate) dup += 1;
      else if (r.ok) added += 1;
    }
    console.log('  写入：新增 ' + added + '，已存在 ' + dup);
  }
  console.log((DRY ? '（dry-run，未写库）合计 ' : '合计 ') + total + ' 条切片');
  try { db.closeDb(); } catch {}
}

main().catch((error) => {
  console.error('索引失败：' + (error?.stack || error?.message || error));
  console.error('提示：库路径由 DSH_HOME/stellar/characters/current.json 决定；临时验证可设 DSH_HOME 指向 fixture。');
  process.exit(1);
});
