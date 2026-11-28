// 回归（2026-11-26 演示文稿 / 2026-11-27 PDF）：文档读取上限 —— PDF 与 PPT/PPTX 等演示文稿 256MB，其它文档 60MB。
// 起因：主人在私聊发了一份 143MB 的宣讲 pptx（2026-11-26）、又要求扫描版 PDF 也能读到 256MB（2026-11-27），旧上限 60MB → 直接回「读不了」。
// 这里钉住四件事：分档限额、61MB pptx 真能抽出正文、61MB docx 仍被拦、257MB PDF 在打开前被拦；外加 MCP 侧接线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  MAX_INPUT_BYTES,
  MAX_LARGE_BYTES,
  MAX_PDF_BYTES,
  MAX_PRESENTATION_BYTES,
  extractDocument,
  inputLimitForKind,
  inputLimitForName,
  kindFromName
} from '../plugins/stellar/tools/lib/doc-extract.mjs';

const MB = 1024 * 1024;

function makeZip(entries) {
  // 只写 store（method 0）：测试不关心压缩率，只关心文件真的超过 60MB。CRC 留 0（读取端不校验）。
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(local);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function pptxBuffer(dummyBytes) {
  const pres = '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>';
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>';
  const slide = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>限额测试幻灯片</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  return makeZip([
    ['ppt/presentation.xml', Buffer.from(pres, 'utf8')],
    ['ppt/_rels/presentation.xml.rels', Buffer.from(rels, 'utf8')],
    ['ppt/slides/slide1.xml', Buffer.from(slide, 'utf8')],
    ['ppt/media/blob.bin', Buffer.alloc(dummyBytes, 0x41)]
  ]);
}

function docxBuffer(dummyBytes) {
  const doc = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>限额测试</w:t></w:r></w:p></w:body></w:document>';
  return makeZip([
    ['word/document.xml', Buffer.from(doc, 'utf8')],
    ['word/media/blob.bin', Buffer.alloc(dummyBytes, 0x42)]
  ]);
}

test('限额表：PDF 与演示文稿 256MB，其它文档 60MB', () => {
  assert.equal(MAX_LARGE_BYTES, 256 * MB);
  assert.equal(MAX_PRESENTATION_BYTES, 256 * MB);
  assert.equal(MAX_PDF_BYTES, 256 * MB);
  assert.equal(MAX_INPUT_BYTES, 60 * MB);
  for (const kind of ['pdf', 'pptx', 'ppt', 'dps', 'odp']) assert.equal(inputLimitForKind(kind), 256 * MB, kind);
  for (const kind of ['docx', 'xlsx', 'doc', 'txt', '']) assert.equal(inputLimitForKind(kind), 60 * MB, kind || '(空)');
});

test('按文件名估上限：pdf/pptx 256MB，docx 60MB，认不出扩展名时按最高上限放行', () => {
  assert.equal(kindFromName('宣讲.PPTX'), 'pptx');
  assert.equal(kindFromName('扫描书.PDF'), 'pdf');
  assert.equal(inputLimitForName('宣讲.pptx'), 256 * MB);
  assert.equal(inputLimitForName('a.ppt'), 256 * MB);
  assert.equal(inputLimitForName('a.pdf'), 256 * MB);
  assert.equal(inputLimitForName('a.docx'), 60 * MB);
  assert.equal(inputLimitForName('a.bin'), 256 * MB, '未知扩展名可能是改名的 pptx/pdf，先按 256MB 放行，读完再判');
  assert.equal(inputLimitForName(''), 256 * MB);
});

test('61MB 的 pptx 能抽出正文（旧 60MB 上限会误杀）', async () => {
  const buf = pptxBuffer(61 * MB);
  assert.ok(buf.length > 60 * MB, '夹具必须真的超过 60MB，实际 ' + buf.length);
  const r = await extractDocument({ buffer: buf, fileName: '宣讲.pptx', maxChars: 400000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.kind, 'pptx');
  assert.equal(r.meta.slides, 1);
  assert.match(r.text, /限额测试幻灯片/);
});

test('61MB 的 docx 仍按 60MB 拦下', async () => {
  const buf = docxBuffer(61 * MB);
  const r = await extractDocument({ buffer: buf, fileName: '大文档.docx', maxChars: 400000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /文件太大/);
  assert.match(r.error, /60 MB/);
});

test('257MB 的 pptx 在打开前就被拦（不读进内存）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-doc-limits-'));
  const file = path.join(dir, 'huge.pptx');
  try {
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, 257 * MB);
    fs.closeSync(fd);
    const r = await extractDocument({ filePath: file });
    assert.equal(r.ok, false);
    assert.match(r.error, /文件太大/);
    assert.match(r.error, /256 MB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('257MB 的 PDF 在打开前就被拦（256MB 才放行）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-doc-limits-'));
  const file = path.join(dir, 'huge.pdf');
  try {
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, '%PDF-1.4\n');
    fs.ftruncateSync(fd, 257 * MB);
    fs.closeSync(fd);
    const r = await extractDocument({ filePath: file });
    assert.equal(r.ok, false);
    assert.match(r.error, /文件太大/);
    assert.match(r.error, /256 MB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-snowluma-safe.js 的 file_read 用同一套分档上限', () => {
  const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  assert.match(mcp, /const \{ extractDocument, inputLimitForName \} = await loadDocExtract\(\);/);
  assert.match(mcp, /maxBytes: inputLimitForName\(fileName\)/);
  assert.equal((mcp.match(/maxBytes: inputLimitForName\(fileName\)/g) || []).length, 2, 'URL 与聊天附件两条下载都要带上限');
  assert.match(mcp, /const cap = inputLimitForName\(fileName\);/);
  assert.match(mcp, /const timeoutMs = cap > 60 \* 1024 \* 1024 \? 300000 : 90000;/);
  assert.doesNotMatch(mcp, /上限 60 MB/, '旧的写死文案不能再出现');
});