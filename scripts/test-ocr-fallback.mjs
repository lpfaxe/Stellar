// Windows OCR 兜底：扫描版 PDF（没有文字层）应该自动走 OCR，普通 PDF 不该走。
// 夹具自己造：先用 System.Drawing 画一张中文 JPEG，再手写一个只嵌图片的 PDF。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'plugins', 'stellar', 'tools', 'lib', 'doc-extract.mjs');
const { extractDocument, needsOcr } = await import('file://' + LIB.replace(/\\/g, '/'));
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const NL = String.fromCharCode(10);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-ocr-test-'));

function makeJpeg(file) {
  const ps = [
    "Add-Type -AssemblyName System.Drawing",
    "$bmp = New-Object System.Drawing.Bitmap 1400,500",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.Clear([System.Drawing.Color]::White)",
    "$font = New-Object System.Drawing.Font('Microsoft YaHei',52)",
    "$g.DrawString('扫描件测试', $font, [System.Drawing.Brushes]::Black, 60, 60)",
    "$g.DrawString('合同金额 12800 元 甲方签字', $font, [System.Drawing.Brushes]::Black, 60, 220)",
    "$g.Dispose()",
    "$bmp.Save('" + file.replace(/\\/g, '\\\\') + "', [System.Drawing.Imaging.ImageFormat]::Jpeg)",
    "$bmp.Dispose()"
  ].join('; ');
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  assert.ok(fs.existsSync(file), 'jpeg 夹具没生成：' + r.stderr);
  return fs.readFileSync(file);
}

function pdfWithImage(jpeg, w, h) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); chunks.push(b); length += b.length; };
  push('%PDF-1.4' + NL);
  const obj = (num, body) => { offsets[num] = length; push(num + ' 0 obj' + NL + body + NL + 'endobj' + NL); };
  obj(1, '<</Type/Catalog/Pages 2 0 R>>');
  obj(2, '<</Type/Pages/Kids[3 0 R]/Count 1>>');
  obj(3, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>');
  const content = 'q 520 0 0 186 46 500 cm /Im0 Do Q';
  obj(4, '<</Length ' + content.length + '>>' + NL + 'stream' + NL + content + NL + 'endstream');
  offsets[5] = length;
  push('5 0 obj' + NL + '<</Type/XObject/Subtype/Image/Width ' + w + '/Height ' + h +
       '/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ' + jpeg.length + '>>' + NL + 'stream' + NL);
  push(jpeg);
  push(NL + 'endstream' + NL + 'endobj' + NL);
  const xref = length;
  push('xref' + NL + '0 6' + NL + '0000000000 65535 f ' + NL);
  for (let i = 1; i <= 5; i += 1) push(String(offsets[i]).padStart(10, '0') + ' 00000 n ' + NL);
  push('trailer' + NL + '<</Size 6/Root 1 0 R>>' + NL + 'startxref' + NL + xref + NL + '%%EOF' + NL);
  return Buffer.concat(chunks);
}

test('needsOcr：空正文才算扫描件', () => {
  assert.equal(needsOcr(''), true);
  assert.equal(needsOcr('【第 1 页】\n\n'), true);
  assert.equal(needsOcr('【第 1 页】\n' + '这是一段正常的正文'.repeat(20), 1), false);
  assert.equal(needsOcr('【第 1 页】\nhello contract 12800', 1), false, '有一行字就不该 OCR');
  assert.equal(needsOcr('【第 1 页】\n' + '字'.repeat(40) + '【第 2 页】\n' + '字'.repeat(40), 2), false);
  assert.equal(needsOcr('【第 1 页】\n字【第 2 页】\n字', 2), true, '两页一共两个字，等于没文字');
  assert.equal(needsOcr('【第 1 页】\n字'.repeat(40) + '【第 2 页】\n' + '字'.repeat(40), 2), false);
});

test('扫描版 PDF 自动走 OCR，认得出中文和数字', async () => {
  const jpeg = makeJpeg(path.join(work, 'scan.jpg'));
  const pdfPath = path.join(work, 'scan.pdf');
  fs.writeFileSync(pdfPath, pdfWithImage(jpeg, 1400, 500));
  const doc = await extractDocument({ filePath: pdfPath });
  assert.equal(doc.ok, true, JSON.stringify({ error: doc.error, note: doc.note }));
  assert.equal(doc.meta.ocr, true, '应该走 OCR 兜底');
  assert.equal(doc.meta.pages, 1);
  const flat = doc.text.replace(/\s+/g, '');
  assert.ok(flat.includes('扫描件测试'), 'OCR 正文：' + doc.text.slice(0, 120));
  assert.ok(flat.includes('12800'), 'OCR 正文：' + doc.text.slice(0, 120));
  assert.ok(String(doc.note).includes('OCR'), '要提示这是 OCR 认出来的');
});

test('有文字层的 PDF 不触发 OCR', async () => {
  const body = 'BT /F1 24 Tf 72 720 Td (hello contract 12800) Tj ET';
  const pieces = [];
  const offs = [];
  let len = 0;
  const push = (s) => { const b = Buffer.from(s, 'latin1'); pieces.push(b); len += b.length; };
  push('%PDF-1.4' + NL);
  const obj = (n, s) => { offs[n] = len; push(n + ' 0 obj' + NL + s + NL + 'endobj' + NL); };
  obj(1, '<</Type/Catalog/Pages 2 0 R>>');
  obj(2, '<</Type/Pages/Kids[3 0 R]/Count 1>>');
  obj(3, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>');
  obj(4, '<</Length ' + body.length + '>>' + NL + 'stream' + NL + body + NL + 'endstream');
  obj(5, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  const xref = len;
  push('xref' + NL + '0 6' + NL + '0000000000 65535 f ' + NL);
  for (let i = 1; i <= 5; i += 1) push(String(offs[i]).padStart(10, '0') + ' 00000 n ' + NL);
  push('trailer' + NL + '<</Size 6/Root 1 0 R>>' + NL + 'startxref' + NL + xref + NL + '%%EOF' + NL);
  const pdfPath = path.join(work, 'text.pdf');
  fs.writeFileSync(pdfPath, Buffer.concat(pieces));
  const doc = await extractDocument({ filePath: pdfPath });
  assert.equal(doc.ok, true, JSON.stringify({ error: doc.error }));
  assert.ok(!doc.meta.ocr, '有文字层不该走 OCR');
  assert.ok(doc.text.includes('12800'), doc.text);
});

test.after(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} });