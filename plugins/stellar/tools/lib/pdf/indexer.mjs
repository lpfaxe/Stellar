// 章节索引：先看 PDF 自带目录，没有就把前 30 页 OCR 出来读目录，再用页眉页码算偏移。
// 索引只记章节与页码，不存正文；正文按页缓存在 pages.mjs 里。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PdfError } from './errors.mjs';
import { parseChapterHeading, parseTocChapters, pageHeaderNumber, tidyLine } from './parse.mjs';
import { ocrPages, cachePageText, readPageText, readPagesText } from './pages.mjs';

const INDEX_VERSION = 2;

function indexPath(stateDir, key) {
  return path.join(stateDir, 'pdf-index', key + '.json');
}

async function writeAtomicJson(file, value) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

function loadCached(stateDir, key) {
  try {
    const file = indexPath(stateDir, key);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== INDEX_VERSION || data.key !== key) return null;
    return data;
  } catch {
    return null;
  }
}

export async function loadIndex(entry, { stateDir } = {}) {
  return loadCached(stateDir, entry.key);
}

async function outlineChapters(doc) {
  let outline = null;
  try { outline = await doc.getOutline(); } catch { outline = null; }
  if (!Array.isArray(outline) || !outline.length) return [];
  const out = [];
  const walk = async (items) => {
    for (const item of items || []) {
      const title = String(item?.title || '').trim();
      const heading = parseChapterHeading(title);
      if (heading) {
        let page = 0;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await doc.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) page = (await doc.getPageIndex(dest[0])) + 1;
        } catch { page = 0; }
        if (page > 0) out.push({ num: heading.num, title: heading.title, printedStart: 0, pdfStart: page, confidence: 'outline' });
      }
      if (Array.isArray(item?.items) && item.items.length) await walk(item.items);
    }
  };
  await walk(outline);
  out.sort((a, b) => a.num - b.num);
  const uniq = [];
  for (const c of out) if (!uniq.some((x) => x.num === c.num)) uniq.push(c);
  return uniq;
}

function estimateOffset(ocrPageList) {
  const votes = new Map();
  for (const page of ocrPageList) {
    const lines = Array.isArray(page.lines) ? page.lines : [];
    const printed = pageHeaderNumber(lines);
    if (!printed) continue;
    const text = lines.map((l) => tidyLine(l.text)).join('\n');
    if (!/第\s*\d+\s*章/.test(text.replace(/\s+/g, ''))) continue;
    const offset = Number(page.page) - printed;
    if (offset > -20 && offset < 120) votes.set(offset, (votes.get(offset) || 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [offset, count] of votes) if (count > bestCount) { best = offset; bestCount = count; }
  return best;
}

async function buildFromToc(entry, { stateDir } = {}) {
  const limit = Math.min(40, entry.pageCount);
  const ocr = await ocrPages(entry.filePath, { fromPage: 1, maxPages: limit, width: 1700, timeoutMs: 300000 });
  for (const page of ocr.pages) {
    const text = (page.lines || []).map((l) => tidyLine(l.text)).filter(Boolean).join('\n');
    await cachePageText(stateDir, entry.key, page.page, text);
  }
  const toc = parseTocChapters(ocr.pages);
  if (!toc.length) {
    throw new PdfError('PDF_TOC_NOT_FOUND', '没在前 ' + limit + ' 页里找到目录（第N章 + 页码）', '可以用 action:"read" 配合 page 直接读某一页；或把目录页截图发来');
  }
  const offset = estimateOffset(ocr.pages);
  const tocPages = [...new Set(toc.map((c) => c.tocPage).filter(Boolean))].sort((a, b) => a - b);
  for (const c of toc) if (c.num === 1 && !c.printedStart) c.printedStart = 1;
  toc.sort((a, b) => a.num - b.num);
  // 目录 OCR 偶尔认不出某几章的页码（2026-11-27：第 2、5、15 章为 0）。
  // 用相邻已知章线性插值补一个估计值，只当线索；resolveChapter 会再翻页复核。
  const missing = new Set();
  for (let i = 0; i < toc.length; i += 1) {
    if (toc[i].printedStart) continue;
    let p = i - 1;
    let n = i + 1;
    while (p >= 0 && !toc[p].printedStart) p -= 1;
    while (n < toc.length && !toc[n].printedStart) n += 1;
    if (p < 0 || n >= toc.length) continue;
    const a = toc[p];
    const b = toc[n];
    const span = b.num - a.num;
    if (span <= 0) continue;
    const guess = Math.round(a.printedStart + ((b.printedStart - a.printedStart) * (toc[i].num - a.num)) / span);
    if (guess > a.printedStart && guess < b.printedStart) {
      toc[i].printedStart = guess;
      missing.add(toc[i].num);
    }
  }
  for (const c of toc) {
    c.pdfStart = c.printedStart && offset ? c.printedStart + offset : 0;
    c.confidence = missing.has(c.num) ? 'interpolated' : c.pdfStart ? 'estimated' : 'toc';
  }
  // 按已知偏移能估出来的章先按页码排，保证 start 单调；冲突时置空，等按需解析。
  let last = 0;
  for (const c of toc) {
    if (c.pdfStart && c.pdfStart <= last) c.pdfStart = 0;
    if (c.pdfStart) last = c.pdfStart;
  }
  return {
    version: INDEX_VERSION,
    key: entry.key,
    filePath: entry.filePath,
    pageCount: entry.pageCount,
    source: 'toc',
    offset,
    tocPages: [Math.min(...tocPages), Math.max(...tocPages)],
    chapters: toc.map((c) => ({ num: c.num, title: c.title, printedStart: c.printedStart || 0, pdfStart: c.pdfStart || 0, confidence: c.confidence })),
    createdAt: new Date().toISOString()
  };
}

export async function buildIndex(entry, { stateDir, force = false } = {}) {
  if (!force) {
    const cached = loadCached(stateDir, entry.key);
    if (cached) return cached;
  }
  const chapters = await outlineChapters(entry.doc);
  let index;
  if (chapters.length >= 3) {
    index = {
      version: INDEX_VERSION, key: entry.key, filePath: entry.filePath, pageCount: entry.pageCount,
      source: 'outline', offset: 0, tocPages: [], chapters, createdAt: new Date().toISOString()
    };
  } else {
    index = await buildFromToc(entry, { stateDir });
  }
  await writeAtomicJson(indexPath(stateDir, entry.key), index);
  return index;
}

async function saveIndex(index, { stateDir } = {}) {
  index.updatedAt = new Date().toISOString();
  await writeAtomicJson(indexPath(stateDir, index.key), index);
}

function findChapter(index, num) {
  const chapter = (index.chapters || []).find((c) => Number(c.num) === Number(num));
  if (!chapter) {
    const available = (index.chapters || []).map((c) => c.num).join('、');
    throw new PdfError('PDF_CHAPTER_NOT_FOUND', '这份 PDF 里没有第 ' + num + ' 章（目录里有：' + available + '）', '先用 action:"outline" 看章列表，再选一个存在的章号');
  }
  return chapter;
}

async function headingPage(entry, page, num, { stateDir } = {}) {
  const r = await readPageText(entry, page, { stateDir });
  const lines = String(r.text || '').split(/\r?\n/).map(tidyLine).filter(Boolean);
  const head = lines.slice(0, 6).join('').replace(/\s+/g, '');
  if (new RegExp('第' + Number(num) + '章').test(head)) return true;
  // 章首页常被 OCR 拆成「第」+ 下一行标题，这时没有「第N章」连写。
  if (/^第$/.test(lines[0] || '') && (lines[1] || '').length >= 4) return true;
  return false;
}

/** 把某一章的起始页解析出来（目录页码不准时按 ±14 页扫描复核）。 */
export async function resolveChapter(entry, index, num, { stateDir } = {}) {
  const chapter = findChapter(index, num);
  if (chapter.pdfStart && (chapter.confidence === 'verified' || chapter.confidence === 'outline')) return chapter;
  const offset = Number(index.offset) || 0;
  const estimate = chapter.printedStart ? chapter.printedStart + offset : 0;
  const pageCount = entry.pageCount;
  const candidates = [];
  if (estimate) {
    for (let d = 0; d <= 14; d += 1) {
      if (estimate - d >= 1) candidates.push(estimate - d);
      if (d && estimate + d <= pageCount) candidates.push(estimate + d);
    }
  } else if (chapter.pdfStart) {
    for (let d = 0; d <= 14; d += 1) {
      if (chapter.pdfStart - d >= 1) candidates.push(chapter.pdfStart - d);
      if (d && chapter.pdfStart + d <= pageCount) candidates.push(chapter.pdfStart + d);
    }
  } else {
    const prev = (index.chapters || []).filter((c) => c.num < chapter.num && c.pdfStart).sort((a, b) => b.num - a.num)[0];
    const from = prev ? prev.pdfStart + 1 : 1;
    for (let p = from; p <= Math.min(pageCount, from + 60); p += 1) candidates.push(p);
  }
  for (const page of candidates) {
    if (await headingPage(entry, page, num, { stateDir })) {
      chapter.pdfStart = page;
      chapter.confidence = 'verified';
      await saveIndex(index, { stateDir });
      return chapter;
    }
  }
  throw new PdfError('PDF_CHAPTER_NOT_FOUND', '目录说第 ' + num + ' 章在印刷页 ' + (chapter.printedStart || '?') + '（推算 PDF 第 ' + (estimate || '?') + ' 页），但附近没找到章标题', '目录页码可能印错或 OCR 认错；可以先用 action:"outline" 看目录，或把正确的起始页发我');
}

/** 本章结束页（下一章起始页 - 1）。 */
export async function resolveChapterEnd(entry, index, chapter, { stateDir } = {}) {
  const next = (index.chapters || []).find((c) => c.num === chapter.num + 1);
  if (next) {
    try {
      const resolved = await resolveChapter(entry, index, next.num, { stateDir });
      if (resolved.pdfStart > chapter.pdfStart) return resolved.pdfStart - 1;
    } catch {}
    if (next.printedStart && chapter.printedStart) {
      const span = next.printedStart - chapter.printedStart;
      if (span > 0) return Math.min(entry.pageCount, chapter.pdfStart + span - 1);
    }
  }
  return Math.min(entry.pageCount, chapter.pdfStart + 60);
}

export { findChapter, indexPath };