// Windows 自带 OCR（零安装）：把 PDF 页渲染成位图，再用 Windows.Media.Ocr 认字。
// PowerShell 那边只负责「渲染 + 认字 + 写文件」，判断成败看文件不看退出码
// （PowerShell 进程经常以 0xC0000005 结束，那是 WinRT 收尾的老毛病，见 ocr-pdf.ps1）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'ocr-pdf.ps1');
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

function tmpRoot() {
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    const v = process.env[key];
    if (v && !String(v).startsWith('undefined')) return v;
  }
  const t = os.tmpdir();
  return t.includes('undefined') ? 'C:/Windows/Temp' : t;
}

export function ocrAvailable() {
  return process.platform === 'win32' && fs.existsSync(PS) && fs.existsSync(SCRIPT);
}

// Windows OCR 会在两个汉字之间塞空格（「合 同 金 额」），这里只去掉「两边都是汉字」的空格。
export function tidyOcrText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1').replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseOcrOutput(raw) {
  const text = String(raw || '');
  const m = /^PAGES=(\d+)\s*\n?/.exec(text);
  if (!m) return { ok: false, pages: 0, text: '', error: 'OCR 输出格式不对' };
  const pages = Number(m[1]);
  let body = text.slice(m[0].length);
  body = body.replace(/^--- only first \d+ of \d+ pages ---$/m, '');
  const cleaned = tidyOcrText(body.replace(/^--- page \d+ ---$/gm, ''));
  if (!pages) return { ok: false, pages: 0, text: '', error: tidyOcrText(body) || 'OCR 引擎不可用' };
  return { ok: Boolean(cleaned), pages, text: cleaned, error: cleaned ? '' : '认不出文字' };
}

export function ocrFile(filePath, { width = 2200, maxPages = 30, timeoutMs = 120000 } = {}) {
  const started = Date.now();
  if (!ocrAvailable()) return { ok: false, text: '', pages: 0, ms: 0, note: '这台机器没有可用的 Windows OCR' };
  const dir = fs.mkdtempSync(path.join(tmpRoot(), 'stellar-ocr-'));
  const outPath = path.join(dir, 'out.txt');
  try {
    const run = spawnSync(PS, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      // Windows.Storage 只认反斜杠绝对路径：传进 forward slash 会让 GetFileFromPathAsync 抛异常
      '-InputPath', path.win32.normalize(String(filePath)),
      '-OutPath', outPath,
      '-Width', String(Math.max(600, Math.min(4000, width))),
      '-MaxPages', String(Math.max(1, Math.min(200, maxPages)))
    ], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    let raw = '';
    try { raw = fs.readFileSync(outPath, 'utf8'); } catch { }
    if (!raw) {
      const reason = run.error?.code === 'ETIMEDOUT'
        ? 'OCR 超时'
        : (/AggregateException|Wait|IAsyncOperation/.test(String(run.stderr || ''))
          ? 'OCR 打不开这个文件（路径或格式）'
          : (String(run.stderr || '').trim().split(/\r?\n/)[0] || 'OCR 没有输出'));
      return { ok: false, text: '', pages: 0, ms: Date.now() - started, note: reason.slice(0, 200) };
    }
    const parsed = parseOcrOutput(raw);
    const note = parsed.ok ? '' : parsed.error;
    return { ok: parsed.ok, text: parsed.text, pages: parsed.pages, ms: Date.now() - started, note };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
}