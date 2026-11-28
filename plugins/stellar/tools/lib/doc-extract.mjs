// 文档正文提取：PDF / Word / Excel / PPT / WPS 系（doc/docx/xls/xlsx/ppt/pptx/wps/et/dps）+ 纯文本/CSV/RTF。
// 设计约束：
//  1) 不依赖系统安装的 Python / pandoc / LibreOffice —— 本机都没有；PDF 用 vendor 里的 pdfjs-dist。
//  2) OOXML（docx/xlsx/pptx）自己解 zip + 取正文，不引第三方包（除了 PDF）。
//  3) 老的二进制 Office / WPS 格式（doc/xls/ppt/wps/et/dps）走本机已装的 WPS 或 MS Office 转成 OOXML，再按 (2) 读。
//  4) 一切失败都要给出人能看懂的原因，绝不把二进制垃圾丢给模型。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ocrAvailable, ocrFile } from './ocr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// pdfjs 有两处来源：打包进 vendor 的那份，以及仓库根 node_modules 里的正式依赖。
// 公开仓库不带 vendor/node_modules（被 .gitignore 排除），所以克隆下来只有后者 —— 都必须能找到。
const PDFJS_CANDIDATES = [
  path.resolve(HERE, '..', 'vendor', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'),
  path.resolve(HERE, '..', '..', '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')
];
const PDFJS_PATH = PDFJS_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || PDFJS_CANDIDATES[0];
export const MAX_INPUT_BYTES = 60 * 1024 * 1024;
// 大文件单独放宽到 256MB（2026-11-26 演示文稿、2026-11-27 PDF）：一整本宣讲/课件/扫描书动辄 100MB+，
// 体积基本都在图里。pptx 只解 slides/*.xml，不会把整包媒体读进内存；PDF 要整份交给 pdfjs，内存占用随体积涨。
// 其它文档（Word/Excel/WPS）仍是 60MB —— 它们没有这种「一本几百页」的常见场景。
export const MAX_LARGE_BYTES = 256 * 1024 * 1024;
export const MAX_PRESENTATION_BYTES = MAX_LARGE_BYTES;
export const MAX_PDF_BYTES = MAX_LARGE_BYTES;
const LARGE_KINDS = new Set(['pdf', 'pptx', 'ppt', 'dps', 'odp']);

const KIND_LABEL = {
  pdf: 'PDF',
  docx: 'Word 文档（docx）',
  doc: 'Word 文档（doc）',
  wps: 'WPS 文字（wps）',
  rtf: 'RTF 文档',
  xlsx: 'Excel 表格（xlsx）',
  xls: 'Excel 表格（xls）',
  et: 'WPS 表格（et）',
  csv: 'CSV 表格',
  pptx: 'PPT 演示（pptx）',
  ppt: 'PPT 演示（ppt）',
  dps: 'WPS 演示（dps）',
  odt: 'OpenDocument 文档',
  ods: 'OpenDocument 表格',
  odp: 'OpenDocument 演示',
  text: '文本文件',
  html: '网页/HTML',
  zip: '压缩包',
  unknown: '未知格式'
};

export function kindLabel(kind) { return KIND_LABEL[kind] ?? KIND_LABEL.unknown; }

const EXT_KIND = {
  '.pdf': 'pdf', '.docx': 'docx', '.doc': 'doc', '.wps': 'wps', '.rtf': 'rtf',
  '.xlsx': 'xlsx', '.xls': 'xls', '.et': 'et', '.csv': 'csv', '.tsv': 'csv',
  '.pptx': 'pptx', '.ppt': 'ppt', '.dps': 'dps',
  '.odt': 'odt', '.ods': 'ods', '.odp': 'odp',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.log': 'text', '.yml': 'text', '.yaml': 'text', '.xml': 'text',
  '.html': 'html', '.htm': 'html'
};

/** 文件名能认出的格式（没有扩展名或扩展名不认识时返回空串）。 */
export function kindFromName(fileName = '') {
  return EXT_KIND[path.extname(String(fileName || '')).toLowerCase()] || '';
}

/** 某种格式最多允许多大：PDF / 演示文稿 256MB，其余 60MB。 */
export function inputLimitForKind(kind = '') {
  return LARGE_KINDS.has(String(kind || '')) ? MAX_LARGE_BYTES : MAX_INPUT_BYTES;
}

/** 上手前按文件名估上限；认不出扩展名时按最大上限放行，读完再按真实格式判（QQ 里常有人把 pptx 改名 .bin）。 */
export function inputLimitForName(fileName = '') {
  const kind = kindFromName(fileName);
  return kind ? inputLimitForKind(kind) : MAX_LARGE_BYTES;
}

function tooBigError(bytes, limit, kind = '') {
  const label = kind ? kindLabel(kind) + '最多 ' : '上限 ';
  return {
    ok: false,
    kind: kind || 'unknown',
    error: '文件太大（' + (Number(bytes) / 1048576).toFixed(1) + ' MB），' + label + (limit / 1048576) + ' MB'
  };
}

/** 先看魔法字节再看扩展名：QQ 里传的文件经常没扩展名，或者扩展名被改成 .bin。 */
export function detectKind(buffer, fileName = '') {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (buffer && buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
    // zip 家族：靠目录里的标志文件判断具体格式
    try {
      const names = [...readZipEntries(buffer).keys()];
      if (names.includes('word/document.xml')) return 'docx';
      if (names.includes('xl/workbook.xml')) return 'xlsx';
      if (names.includes('ppt/presentation.xml')) return 'pptx';
      if (names.includes('content.xml')) {
        if (names.some((n) => /^mimetype$/.test(n))) {
          const mime = readZipFile(buffer, readZipEntries(buffer), 'mimetype')?.toString('utf8') || '';
          if (mime.includes('opendocument.text')) return 'odt';
          if (mime.includes('opendocument.spreadsheet')) return 'ods';
          if (mime.includes('opendocument.presentation')) return 'odp';
        }
      }
      if (EXT_KIND[ext] && ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(EXT_KIND[ext])) return EXT_KIND[ext];
      return 'zip';
    } catch {
      return EXT_KIND[ext] ?? 'zip';
    }
  }
  if (buffer && buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0 && buffer.readUInt32BE(4) === 0xa1b11ae1) {
    // OLE 复合文档：doc / xls / ppt / wps / et / dps 都是这个壳，只能靠扩展名分流
    return EXT_KIND[ext] ?? 'unknown';
  }
  if (buffer && buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  const head = buffer ? buffer.subarray(0, 400).toString('utf8').trimStart().toLowerCase() : '';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  return 'text';
}

// ── zip 读取（只支持 store/deflate，文档够用；zip64 不处理） ──────────────────
function readZipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('压缩包结构异常（找不到目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count && off + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, rawSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw new Error('压缩包里没有可读条目');
  return entries;
}

function readZipFile(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const lo = e.localOff;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('压缩包条目损坏：' + name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('压缩包里用了不支持的压缩方式(' + e.method + ')：' + name);
}

// ── 文本清洗 ─────────────────────────────────────────────────────────────────
function decodeXmlEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, key) => {
    if (key[0] === '#') {
      const hex = key[1] === 'x' || key[1] === 'X';
      const code = hex ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : m;
  });
}

function tidy(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim();
}

function stripXml(xml, { paraTags = [], cellTags = [], brTags = [] } = {}) {
  let s = String(xml ?? '');
  s = s.replace(/<\?xml[\s\S]*?\?>/g, '');
  for (const t of brTags) s = s.replace(new RegExp('<' + t + '\\b[^>]*/?>', 'gi'), '\n');
  for (const t of cellTags) s = s.replace(new RegExp('</' + t + '>', 'gi'), '\t');
  for (const t of paraTags) s = s.replace(new RegExp('</' + t + '>', 'gi'), '\n');
  s = s.replace(/<[^>]+>/g, '');
  return tidy(decodeXmlEntities(s));
}

// ── docx ─────────────────────────────────────────────────────────────────────
function docxToText(buf) {
  const entries = readZipEntries(buf);
  const parts = [];
  const read = (name) => {
    const data = readZipFile(buf, entries, name);
    return data ? data.toString('utf8') : '';
  };
  const body = read('word/document.xml');
  if (!body) throw new Error('docx 里没有 word/document.xml');
  parts.push(stripXml(body, { paraTags: ['w:p'], brTags: ['w:br', 'w:cr'], cellTags: ['w:tc'] }));
  const extra = [...entries.keys()]
    .filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))
    .sort();
  for (const name of extra.slice(0, 6)) {
    const text = stripXml(read(name), { paraTags: ['w:p'], brTags: ['w:br'], cellTags: ['w:tc'] });
    if (text) parts.push((/header/i.test(name) ? '【页眉】\n' : '【页脚】\n') + text);
  }
  return { text: parts.join('\n\n'), meta: {} };
}

// ── xlsx ─────────────────────────────────────────────────────────────────────
function xlsxSharedStrings(buf, entries) {
  const xml = readZipFile(buf, entries, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml.toString('utf8')))) {
    const inner = m[1];
    const ts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]);
    out.push(decodeXmlEntities(ts.join('')));
  }
  return out;
}

function colIndex(ref) {
  const m = /^([A-Z]+)/i.exec(String(ref || ''));
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxToText(buf, { maxRows = 300, maxCols = 30 } = {}) {
  const entries = readZipEntries(buf);
  const wb = readZipFile(buf, entries, 'xl/workbook.xml');
  if (!wb) throw new Error('xlsx 里没有 xl/workbook.xml');
  const relsXml = readZipFile(buf, entries, 'xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /Id="([^"]*)"/.exec(m[1])?.[1];
    const target = /Target="([^"]*)"/.exec(m[1])?.[1];
    if (id && target) relMap.set(id, target);
  }
  const shared = xlsxSharedStrings(buf, entries);
  const sheets = [];
  for (const m of wb.toString('utf8').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const name = decodeXmlEntities(/name="([^"]*)"/.exec(attrs)?.[1] ?? 'Sheet');
    const rid = /r:id="([^"]*)"/.exec(attrs)?.[1] ?? '';
    sheets.push({ name, rid });
  }
  if (!sheets.length) throw new Error('xlsx 里没有工作表');
  const blocks = [];
  const meta = { sheets: sheets.map((s) => s.name) };
  for (const sheet of sheets) {
    const target = relMap.get(sheet.rid) || ('worksheets/sheet' + (sheets.indexOf(sheet) + 1) + '.xml');
    const full = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xmlBuf = readZipFile(buf, entries, full) ?? readZipFile(buf, entries, 'xl/' + target);
    if (!xmlBuf) { blocks.push('【' + sheet.name + '】（读不到内容）'); continue; }
    const xml = xmlBuf.toString('utf8');
    const rows = [];
    let rowCount = 0;
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rowCount >= maxRows) { rows.push('…（表格行数超过 ' + maxRows + ' 行，已截断）'); break; }
      rowCount += 1;
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1];
        const ref = /r="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const type = /t="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const idx = colIndex(ref);
        if (idx < 0 || idx >= maxCols) continue;
        const body = cm[2];
        let value = '';
        if (type === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          value = v != null ? (shared[Number(v)] ?? '') : '';
        } else if (type === 'inlineStr') {
          const ts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXmlEntities(x[1]));
          value = ts.join('');
        } else if (type === 'str') {
          value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        } else if (type === 'b') {
          value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] === '1' ? 'TRUE' : 'FALSE';
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          value = v != null ? decodeXmlEntities(v) : '';
        }
        const text = String(value ?? '').replace(/\s*\n\s*/g, ' ').trim();
        if (text) cells.push({ idx, text });
      }
      if (cells.length) {
        const width = Math.max(...cells.map((c) => c.idx)) + 1;
        const arr = new Array(width).fill('');
        for (const c of cells) arr[c.idx] = c.text;
        rows.push(arr.join(' | '));
      }
    }
    blocks.push('【' + sheet.name + '】\n' + (rows.join('\n') || '（空表）'));
  }
  return { text: blocks.join('\n\n'), meta };
}

// ── pptx ─────────────────────────────────────────────────────────────────────
function pptxToText(buf) {
  const entries = readZipEntries(buf);
  const pres = readZipFile(buf, entries, 'ppt/presentation.xml')?.toString('utf8') ?? '';
  const relsXml = readZipFile(buf, entries, 'ppt/_rels/presentation.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /Id="([^"]*)"/.exec(m[1])?.[1];
    const target = /Target="([^"]*)"/.exec(m[1])?.[1];
    if (id && target) relMap.set(id, target);
  }
  const slideIds = [...pres.matchAll(/<p:sldId\b([^>]*)\/?>/g)].map((m) => /r:id="([^"]*)"/.exec(m[1])?.[1]).filter(Boolean);
  const slides = [];
  if (slideIds.length) {
    for (const rid of slideIds) {
      const target = relMap.get(rid);
      if (target) slides.push('ppt/' + target.replace(/^\.\//, '').replace(/^\/?ppt\//, ''));
    }
  }
  if (!slides.length) {
    slides.push(...[...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1])));
  }
  const blocks = [];
  slides.forEach((name, i) => {
    const xml = readZipFile(buf, entries, name)?.toString('utf8') ?? '';
    const text = stripXml(xml, { paraTags: ['a:p'], brTags: ['a:br'] });
    blocks.push('【第 ' + (i + 1) + ' 页】\n' + (text || '（这一页没有文字，可能是图片）'));
  });
  return { text: blocks.join('\n\n'), meta: { slides: slides.length } };
}

// ── OpenDocument ─────────────────────────────────────────────────────────────
function odfToText(buf) {
  const entries = readZipEntries(buf);
  const content = readZipFile(buf, entries, 'content.xml');
  if (!content) throw new Error('文档里没有 content.xml');
  const text = stripXml(content.toString('utf8'), {
    paraTags: ['text:p', 'text:h'],
    cellTags: ['table:table-cell'],
    brTags: ['text:line-break']
  });
  return { text, meta: {} };
}

// 扫描件的判定：把页眉标记去掉后，平均每页有效字少于 5 个才当「没有文字层」。
// 阈值刻意定得很低：有文字层的 PDF 哪怕只有一行字也不该白白花 2 秒去 OCR。
// 抽成纯函数是为了能单测，也避免把 OCR 判定散在分支里。
export function needsOcr(text, pages = 1) {
  const body = String(text || '').replace(/【第 \d+ 页】/g, '').replace(/\s+/g, '');
  const n = Math.max(1, Number(pages) || 1);
  return body.length < n * 5;
}

// ── PDF（pdfjs-dist，vendor 里自带） ────────────────────────────────────────
async function pdfToText(buf, { maxPages = 30 } = {}) {
  let pdfjs;
  try {
    pdfjs = await import(/* @vite-ignore */ 'file://' + PDFJS_PATH.replace(/\\/g, '/'));
  } catch (error) {
    throw new Error('PDF 解析组件加载失败（缺 pdfjs-dist：项目根目录跑一次 npm install）：' + (error?.message ?? error));
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0
  }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const out = [];
  for (let p = 1; p <= pages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let text = '';
    let lastY = null;
    for (const item of content.items || []) {
      const str = String(item?.str ?? '');
      if (!str) continue;
      const y = Array.isArray(item.transform) ? item.transform[5] : null;
      if (lastY != null && y != null && Math.abs(y - lastY) > 2.5) text += '\n';
      else if (item.hasEOL) text += '\n';
      text += str;
      lastY = y;
    }
    out.push('【第 ' + p + ' 页】\n' + tidy(text));
  }
  const total = out.join('\n\n');
  return { text: total, meta: { pages: doc.numPages, readPages: pages } };
}

function decodeTextBuffer(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

function rtfToText(raw) {
  let s = String(raw);
  s = s.replace(/\{\\\*[\s\S]*?\}/g, '');
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (m, hex) => {
    const byte = parseInt(hex, 16);
    try { return new TextDecoder('gbk').decode(Buffer.from([byte])); } catch { return ''; }
  });
  s = s.replace(/\\par\b/g, '\n').replace(/\\tab\b/g, '\t').replace(/\\line\b/g, '\n');
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '');
  s = s.replace(/[{}]/g, '');
  return tidy(s);
}

function htmlToText(raw) {
  let s = String(raw)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return tidy(decodeXmlEntities(s).replace(/[ \t]{2,}/g, ' '));
}

// ── 老格式：交给本机 WPS / Office 转 OOXML ──────────────────────────────────
const LEGACY = new Set(['doc', 'xls', 'ppt', 'wps', 'et', 'dps']);

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('powershell', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ code: -1, stdout, stderr: stderr + '\n[超时]' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + (error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function convertLegacyToOoxml(filePath, kind) {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stellar-doc-'));
  const ext = kind === 'xls' || kind === 'et' ? '.xlsx' : (kind === 'ppt' || kind === 'dps' ? '.pptx' : '.docx');
  const outPath = path.join(outDir, 'converted' + ext);
  const script = path.join(HERE, 'office-convert.ps1');
  const res = await runPowerShell([
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Src', filePath, '-Dst', outPath, '-Kind', kind
  ], 120_000);
  const ok = fs.existsSync(outPath);
  return { ok, outPath, outDir, detail: String(res.stdout || '').trim().slice(-400), error: String(res.stderr || '').trim().slice(-400) };
}

/**
 * 读一个文档的正文。
 * @param {{buffer?: Buffer, filePath?: string, fileName?: string, maxChars?: number, maxPages?: number, maxRows?: number}} opts
 */
export async function extractDocument(opts = {}) {
  const fileName = String(opts.fileName || (opts.filePath ? path.basename(opts.filePath) : ''));
  let buffer = opts.buffer;
  if (!buffer && opts.filePath) {
    const stat = await fsp.stat(opts.filePath);
    const nameKind = kindFromName(fileName);
    // 有扩展名就按格式先拦，不用把 200MB 先读进内存；没有扩展名的可能是被改名的 pptx/pdf，先按最大上限放行。
    const earlyLimit = nameKind ? inputLimitForKind(nameKind) : MAX_LARGE_BYTES;
    if (stat.size > earlyLimit) return tooBigError(stat.size, earlyLimit, nameKind);
    buffer = await fsp.readFile(opts.filePath);
  }
  if (!buffer || !buffer.length) return { ok: false, kind: 'unknown', error: '文件是空的（0 字节）' };
  const kind = detectKind(buffer, fileName);
  const limit = inputLimitForKind(kind);
  if (buffer.length > limit) return tooBigError(buffer.length, limit, kind);
  // 上限从 40000 提到 400000：file_read 需要拿全文落盘（spill），只让模型看开头；
  // 400K 字约 1.2MB，短时内存可接受，超过就标记 clipped。
  const maxChars = Math.max(500, Math.min(Number(opts.maxChars) || 12000, 400000));
  let text = '';
  let meta = {};
  let note = '';
  try {
    switch (kind) {
      case 'pdf': {
        ({ text, meta } = await pdfToText(buffer, { maxPages: opts.maxPages }));
        const pages = Number(meta?.readPages) || 1;
        if (needsOcr(text, pages) && ocrAvailable()) {
          let srcPath = opts.filePath;
          let tmpOcrDir = null;
          if (!srcPath) {
            tmpOcrDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stellar-ocr-src-'));
            srcPath = path.join(tmpOcrDir, 'input.pdf');
            await fsp.writeFile(srcPath, buffer);
          }
          const ocr = await ocrFile(srcPath, {
            maxPages: Math.max(Number(opts.maxPages) || 30, 1),
            width: Number(opts.ocrWidth) || 2200
          });
          if (tmpOcrDir) { try { await fsp.rm(tmpOcrDir, { recursive: true, force: true }); } catch {} }
          if (ocr.ok && ocr.text) {
            text = ocr.text;
            meta = { ...meta, ocr: true, ocrPages: ocr.pages, ocrMs: ocr.ms };
            note = '（扫描件：文字是系统 OCR 认出来的，个别字可能认错）';
          } else {
            note = '（这个 PDF 没有文字层，OCR 也没认出字：' + (ocr.note || '未知原因') + '）';
          }
        }
        break;
      }
      case 'docx': ({ text, meta } = docxToText(buffer)); break;
      case 'xlsx': ({ text, meta } = xlsxToText(buffer, { maxRows: opts.maxRows })); break;
      case 'pptx': ({ text, meta } = pptxToText(buffer)); break;
      case 'odt': case 'ods': case 'odp': ({ text, meta } = odfToText(buffer)); break;
      case 'rtf': text = rtfToText(decodeTextBuffer(buffer)); break;
      case 'html': text = htmlToText(decodeTextBuffer(buffer)); break;
      case 'csv': {
        const raw = decodeTextBuffer(buffer);
        const rows = raw.split(/\r?\n/).slice(0, Math.min(Number(opts.maxRows) || 300, 2000));
        text = rows.map((r) => r.split(/\t|,/).map((c) => c.replace(/^"|"$/g, '').trim()).join(' | ')).join('\n');
        meta = { rows: raw.split(/\r?\n/).length };
        break;
      }
      case 'zip': return { ok: false, kind, error: '这是一个压缩包，我没法直接读里面的内容' };
      case 'text': {
        text = decodeTextBuffer(buffer);
        break;
      }
      default: {
        if (LEGACY.has(kind)) {
          let srcPath = opts.filePath;
          let tmpDir = null;
          if (!srcPath) {
            tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stellar-doc-src-'));
            srcPath = path.join(tmpDir, 'input.' + (kind === 'et' ? 'et' : kind === 'dps' ? 'dps' : kind));
            await fsp.writeFile(srcPath, buffer);
          }
          const conv = await convertLegacyToOoxml(srcPath, kind);
          if (!conv.ok) {
            return { ok: false, kind, error: '这是老版 Office/WPS 格式，本机的 WPS / Office 没能转换它（' + (conv.error || conv.detail || '没有输出') + '）' };
          }
          const convBuf = await fsp.readFile(conv.outPath);
          const innerKind = detectKind(convBuf, conv.outPath);
          if (innerKind === 'docx') ({ text, meta } = docxToText(convBuf));
          else if (innerKind === 'xlsx') ({ text, meta } = xlsxToText(convBuf, { maxRows: opts.maxRows }));
          else if (innerKind === 'pptx') ({ text, meta } = pptxToText(convBuf));
          else return { ok: false, kind, error: '转换后的文件格式没认出来（' + innerKind + '）' };
          note = '（' + kindLabel(kind) + ' 已自动转换成现在用的格式再读）';
          try { await fsp.rm(conv.outDir, { recursive: true, force: true }); } catch {}
          if (tmpDir) { try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {} }
        } else {
          return { ok: false, kind, error: '这个格式我还不认识（' + (fileName || '没有文件名') + '）' };
        }
      }
    }
  } catch (error) {
    return { ok: false, kind, error: String(error?.message ?? error) };
  }
  // PDF 里偶尔会混进康熙部首（U+2F00 段），NFKC 后才是正常汉字。
  if (kind === 'pdf') text = String(text).normalize('NFKC');
  text = tidy(text);
  if (!text) {
    const hint = kind === 'pdf' ? '这个 PDF 里没有可提取的文字（可能是扫描件/纯图片）' : '文件里没有可读的文字';
    return { ok: false, kind, error: hint, meta };
  }
  const clipped = text.length > maxChars;
  return {
    ok: true,
    kind,
    text: clipped ? text.slice(0, maxChars) : text,
    chars: text.length,
    clipped,
    note,
    meta
  };
}
