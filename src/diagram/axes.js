// 坐标轴、刻度、网格。所有绘图共用，保证函数图/参数图/极坐标视觉一致。
import { svgLine, svgPath, svgText, fmtNumber, fmtTick, fmtPiTick, textWidth } from './svg.js';

export const COLORS = Object.freeze(['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2']);

export function niceStep(range, target = 6, unit = 'number') {
  const r = Math.abs(Number(range));
  if (!Number.isFinite(r) || r <= 0) return unit === 'pi' ? Math.PI / 2 : 1;
  if (unit === 'pi') {
    const raw = r / Math.PI / Math.max(1, target);
    const candidates = [1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 1, 2, 4, 8];
    for (const c of candidates) if (raw <= c) return c * Math.PI;
    return 8 * Math.PI;
  }
  const exp = Math.floor(Math.log10(r / Math.max(1, target)));
  const base = Math.pow(10, exp);
  const frac = r / Math.max(1, target) / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * base;
}

export function axisTicks(min, max, { target = 6, unit = 'number' } = {}) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return { ticks: [], step: 1 };
  const step = niceStep(b - a, target, unit);
  const start = Math.ceil(a / step - 1e-9) * step;
  const ticks = [];
  for (let v = start, i = 0; v <= b + step * 1e-7 && i < 40; v += step, i += 1) {
    const n = Math.abs(v) < step * 1e-7 ? 0 : v;
    ticks.push(n);
  }
  return { ticks, step };
}

export function svgHeader(width, height, background = '#ffffff') {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">'
    + '<rect width="' + width + '" height="' + height + '" fill="' + background + '"/>';
}

export function svgFooter() { return '</svg>'; }

/** 让 x/y 的单位长度一致（参数曲线/极坐标不能画扁）。 */
export function equalizeRanges(xMin, xMax, yMin, yMax, plotW, plotH) {
  let xa = Number(xMin);
  let xb = Number(xMax);
  let ya = Number(yMin);
  let yb = Number(yMax);
  if (!(xb > xa)) { xa = -1; xb = 1; }
  if (!(yb > ya)) { ya = -1; yb = 1; }
  const xr = xb - xa;
  const yr = yb - ya;
  if (!(plotW > 0) || !(plotH > 0)) return { xMin: xa, xMax: xb, yMin: ya, yMax: yb };
  const unitsPerPxX = xr / plotW;
  const unitsPerPxY = yr / plotH;
  if (unitsPerPxX > unitsPerPxY) {
    const target = xr * plotH / plotW;
    const mid = (ya + yb) / 2;
    ya = mid - target / 2;
    yb = mid + target / 2;
  } else {
    const target = yr * plotW / plotH;
    const mid = (xa + xb) / 2;
    xa = mid - target / 2;
    xb = mid + target / 2;
  }
  return { xMin: xa, xMax: xb, yMin: ya, yMax: yb };
}

/**
 * 计算绘图区。equalAspect=true 时在可用区域里取正方形，避免曲线被拉扁。
 */
export function makeFrame({ width, height, padding = {}, equalAspect = false }) {
  const pad = { left: 58, right: 28, top: 58, bottom: 52, ...padding };
  let x = pad.left;
  let y = pad.top;
  let w = Math.max(40, width - pad.left - pad.right);
  let h = Math.max(40, height - pad.top - pad.bottom);
  if (equalAspect) {
    const size = Math.min(w, h);
    x += (w - size) / 2;
    y += (h - size) / 2;
    w = size;
    h = size;
  }
  return { width, height, pad, plot: { x, y, w, h } };
}

export function makeScales(frame, xMin, xMax, yMin, yMax) {
  const { x, y, w, h } = frame.plot;
  const sx = (v) => x + ((Number(v) - xMin) / (xMax - xMin)) * w;
  const sy = (v) => y + h - ((Number(v) - yMin) / (yMax - yMin)) * h;
  return { sx, sy, xMin, xMax, yMin, yMax };
}

/** 轴线的位置：数据 0 在范围内就用 0，否则用边框。 */
function axisPositions(frame, xMin, xMax, yMin, yMax) {
  const { x, y, w, h } = frame.plot;
  const x0 = (xMin <= 0 && xMax >= 0) ? x + ((0 - xMin) / (xMax - xMin)) * w : x;
  const y0 = (yMin <= 0 && yMax >= 0) ? y + h - ((0 - yMin) / (yMax - yMin)) * h : y + h;
  return { x0, y0 };
}

/**
 * 画网格、坐标轴、刻度、标题。
 * 刻度标签放在轴线旁；轴在边框上时也仍然可读。
 */
export function drawAxes(frame, scales, {
  xUnit = 'number', yUnit = 'number', xTicks = 6, yTicks = 6,
  title = '', xLabel = 'x', yLabel = 'y', grid = true,
  xTickFormat = null, yTickFormat = null,
} = {}) {
  const { x, y, w, h } = frame.plot;
  const { xMin, xMax, yMin, yMax } = scales;
  const parts = [];
  const xt = axisTicks(xMin, xMax, { target: xTicks, unit: xUnit });
  const yt = axisTicks(yMin, yMax, { target: yTicks, unit: yUnit });
  const { x0, y0 } = axisPositions(frame, xMin, xMax, yMin, yMax);

  if (grid) {
    for (const v of xt.ticks) {
      const px = scales.sx(v);
      parts.push(svgLine(px, y, px, y + h, { stroke: '#e8edf3', width: 1, opacity: 0.9 }));
    }
    for (const v of yt.ticks) {
      const py = scales.sy(v);
      parts.push(svgLine(x, py, x + w, py, { stroke: '#e8edf3', width: 1, opacity: 0.9 }));
    }
  }

  // 轴线（深一点）+ 箭头
  parts.push(svgLine(x, y0, x + w, y0, { stroke: '#334155', width: 2.2 }));
  parts.push(svgLine(x0, y + h, x0, y, { stroke: '#334155', width: 2.2 }));
  const arrow = 7;
  parts.push('<path d="M ' + (x + w) + ' ' + y0 + ' l -' + arrow + ' -' + (arrow * 0.62) + ' l 0 ' + (arrow * 1.24) + ' z" fill="#334155"/>');
  parts.push('<path d="M ' + x0 + ' ' + y + ' l -' + (arrow * 0.62) + ' ' + arrow + ' l ' + (arrow * 1.24) + ' 0 z" fill="#334155"/>');

  // 刻度与标签
  const xLabelBelowAxis = y0 + 20 <= y + h + 22;
  const originVisible = xMin < 0 && xMax > 0 && yMin < 0 && yMax > 0;
  for (const v of xt.ticks) {
    const px = scales.sx(v);
    parts.push(svgLine(px, y0 - 4, px, y0 + 4, { stroke: '#334155', width: 1.5 }));
    // 原点只由 y 轴上的 0 标一次，避免两个 0 叠在一起。
    if (originVisible && Math.abs(v) < xt.step * 1e-9) continue;
    const label = xTickFormat ? xTickFormat(v, xt.step) : (xUnit === 'pi' ? fmtPiTick(v, xt.step) : fmtTick(v, xt.step));
    const ly = xLabelBelowAxis ? y0 + 19 : y + h + 19;
    parts.push(svgText({ x: px, y: ly, text: label, size: 14, fill: '#475569', anchor: 'middle' }));
  }
  for (const v of yt.ticks) {
    const py = scales.sy(v);
    const px = x0;
    parts.push(svgLine(px - 4, py, px + 4, py, { stroke: '#334155', width: 1.5 }));
    const label = yTickFormat ? yTickFormat(v, yt.step) : (yUnit === 'pi' ? fmtPiTick(v, yt.step) : fmtTick(v, yt.step));
    const lx = px - 8 >= x + 2 ? px - 8 : x + 4;
    const anchor = px - 8 >= x + 2 ? 'end' : 'start';
    parts.push(svgText({ x: lx, y: py + 5, text: label, size: 14, fill: '#475569', anchor }));
  }

  // 轴名
  parts.push(svgText({ x: x + w - 2, y: y0 - 10, text: 'x', size: 18, fill: '#334155', anchor: 'end', weight: 600 }));
  parts.push(svgText({ x: x0 + 10, y: y + 8, text: 'y', size: 18, fill: '#334155', anchor: 'start', weight: 600 }));
  if (xLabel && xLabel !== 'x') parts.push(svgText({ x: x + w, y: y + h + 44, text: xLabel, size: 16, fill: '#475569', anchor: 'end' }));
  if (yLabel && yLabel !== 'y') parts.push(svgText({ x: x + 4, y: y - 10, text: yLabel, size: 16, fill: '#475569', anchor: 'start' }));

  if (title) {
    const maxW = frame.width - 24;
    const size = title.length > 24 ? 18 : 22;
    let t = title;
    while (t.length > 2 && textWidth(t, size) > maxW) t = t.slice(0, -1);
    if (t !== title) t = t.slice(0, -1) + '…';
    parts.push(svgText({ x: frame.width / 2, y: 32, text: t, size, fill: '#0f172a', anchor: 'middle', weight: 700 }));
  }
  return { svg: parts.join(''), xTicks: xt, yTicks: yt, axis: { x0, y0 } };
}

/** 图例：放在绘图区左上角，最多 4 条。 */
export function drawLegend(frame, entries) {
  if (!entries || entries.length <= 1) return '';
  const { x, y } = frame.plot;
  const size = 14;
  const lineH = 20;
  const boxW = Math.min(frame.plot.w - 16, Math.max(...entries.map((e) => textWidth(e.label, size))) + 42);
  const boxH = entries.length * lineH + 12;
  const parts = ['<rect x="' + (x + 8) + '" y="' + (y + 8) + '" width="' + boxW + '" height="' + boxH + '" rx="7" fill="#ffffff" fill-opacity="0.88" stroke="#e2e8f0"/>'];
  entries.forEach((e, i) => {
    const cy = y + 8 + 12 + i * lineH;
    parts.push(svgLine(x + 16, cy, x + 38, cy, { stroke: e.color || COLORS[i % COLORS.length], width: 3 }));
    parts.push(svgText({ x: x + 44, y: cy + 5, text: e.label, size, fill: '#334155' }));
  });
  return parts.join('');
}

/** 安全裁剪：调用方用这个 id 包住曲线，防止越出绘图区。 */
export function clipPath(frame, id) {
  const { x, y, w, h } = frame.plot;
  return '<defs><clipPath id="' + id + '"><rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/></clipPath></defs>';
}
