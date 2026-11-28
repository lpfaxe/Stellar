// PDF 子系统的公共入口：outline / read / figure。
// 这一层只做编排，页面文字在 pages.mjs，章节索引在 indexer.mjs，插图在 figures.mjs。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PdfError } from './errors.mjs';
import { openPdf, readPageText } from './pages.mjs';
import { buildIndex, resolveChapter, resolveChapterEnd } from './indexer.mjs';
import { findFigure } from './figures.mjs';
import { tidyLine } from './parse.mjs';

const MAX_PAGES_PER_READ = 40;
const DEFAULT_MAX_CHARS = 12000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIGURE_DIR = path.resolve(HERE, '..', '..', '..', '..', '..', 'generate', 'pdf');

function pdfAvailable() {
  try {
    return ['pdf-ocr.ps1', 'render.ps1', 'crop.ps1'].every((f) => fs.existsSync(path.join(HERE, f)));
  } catch { return false; }
}

function clampChars(n) {
  return Math.max(1000, Math.min(40000, Number(n) || DEFAULT_MAX_CHARS));
}

function pageLabel(index, page) {
  const offset = Number(index.offset) || 0;
  return offset ? 'PDF ' + page + ' 页（印刷页 ' + (page - offset) + '）' : 'PDF ' + page + ' 页';
}

function chapterRange(index, chapter) {
  return { start: chapter.pdfStart, end: chapter.pdfEnd || chapter.pdfStart };
}

/** 只看目录：不读正文，返回章节、印刷页、推算的 PDF 页和范围。 */
export async function outlinePdf({ filePath, stateDir } = {}) {
  const entry = await openPdf(filePath);
  const index = await buildIndex(entry, { stateDir });
  const chapters = (index.chapters || []).map((c) => {
    const next = (index.chapters || []).find((x) => x.num === c.num + 1);
    return {
      num: c.num,
      title: c.title,
      printedStart: c.printedStart || 0,
      pdfStart: c.pdfStart || 0,
      pdfEnd: next && next.pdfStart && c.pdfStart ? next.pdfStart - 1 : 0,
      confidence: c.confidence || 'toc',
      pages: c.pdfStart ? (next && next.pdfStart && next.pdfStart > c.pdfStart ? next.pdfStart - c.pdfStart : 0) : 0
    };
  });
  return { ok: true, pageCount: entry.pageCount, source: index.source, offset: index.offset || 0, tocPages: index.tocPages || [], chapters };
}

/**
 * 读一章（或指定页/页范围）。返回文字 + 下一批页码；单次最多 40 页 / maxChars 字。
 */
export async function readPdf({ filePath, chapter, page, fromPage, toPage, maxChars, stateDir } = {}) {
  const entry = await openPdf(filePath);
  const index = await buildIndex(entry, { stateDir });
  let start = 0;
  let end = 0;
  let ch = null;
  if (chapter) {
    ch = await resolveChapter(entry, index, Number(chapter), { stateDir });
    ch.pdfEnd = await resolveChapterEnd(entry, index, ch, { stateDir });
    start = ch.pdfStart;
    end = ch.pdfEnd;
  } else if (page) {
    start = Number(page);
    end = Number(page);
  } else if (fromPage) {
    start = Number(fromPage);
    end = Number(toPage) || start;
  }
  if (!start || start < 1 || start > entry.pageCount) throw new PdfError('PDF_PAGE_OUT_OF_RANGE', '页码不在 1–' + entry.pageCount + ' 之间：' + start, '先用 action:"outline" 看章，或把正确页码发我');
  end = Math.max(start, Math.min(end || start, entry.pageCount, start + MAX_PAGES_PER_READ - 1));
  const limit = clampChars(maxChars);
  const parts = [];
  let chars = 0;
  let nextPage = 0;
  let last = start;
  for (let p = start; p <= end; p += 1) {
    const r = await readPageText(entry, p, { stateDir });
    let text = String(r.text || '').trim();
    if (!text) text = '（这一页没认到文字，可能是纯图或版式特殊）';
    const block = '【' + pageLabel(index, p) + '】\n' + text;
    if (chars + block.length > limit && parts.length) { nextPage = p; break; }
    if (block.length > limit) text = text.slice(0, Math.max(200, limit - 40)) + '\n…（本页太长，已截断）';
    const finalBlock = '【' + pageLabel(index, p) + '】\n' + text;
    parts.push(finalBlock);
    chars += finalBlock.length;
    last = p;
  }
  return {
    ok: true,
    chapter: ch ? { num: ch.num, title: ch.title, pdfStart: ch.pdfStart, pdfEnd: ch.pdfEnd } : null,
    fromPage: start,
    toPage: last,
    pageCount: entry.pageCount,
    chars,
    text: parts.join('\n\n'),
    nextPage: nextPage || (last < end ? last + 1 : 0),
    truncated: Boolean(nextPage)
  };
}

/** 找并裁一张插图；返回本地 PNG 路径（MCP 层再转成图片内容）。 */
export async function figurePdf({ filePath, chapter, label, page, stateDir, outDir } = {}) {
  const entry = await openPdf(filePath);
  const index = await buildIndex(entry, { stateDir });
  let ch;
  if (chapter) {
    ch = await resolveChapter(entry, index, Number(chapter), { stateDir });
    ch.pdfEnd = await resolveChapterEnd(entry, index, ch, { stateDir });
  } else if (page) {
    ch = { num: 0, title: '指定页', pdfStart: Number(page), pdfEnd: Number(page) };
  } else {
    throw new PdfError('PDF_CHAPTER_NOT_FOUND', '找插图需要 chapter 或 page', '先给章号（例如 7）和图号（例如 7-5）');
  }
  const out = outDir || FIGURE_DIR;
  const result = await findFigure(entry, ch, label, { stateDir, outDir: out, startPage: ch.pdfStart, endPage: ch.pdfEnd });
  return { ...result, chapter: ch.num ? { num: ch.num, title: ch.title, pdfStart: ch.pdfStart, pdfEnd: ch.pdfEnd } : null };
}

export { pdfAvailable, PdfError, FIGURE_DIR, MAX_PAGES_PER_READ, DEFAULT_MAX_CHARS };
