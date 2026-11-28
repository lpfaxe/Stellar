// 把 SVG 渲染成 PNG。只写 stellar/generate/diagram/，原子落盘，不碰用户其它目录。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const GENERATE_DIR = path.join(ROOT, 'generate', 'diagram');
export const MAX_SVG_BYTES = 2 * 1024 * 1024;

export const RENDER_FONT_FILES = Object.freeze([
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
]);

export class RenderError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.hint = hint;
  }
}

/** 生成侧只允许自己拼的 SVG；仍然拒绝脚本/外链/事件属性，避免将来被别处复用。 */
export function assertSafeSvg(svg) {
  const s = String(svg ?? '');
  if (!s.startsWith('<svg')) throw new RenderError('BAD_SVG', 'SVG 必须以 <svg 开头');
  if (Buffer.byteLength(s, 'utf8') > MAX_SVG_BYTES) throw new RenderError('SVG_TOO_LARGE', 'SVG 超过 2MB');
  const bad = [
    [/<script/i, 'script'],
    [/<foreignObject/i, 'foreignObject'],
    [/\son[a-z]+\s*=/i, 'on* 事件属性'],
    [/javascript:/i, 'javascript:'],
    [/<iframe/i, 'iframe'],
    [/<image[^>]+href\s*=\s*["']?(?:https?:|file:)/i, '外部图片'],
  ];
  for (const [re, name] of bad) {
    if (re.test(s)) throw new RenderError('UNSAFE_SVG', 'SVG 含不允许的内容：' + name);
  }
  return true;
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds());
}

async function writeAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  let handle;
  try {
    handle = await fs.open(tmp, 'w', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
  } catch (err) {
    try { if (handle) await handle.close(); } catch { /* ignore */ }
    try { await fs.rm(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

async function loadResvg() {
  try {
    const mod = await import('@resvg/resvg-js');
    if (!mod || !mod.Resvg) throw new Error('no Resvg export');
    return mod.Resvg;
  } catch (err) {
    throw new RenderError(
      'RENDER_UNAVAILABLE',
      '本地渲染组件 @resvg/resvg-js 不可用：' + (err && err.message ? err.message : String(err)),
      '在 stellar 目录运行 npm install（或 npm ci）后重启 DSH；渲染不需要联网、不需要 Python。',
    );
  }
}

/**
 * 渲染并落盘。返回的 file 是 PNG 绝对路径，svgFile 是同时保留的 SVG（方便排查）。
 * 文件名只由前缀/时间/内容哈希决定，不接受调用方给路径。
 */
export async function renderSvgToPng(svg, { width = 512, prefix = 'diagram', prune = true } = {}) {
  assertSafeSvg(svg);
  const w = Math.max(160, Math.min(2400, Math.round(Number(width) || 512)));
  const Resvg = await loadResvg();
  await fs.mkdir(GENERATE_DIR, { recursive: true });
  const safePrefix = String(prefix || 'diagram').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'diagram';
  const hash = crypto.createHash('sha1').update(svg).digest('hex').slice(0, 8);
  const name = safePrefix + '-' + stamp() + '-' + hash;
  const pngFile = path.join(GENERATE_DIR, name + '.png');
  const svgFile = path.join(GENERATE_DIR, name + '.svg');
  let rendered;
  try {
    const fontFiles = RENDER_FONT_FILES;
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: w },
      background: '#ffffff',
      font: { loadSystemFonts: true, fontFiles, defaultFontFamily: 'Microsoft YaHei' },
    });
    rendered = resvg.render();
    const png = rendered.asPng();
    await writeAtomic(svgFile, Buffer.from(svg, 'utf8'));
    await writeAtomic(pngFile, png);
    if (prune) await pruneOutputs().catch(() => {});
    return {
      file: pngFile,
      svgFile,
      width: rendered.width,
      height: rendered.height,
      bytes: png.length,
    };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError('RENDER_FAILED', 'PNG 渲染失败：' + (err && err.message ? err.message : String(err)), '检查 SVG 是否合法；若提示字体问题，确认 C:/Windows/Fonts 下有微软雅黑。');
  }
}

/** 只保留最近 200 组、最多 7 天，防止 generate/ 无限增长。 */
export async function pruneOutputs({ maxFiles = 200, maxAgeDays = 7, now = Date.now() } = {}) {
  let names;
  try { names = await fs.readdir(GENERATE_DIR); } catch { return { removed: 0 }; }
  const entries = [];
  for (const name of names) {
    if (!/\.(png|svg)$/i.test(name)) continue;
    const file = path.join(GENERATE_DIR, name);
    try {
      const st = await fs.stat(file);
      entries.push({ file, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000;
  let removed = 0;
  const pngs = entries.filter((e) => /\.png$/i.test(e.file));
  const keepBases = new Set(pngs.slice(0, maxFiles).map((e) => path.basename(e.file).replace(/\.png$/i, '')));
  for (const e of entries) {
    const base = path.basename(e.file).replace(/\.(png|svg)$/i, '');
    const tooOld = e.mtime < cutoff;
    const overLimit = !keepBases.has(base);
    if (!tooOld && !overLimit) continue;
    try { await fs.rm(e.file, { force: true }); removed += 1; } catch { /* ignore */ }
  }
  return { removed };
}
