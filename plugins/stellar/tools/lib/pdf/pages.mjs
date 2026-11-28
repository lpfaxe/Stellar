// PDF 页面文字与 OCR：只负责「第 N 页上有什么字」。
// 有文字层走 pdfjs；扫描页走 Windows OCR；结果按页缓存，重复读不再 OCR。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PdfError } from './errors.mjs';
import { tidyLine } from './parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const OCR_SCRIPT = path.join(HERE, 'pdf-ocr.ps1');
const RENDER_SCRIPT = path.join(HERE, 'render.ps1');
const CROP_SCRIPT = path.join(HERE, 'crop.ps1');

const PDFJS_CANDIDATES = [
  path.resolve(HERE, '..', '..', 'vendor', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'),
  path.resolve(HERE, '..', '..', '..', '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'),
  path.resolve(HERE, '..', '..', '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')
];
const PDFJS_PATH = PDFJS_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || PDFJS_CANDIDATES[0];

function winPath(p) {
  return path.win32.normalize(path.resolve(String(p || '')));
}

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('file://' + PDFJS_PATH.replace(/\\/g, '/')).catch((error) => {
      pdfjsPromise = null;
      throw new PdfError('PDF_ENGINE_MISSING', 'PDF 解析组件加载失败：' + (error?.message || error), '在仓库根目录跑一次 npm install（需要 pdfjs-dist）');
    });
  }
  return pdfjsPromise;
}

const docCache = new Map();

/** 打开一份 PDF；同一路径只保留一个 pdfjs 文档对象。 */
export async function openPdf(filePath) {
  const abs = path.resolve(String(filePath || ''));
  if (!abs || !fs.existsSync(abs)) throw new PdfError('PDF_NOT_FOUND', '找不到这个 PDF：' + abs, '确认路径存在，或重新从聊天里发一次文件');
  const st = fs.statSync(abs);
  const cacheKey = st.size + '-' + Math.round(st.mtimeMs);
  const cached = docCache.get(abs);
  if (cached && cached.key === cacheKey) return cached;
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(abs));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const entry = { filePath: abs, key: crypto.createHash('sha1').update(cacheKey).digest('hex').slice(0, 16), size: st.size, mtimeMs: st.mtimeMs, pageCount: doc.numPages, doc };
  docCache.set(abs, entry);
  return entry;
}

export function pdfCacheDir(stateDir, key) {
  return path.join(stateDir, 'pdf-cache', key);
}

function pageFile(dir, page, ext) {
  return path.join(dir, 'p' + String(page).padStart(4, '0') + ext);
}

async function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

function runPowerShell(args, timeoutMs) {
  const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function readJsonIfAny(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * OCR 一段页范围，返回 { pages:[{page,width,height,lines}], pageCount }。
 * 注意：PowerShell 常以 0xC0000005 结束，判输出文件，不判 exit code。
 */
export async function ocrPages(filePath, { fromPage = 1, maxPages = 1, width = 1700, timeoutMs = 240000 } = {}) {
  const abs = winPath(filePath);
  const out = path.join(os.tmpdir(), 'stellar-pdf-ocr-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  try {
    const r = runPowerShell(['-File', OCR_SCRIPT, '-InputPath', abs, '-OutPath', winPath(out), '-FromPage', String(Math.max(1, Number(fromPage) || 1)), '-MaxPages', String(Math.max(1, Number(maxPages) || 1)), '-Width', String(Math.max(600, Math.min(3000, Number(width) || 1700)))], timeoutMs);
    const data = readJsonIfAny(out);
    if (!data) {
      const tail = String(r.stderr || r.stdout || '').trim().slice(-500);
      throw new PdfError('PDF_OCR_FAILED', 'OCR 没有产出结果' + (tail ? '：' + tail : ''), '确认 PDF 没有加密；必要时把那一页截图发来');
    }
    if (data.error) throw new PdfError('PDF_OCR_FAILED', 'OCR 失败：' + data.error, '确认 PDF 没有加密；必要时把那一页截图发来');
    return { pages: Array.isArray(data.pages) ? data.pages : [], pageCount: Number(data.pageCount) || 0 };
  } finally {
    try { fs.unlinkSync(out); } catch {}
  }
}

/** OCR 单页，带 bbox（像素坐标，基于 width×2 的渲染尺寸）。 */
export async function ocrPage(filePath, page, { width = 1700, timeoutMs = 120000 } = {}) {
  const res = await ocrPages(filePath, { fromPage: page, maxPages: 1, width, timeoutMs });
  const first = res.pages[0];
  if (!first) throw new PdfError('PDF_OCR_FAILED', '第 ' + page + ' 页没有 OCR 结果', '确认页码在 1–' + (res.pageCount || '?') + ' 之间');
  return first;
}

function textFromContent(content) {
  const items = (content?.items || []).filter((it) => it && typeof it.str === 'string' && it.str.trim());
  if (!items.length) return '';
  const rows = [];
  for (const it of items) {
    const y = Math.round(Number(it.transform?.[5]) || 0);
    const x = Number(it.transform?.[4]) || 0;
    const row = rows.find((r) => Math.abs(r.y - y) <= 2);
    if (row) row.items.push({ x, str: it.str });
    else rows.push({ y, items: [{ x, str: it.str }] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => tidyLine(r.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(''))).filter(Boolean).join('\n');
}

/** 读一页的文字；有文字层用 pdfjs，扫描页用 OCR。结果缓存在 state/pdf-cache/<key>/。 */
export async function readPageText(entry, page, { stateDir, forceOcr = false } = {}) {
  const dir = pdfCacheDir(stateDir, entry.key);
  const textFile = pageFile(dir, page, '.txt');
  if (!forceOcr) {
    try { if (fs.existsSync(textFile)) return { page, text: fs.readFileSync(textFile, 'utf8'), source: 'cache' }; } catch {}
  }
  let text = '';
  let source = 'text';
  if (!forceOcr) {
    try {
      const p = await entry.doc.getPage(page);
      text = textFromContent(await p.getTextContent());
    } catch {
      text = '';
    }
  }
  if (text.replace(/\s/g, '').length < 40) {
    const ocr = await ocrPage(entry.filePath, page, { width: 1700 });
    text = (ocr.lines || []).map((l) => tidyLine(l.text)).filter(Boolean).join('\n');
    source = 'ocr';
  }
  await writeAtomic(textFile, text);
  return { page, text, source };
}

export async function cachePageText(stateDir, key, page, text) {
  await writeAtomic(pageFile(pdfCacheDir(stateDir, key), page, '.txt'), text);
}

export async function readPagesText(entry, pages, { stateDir } = {}) {
  const out = [];
  for (const page of pages) out.push(await readPageText(entry, page, { stateDir }));
  return out;
}

/** 渲染一页成 PNG；输出像素是 width 的 2 倍（Windows.Data.Pdf 的 DPI 行为）。 */
export async function renderPage(filePath, page, outFile, { width = 1700, timeoutMs = 120000 } = {}) {
  const abs = winPath(filePath);
  const out = winPath(outFile);
  const r = runPowerShell(['-File', RENDER_SCRIPT, '-InputPath', abs, '-OutPath', out, '-Page', String(page), '-Width', String(width)], timeoutMs);
  if (!fs.existsSync(out)) {
    const tail = String(r.stderr || r.stdout || '').trim().slice(-500);
    throw new PdfError('PDF_RENDER_FAILED', '渲染第 ' + page + ' 页失败' + (tail ? '：' + tail : ''), '确认 PDF 没有加密、页码在范围内');
  }
  return out;
}

/** 用 System.Drawing 按像素裁切 PNG。 */
export async function cropPng(srcFile, outFile, rect, { timeoutMs = 60000, maxWidth = 0 } = {}) {
  const r = runPowerShell(['-File', CROP_SCRIPT, '-InputPath', winPath(srcFile), '-OutPath', winPath(outFile), '-X', String(Math.round(rect.x)), '-Y', String(Math.round(rect.y)), '-W', String(Math.round(rect.w)), '-H', String(Math.round(rect.h)), '-MaxWidth', String(Math.max(0, Number(maxWidth) || 0))], timeoutMs);
  if (!fs.existsSync(outFile)) {
    const tail = String(r.stderr || r.stdout || '').trim().slice(-500);
    throw new PdfError('PDF_RENDER_FAILED', '裁切插图失败' + (tail ? '：' + tail : ''), '可以改用整页图，或把那一页截图发来');
  }
  return outFile;
}

export { PS_EXE, OCR_SCRIPT, RENDER_SCRIPT, CROP_SCRIPT, PDFJS_PATH };
