// 工具结果落盘（tool-result spill）。
//
// 目的：网页/搜索这类工具一次能返回 5 万字符，塞进会话后会在之后每一步里重发，
// 把上下文顶到 rollover，交接一多就容易「忘事」。这里把超长结果写到本地文件，
// 只回传头尾 + 绝对路径，需要细节时用 stellar_spill_read 分段读。
//
// 安全边界：spill 目录固定为 %USERPROFILE%\.dsh\stellar\state\tool-spill，
// 读取工具只允许读这个目录里的文件（realpath 之后再做前缀校验），不接受任意路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const SPILL_ROOT = path.join(os.homedir(), '.dsh', 'stellar', 'state', 'tool-spill');

function ensureRoot() {
  fs.mkdirSync(SPILL_ROOT, { recursive: true });
  return SPILL_ROOT;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 把整段文本写进 spill 目录，返回 { file, chars, lines, bytes }。 */
export function writeSpill(text, { tool = 'tool' } = {}) {
  const root = ensureRoot();
  const safeTool = String(tool || 'tool').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'tool';
  const name = `${stamp()}-${safeTool}-${crypto.randomBytes(3).toString('hex')}.txt`;
  const file = path.join(root, name);
  const body = String(text ?? '');
  const header = `# tool-result spill\n# tool: ${safeTool}\n# written: ${new Date().toISOString()}\n# chars: ${body.length}\n\n`;
  fs.writeFileSync(file, header + body, 'utf8');
  return {
    file,
    chars: body.length,
    lines: body.split('\n').length,
    bytes: Buffer.byteLength(header + body, 'utf8')
  };
}

/**
 * 超长文本落盘并返回「头 + 省略标记 + 尾 + 路径提示」。
 * 不超长时原样返回（file 为 null）。
 */
export function spillText(text, { tool = 'tool', max = 3000, head = 1500, tail = 500 } = {}) {
  const body = String(text ?? '');
  if (body.length <= max) return { text: body, file: null, chars: body.length };
  const saved = writeSpill(body, { tool });
  const h = Math.max(200, Math.min(head, Math.floor(max / 2)));
  const t = Math.max(0, Math.min(tail, max - h));
  const omitted = body.length - h - t;
  const marker =
    `\n\n…（中间省略 ${omitted} 字；全文 ${body.length} 字已存到 ${saved.file}，` +
    `要细节用 stellar_spill_read(path="${saved.file}", offset=0, maxChars=4000) 分段读）…\n\n`;
  return { text: body.slice(0, h) + marker + body.slice(body.length - t), file: saved.file, chars: body.length };
}

/** 把超长 JSON 对象落盘；返回完整 JSON 文件路径。 */
export function spillJson(obj, { tool = 'tool' } = {}) {
  return writeSpill(JSON.stringify(obj, null, 2), { tool });
}

/** 把字符串字段裁剪到 cap 字，保留可解析的 JSON 结构。 */
export function capStrings(value, cap) {
  if (typeof value === 'string') {
    return value.length > cap ? value.slice(0, cap) + `…（已截断，原 ${value.length} 字）` : value;
  }
  if (Array.isArray(value)) return value.map((v) => capStrings(v, cap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = capStrings(v, cap);
    return out;
  }
  return value;
}

/** 校验并解析 spill 路径：必须是 spill 目录里的真实文件。 */
export function resolveSpillPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('要给 spill 文件路径');
  const root = fs.realpathSync(ensureRoot());
  let real;
  try {
    real = fs.realpathSync(path.resolve(raw));
  } catch {
    throw new Error('spill 文件不存在：' + raw);
  }
  const inside = real === root || real.startsWith(root + path.sep);
  if (!inside) throw new Error('只允许读 spill 目录里的文件：' + root);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('不是文件：' + raw);
  return real;
}

/** 按字符偏移读 spill 文件的一段（跳过写入时的头部注释行）。 */
export function readSpillSlice({ file, offset = 0, maxChars = 4000 }) {
  const real = resolveSpillPath(file);
  const raw = fs.readFileSync(real, 'utf8');
  const idx = raw.indexOf('\n\n');
  const body = idx >= 0 ? raw.slice(idx + 2) : raw;
  const start = Math.max(0, Math.min(Number(offset) || 0, body.length));
  const size = Math.max(200, Math.min(Number(maxChars) || 4000, 8000));
  const end = Math.min(body.length, start + size);
  return {
    file: real,
    total: body.length,
    start,
    end,
    text: body.slice(start, end),
    hasMore: end < body.length
  };
}
