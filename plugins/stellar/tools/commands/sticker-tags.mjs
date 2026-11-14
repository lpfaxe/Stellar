#!/usr/bin/env node
/**
 * 表情包标签回填（P2）：node bili.mjs sticker-tags [--dry|--go]
 * 只补 emotion/scene/text/source/license/usageCount，并按 md5 去重；不改图片、不删图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStickerTags, STICKER_SCENES } from '../../../../src/sticker-tags.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FILE = path.join(ROOT, 'state', 'stickers.json');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const go = args.includes('--go');
if (dry === go) {
  console.log('必须且只能给一个 --dry / --go');
  process.exit(2);
}
if (!fs.existsSync(FILE)) {
  console.log('还没有表情包库：' + FILE);
  process.exit(0);
}
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const isArray = Array.isArray(raw);
const list = isArray ? raw : (Array.isArray(raw.stickers) ? raw.stickers : []);
const before = list.length;
const { list: next, removed, changed } = applyStickerTags(list);
const scenes = {};
for (const entry of next) scenes[entry.scene] = (scenes[entry.scene] || 0) + 1;
console.log('表情总数：' + before + ' → ' + next.length + '（去重 ' + removed + '）');
console.log('补标签：' + changed + ' 条');
console.log('场景分布：' + Object.entries(scenes).map(([k, v]) => k + ' ' + v).join(' / '));
console.log('场景枚举：' + STICKER_SCENES.join('、'));
if (dry) {
  console.log('[dry] 未写入');
  process.exit(0);
}
const out = isArray ? next : { ...raw, stickers: next, updatedAt: new Date().toISOString() };
const tmp = FILE + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
fs.renameSync(tmp, FILE);
console.log('[go] 已写入 ' + FILE);
