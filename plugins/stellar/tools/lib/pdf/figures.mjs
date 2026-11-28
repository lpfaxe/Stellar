// 插图定位与裁切：先在本章文字里找「图 7-5」这类图注，再按 OCR 行框找图注上/下的空白区域。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PdfError } from './errors.mjs';
import { findCaption, findCaptionLine, estimateFigureCrop, normalizeFigureLabel, tidyLine } from './parse.mjs';
import { readPageText, ocrPage, renderPage, cropPng } from './pages.mjs';

const MAX_FIGURES = 200;
const MAX_AGE_DAYS = 7;

async function prune(outDir) {
  try {
    const names = (await fsp.readdir(outDir)).filter((n) => /\.png$/i.test(n));
    const files = [];
    for (const name of names) {
      const file = path.join(outDir, name);
      try { const st = await fsp.stat(file); files.push({ file, mtimeMs: st.mtimeMs }); } catch {}
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    for (let i = 0; i < files.length; i += 1) {
      if (i >= MAX_FIGURES || files[i].mtimeMs < cutoff) { try { await fsp.unlink(files[i].file); } catch {} }
    }
  } catch {}
}

function listCaptions(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = tidyLine(line);
    if (/^图\s*\d/.test(t.replace(/\s+/g, ''))) out.push(t.slice(0, 80));
  }
  return out.slice(0, 20);
}

/**
 * 找一张插图并裁出来。
 * @returns {{ok:true, label, caption, page, file, width, height, fullPage:boolean}}
 */
export async function findFigure(entry, chapter, label, { stateDir, outDir, startPage, endPage } = {}) {
  const normalized = normalizeFigureLabel(label);
  if (!normalized) throw new PdfError('PDF_FIGURE_NOT_FOUND', '图号看不懂：' + label, '写成「图 7-5」或「7-5」这种形式');
  const from = Number(startPage) || chapter.pdfStart;
  const to = Number(endPage) || chapter.pdfStart + 60;
  let caption = null;
  let captionPage = 0;
  // 第一轮只认以「图」开头的真图注；正文里的「如图 7.14 所示」要等全章扫完再退。
  for (const captionOnly of [true, false]) {
    for (let page = from; page <= Math.min(to, entry.pageCount); page += 1) {
      const r = await readPageText(entry, page, { stateDir });
      const found = findCaption(r.text, normalized, { captionOnly });
      if (found) { caption = found; captionPage = page; break; }
    }
    if (caption) break;
  }
  if (!caption) {
    const captions = [];
    for (let page = from; page <= Math.min(to, entry.pageCount); page += 1) {
      const r = await readPageText(entry, page, { stateDir });
      captions.push(...listCaptions(r.text));
      if (captions.length >= 20) break;
    }
    throw new PdfError('PDF_FIGURE_NOT_FOUND', '第 ' + chapter.num + ' 章没找到图 ' + normalized + ' 的图注', captions.length ? '这一章能找到的图注：' + captions.join('；') : '这一章没找到图注；可以先用 action:"read" 看正文确认图号，或把页码发我按页出图');
  }

  const ocr = await ocrPage(entry.filePath, captionPage, { width: 1700 });
  const capLine = findCaptionLine(ocr.lines || [], normalized);
  const outName = 'figure-' + normalized.replace('-', '_') + '-' + Date.now().toString(36) + '.png';
  await fsp.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, outName);
  const tmpPage = path.join(outDir, '.page-' + process.pid + '-' + Date.now() + '.png');
  let fullPage = true;
  try {
    await renderPage(entry.filePath, captionPage, tmpPage, { width: 1700 });
    let rect = null;
    if (capLine) rect = estimateFigureCrop(ocr.lines || [], capLine.line, ocr.width, ocr.height);
    if (rect && rect.w >= 120 && rect.h >= 100) {
      await cropPng(tmpPage, outFile, rect, { maxWidth: 1600 });
      fullPage = false;
    } else {
      await cropPng(tmpPage, outFile, { x: 0, y: 0, w: ocr.width, h: ocr.height }, { maxWidth: 1600 });
    }
  } finally {
    try { await fsp.unlink(tmpPage); } catch {}
  }
  await prune(outDir);
  const st = await fsp.stat(outFile);
  let width = 0;
  let height = 0;
  try {
    const buf = await fsp.readFile(outFile);
    if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      width = buf.readUInt32BE(16); height = buf.readUInt32BE(20);
    }
  } catch {}
  return {
    ok: true,
    label: normalized,
    caption: caption.line,
    page: captionPage,
    file: outFile,
    width,
    height,
    bytes: st.size,
    fullPage
  };
}

export { prune as pruneFigures, MAX_FIGURES, MAX_AGE_DAYS };
