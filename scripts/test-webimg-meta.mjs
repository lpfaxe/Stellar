// 找图图片元数据单测：PNG/JPEG/GIF/WebP 宽高与类型识别。
import assert from 'node:assert/strict';
import { inspectImageBuffer, inspectImageFile, aspectRatio } from '../plugins/stellar/tools/lib/webimg/image-meta.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function gif(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}
function webp(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii'); b.write('WEBP', 8, 'ascii'); b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

check('PNG 宽高与 sha256', () => {
  const info = inspectImageBuffer(png(1000, 800));
  assert.equal(info.kind, 'png'); assert.equal(info.width, 1000); assert.equal(info.height, 800);
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
});

check('GIF 宽高', () => {
  const info = inspectImageBuffer(gif(640, 480));
  assert.equal(info.kind, 'gif'); assert.equal(info.width, 640); assert.equal(info.height, 480);
});

check('WebP VP8X 宽高', () => {
  const info = inspectImageBuffer(webp(1200, 900));
  assert.equal(info.kind, 'webp'); assert.equal(info.width, 1200); assert.equal(info.height, 900);
});

check('inspectImageFile 读真实文件并给出 ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webimg-meta-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, png(512, 512));
  const info = inspectImageFile(file);
  assert.equal(info.ok, true); assert.equal(info.width, 512);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('aspectRatio 与坏数据', () => {
  assert.equal(aspectRatio(1000, 500), 2);
  assert.equal(aspectRatio(0, 500), 0);
  const info = inspectImageBuffer(Buffer.from('not an image'));
  assert.equal(info.kind, ''); assert.equal(info.width, 0);
});

console.log('\n' + pass + '/5 PASS');
if (pass !== 5) process.exitCode = 1;
