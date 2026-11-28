// SVG 输出的小工具：转义、文字宽度、换行、数字格式。
// 只生成字符串，不依赖 DOM；所有进入 SVG 的文字都必须经过 escapeXml。

export const FONT_FAMILY = "'Microsoft YaHei', 'Segoe UI', 'Noto Sans CJK SC', sans-serif";
export const MONO_FAMILY = "'Cascadia Mono', 'Consolas', monospace";

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 估算文字宽度：中文/全角按 1em，ASCII 按 0.56em。用于排版，不追求字体度量级精确。 */
export function textWidth(text, fontSize = 20) {
  let width = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0) || 0;
    width += code > 0xFF ? 1 : 0.56;
  }
  return width * fontSize;
}

/** 按宽度换行；中文逐字可断，英文尽量不切单词。最多 maxLines 行，超了加省略号。 */
export function wrapText(text, maxWidth, fontSize = 20, maxLines = 3) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!source) return [''];
  const tokens = source.match(/[A-Za-z0-9_+\-*/^.=<>:]+|\s+|./gu) || [];
  const lines = [];
  let line = '';
  const pushLine = () => { if (line) { lines.push(line.trimEnd()); line = ''; } };
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (line && !line.endsWith(' ')) line += ' ';
      continue;
    }
    const candidate = line + token;
    if (textWidth(candidate, fontSize) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) {
      pushLine();
      if (lines.length >= maxLines) break;
    }
    // 单个 token 本身就超宽：逐字切开
    if (textWidth(token, fontSize) > maxWidth) {
      let chunk = '';
      for (const ch of token) {
        if (textWidth(chunk + ch, fontSize) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = '';
          if (lines.length >= maxLines) break;
        }
        chunk += ch;
      }
      line = chunk;
      if (lines.length >= maxLines) { line = ''; break; }
    } else {
      line = token;
    }
  }
  pushLine();
  if (!lines.length) lines.push('');
  if (lines.length > maxLines) lines.length = maxLines;
  const joined = lines.join('');
  if (joined.length < source.replace(/\s/g, '').length && lines.length) {
    let last = lines[maxLines - 1] ?? '';
    while (last && textWidth(last + '…', fontSize) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

export function fmtNumber(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Object.is(n, -0)) return '0';
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) {
    return n.toExponential(Math.min(3, digits)).replace('e+', 'e');
  }
  const s = n.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export function decimalsForStep(step) {
  const s = Math.abs(Number(step));
  if (!Number.isFinite(s) || s <= 0) return 2;
  const d = Math.max(0, Math.ceil(-Math.log10(s)));
  return Math.min(6, d);
}

export function fmtTick(value, step) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) < 1e-12) return '0';
  return fmtNumber(n, decimalsForStep(step));
}

/** 把一个刻度标成 π 的分数；不是 π 的整齐倍数时退回数字。 */
export function fmtPiTick(value, step) {
  const n = Number(value);
  const pi = Math.PI;
  if (!Number.isFinite(n) || !Number.isFinite(step) || step <= 0) return fmtTick(n, step);
  const denom = Math.round(pi / step);
  if (!Number.isFinite(denom) || denom < 1 || denom > 24) return fmtTick(n, step);
  const num = Math.round(n / (pi / denom));
  if (Math.abs(n - num * (pi / denom)) > Math.max(1e-9, Math.abs(n) * 1e-9)) return fmtTick(n, step);
  if (num === 0) return '0';
  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; };
  const g = gcd(num, denom);
  const p = num / g;
  const q = denom / g;
  const sign = p < 0 ? '−' : '';
  const absP = Math.abs(p);
  const head = absP === 1 ? 'π' : absP + 'π';
  return q === 1 ? sign + head : sign + head + '/' + q;
}

export function svgText({ x, y, text, size = 20, fill = '#222', anchor = 'start', weight = 400, family = FONT_FAMILY, opacity = 1, baseline = 'auto' }) {
  const dominant = baseline === 'middle' ? ' dominant-baseline="middle"' : '';
  return '<text x="' + fmtNumber(x, 2) + '" y="' + fmtNumber(y, 2) + '" font-family="' + family + '" font-size="' + size
    + '" font-weight="' + weight + '" fill="' + fill + '" text-anchor="' + anchor + '"' + dominant
    + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '>' + escapeXml(text) + '</text>';
}

export function svgLine(x1, y1, x2, y2, { stroke = '#222', width = 2, dash = '', opacity = 1, cap = 'round' } = {}) {
  return '<line x1="' + fmtNumber(x1, 2) + '" y1="' + fmtNumber(y1, 2) + '" x2="' + fmtNumber(x2, 2) + '" y2="' + fmtNumber(y2, 2)
    + '" stroke="' + stroke + '" stroke-width="' + width + '" stroke-linecap="' + cap + '"'
    + (dash ? ' stroke-dasharray="' + dash + '"' : '') + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '/>';
}

export function svgRect({ x, y, w, h, fill = 'none', stroke = 'none', width = 1, rx = 0, opacity = 1 }) {
  return '<rect x="' + fmtNumber(x, 2) + '" y="' + fmtNumber(y, 2) + '" width="' + fmtNumber(w, 2) + '" height="' + fmtNumber(h, 2)
    + '" rx="' + rx + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + width + '"'
    + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '/>';
}

export function svgCircle(cx, cy, r, { fill = 'none', stroke = 'none', width = 1, opacity = 1 } = {}) {
  return '<circle cx="' + fmtNumber(cx, 2) + '" cy="' + fmtNumber(cy, 2) + '" r="' + fmtNumber(r, 2)
    + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + width + '"'
    + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '/>';
}

export function svgPath(d, { fill = 'none', stroke = '#222', width = 2, dash = '', opacity = 1, linejoin = 'round', linecap = 'round' } = {}) {
  return '<path d="' + d + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + width
    + '" stroke-linejoin="' + linejoin + '" stroke-linecap="' + linecap + '"'
    + (dash ? ' stroke-dasharray="' + dash + '"' : '') + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '/>';
}

/** 点数组 → SVG path，null 作为断点。 */
export function pathFromPoints(points) {
  let d = '';
  let drawing = false;
  for (const p of points) {
    if (!p) { drawing = false; continue; }
    d += (drawing ? 'L' : 'M') + fmtNumber(p.x, 2) + ' ' + fmtNumber(p.y, 2) + ' ';
    drawing = true;
  }
  return d.trim();
}

/** 圆角矩形盒子 + 多行文字，返回 SVG 片段与盒子尺寸。 */
export function textBox({ x, y, w, h, lines, size, color, weight = 400, anchor = 'middle', padding = 10, lineHeight = 1.25 }) {
  let out = '';
  const total = lines.length * size * lineHeight;
  const first = y + h / 2 - total / 2 + size * 0.82;
  for (let i = 0; i < lines.length; i += 1) {
    const tx = anchor === 'middle' ? x + w / 2 : (anchor === 'end' ? x + w - padding : x + padding);
    out += svgText({ x: tx, y: first + i * size * lineHeight, text: lines[i], size, fill: color, weight, anchor });
  }
  return out;
}
