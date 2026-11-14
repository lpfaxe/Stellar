/**
 * image-pool.mjs —— 「今天手边能用的图」。
 *
 * 为什么要有它：她发说说/动态时想配一张贴合文案的图，图从哪来？
 *   · B站看视频时 debrief 已经把封面下载到 shots/covers/（7 天轮转，跨天还在）；
 *   · 评论区里的图、空间公开动态里的图，也是「今天看到的」。
 * 需求（2026-11-11 主人定）：这些图当天可以留着，一天结束就清空 ——
 * 所以池子按日期分目录：~/.dsh/stellar/image-pool/YYYY-MM-DD/，
 * 任何一次写入/读取都顺手把别的日期目录删掉（跨天即清空，不依赖定时器）。
 *
 * 只在本地工具侧用（CLI / MCP 的窄接口），不进 QQ 会话的 shell。
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
export const POOL_ROOT = path.join(DSH_HOME, 'stellar', 'image-pool');
const INDEX = 'index.jsonl';

export function dayKey(date = new Date()) {
  return date.toLocaleDateString('sv-SE');
}

export function poolDayDir(date = new Date()) {
  return path.join(POOL_ROOT, dayKey(date));
}

function safeName(text, fallback = 'img') {
  const s = String(text == null ? '' : text).replace(/[^0-9A-Za-z_.-]/g, '').slice(0, 60);
  return s || fallback;
}

/** 删掉不是「今天」的日期目录（跨天清空）。返回删掉几个。 */
export function prunePool({ now = new Date() } = {}) {
  const keep = dayKey(now);
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(POOL_ROOT, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === keep) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    try { fs.rmSync(path.join(POOL_ROOT, entry.name), { recursive: true, force: true }); removed += 1; } catch {}
  }
  return removed;
}

function appendIndex(dir, row) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, INDEX), JSON.stringify(row) + '\n', 'utf8');
  } catch {}
}

/**
 * 把一张图放进今天的池子。
 * @param {string} file 源文件绝对路径
 * @param {{origin?: string, caption?: string, url?: string, key?: string}} meta
 * @returns {{ok: boolean, file?: string, bytes?: number, error?: string}}
 */
export function addImage(file, meta = {}, { now = new Date() } = {}) {
  try {
    const src = path.resolve(String(file));
    const st = fs.statSync(src);
    if (!st.isFile() || st.size <= 0) return { ok: false, error: '不是文件或空文件' };
    if (st.size > 12 * 1024 * 1024) return { ok: false, error: '太大（超过 12MB）' };
    prunePool({ now });
    const dir = poolDayDir(now);
    fs.mkdirSync(dir, { recursive: true });
    const base = safeName(path.basename(src), 'img.jpg');
    const prefix = safeName(meta.origin || 'img', 'img');
    let name = prefix + '-' + base;
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      const ext = path.extname(name);
      name = prefix + '-' + path.basename(name, ext) + '-' + Date.now().toString(36) + ext;
      target = path.join(dir, name);
    }
    fs.copyFileSync(src, target);
    const bytes = fs.statSync(target).size;
    appendIndex(dir, {
      file: target,
      name,
      bytes,
      at: new Date(now).toISOString(),
      origin: String(meta.origin || ''),
      caption: String(meta.caption || ''),
      url: String(meta.url || ''),
      key: String(meta.key || ''),
    });
    return { ok: true, file: target, bytes };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 今天池子里有什么（按加入顺序，最新的在后）。 */
export function listImages({ now = new Date() } = {}) {
  // 顺手清掉旧日期目录：主人要的是「每天结束就清空」，不靠定时器也能做到。
  try { prunePool({ now }) } catch {}
  const dir = poolDayDir(now);
  const rows = [];
  try {
    const text = fs.readFileSync(path.join(dir, INDEX), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch {}
    }
  } catch { /* 还没有池子 */ }
  const alive = [];
  for (const row of rows) {
    try { if (fs.statSync(row.file).isFile()) alive.push(row); } catch {}
  }
  const known = new Set(alive.map((r) => r.file));
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === INDEX) continue;
      const full = path.join(dir, entry.name);
      if (known.has(full)) continue;
      if (!/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) continue;
      alive.push({ file: full, name: entry.name, bytes: fs.statSync(full).size, at: '', origin: 'manual', caption: '', url: '', key: '' });
    }
  } catch {}
  return { dir, day: dayKey(now), images: alive };
}

/** 清空（默认清今天，all 清全部日期目录）。 */
export function clearPool({ all = false, now = new Date() } = {}) {
  let removed = 0;
  if (all) {
    try {
      for (const entry of fs.readdirSync(POOL_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try { fs.rmSync(path.join(POOL_ROOT, entry.name), { recursive: true, force: true }); removed += 1; } catch {}
      }
    } catch {}
    return removed;
  }
  try { fs.rmSync(poolDayDir(now), { recursive: true, force: true }); removed = 1; } catch {}
  return removed;
}
