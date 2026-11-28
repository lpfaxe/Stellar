// 一元函数图：y=f(x)，支持 1–4 条曲线、分段定义域、切线与积分阴影。
import { compileExpression, ExprError } from './expr.js';
import { DiagramError } from './errors.js';
import { COLORS, clipPath, drawAxes, drawLegend, equalizeRanges, makeFrame, makeScales, svgFooter, svgHeader } from './axes.js';
import { fmtNumber, pathFromPoints, svgCircle, svgLine, svgPath, svgText } from './svg.js';

const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;
const MAX_FUNCTIONS = 4;
const MAX_SAMPLES = 2000;

function clampNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizePlotSize(width, height) {
  const w = Math.max(320, Math.min(1200, Math.round(clampNumber(width, DEFAULT_WIDTH))));
  const h = Math.max(320, Math.min(1200, Math.round(clampNumber(height, DEFAULT_HEIGHT))));
  return { width: w, height: h };
}

function normalizeRange(range, name, fallback) {
  if (range == null) return fallback.slice();
  if (!Array.isArray(range) || range.length !== 2) throw new DiagramError('BAD_RANGE', name + ' 必须是 [min, max] 两个数', '例如 xRange: [-6.28, 6.28]');
  const a = Number(range[0]);
  const b = Number(range[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) throw new DiagramError('BAD_RANGE', name + ' 必须是两个不同的有限数', '例如 xRange: [-6.28, 6.28]');
  return a < b ? [a, b] : [b, a];
}

function isPiAligned(v) {
  const unit = Math.PI / 2;
  return Math.abs(v / unit - Math.round(v / unit)) < 1e-9;
}

function defaultXRange(expressions) {
  const trig = expressions.some((e) => /(sin|cos|tan|sec|csc|cot)/i.test(e));
  return trig ? [-2 * Math.PI, 2 * Math.PI] : [-5, 5];
}

/** 取 2%–98% 分位，避开 tan/1/x 的极端值把正常曲线压扁。 */
function autoYRange(values) {
  const finite = values.filter((v) => Number.isFinite(v) && Math.abs(v) < 1e12).sort((a, b) => a - b);
  if (!finite.length) return [-1, 1];
  const n = finite.length;
  let lo = n >= 20 ? finite[Math.floor(n * 0.02)] : finite[0];
  let hi = n >= 20 ? finite[Math.floor(n * 0.98)] : finite[n - 1];
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const pad = Math.max((hi - lo) * 0.12, 1e-6);
  return [lo - pad, hi + pad];
}

function sampleFunction(compiled, xMin, xMax, count) {
  const points = [];
  const n = Math.max(80, Math.min(MAX_SAMPLES, count));
  for (let i = 0; i <= n; i += 1) {
    const x = xMin + ((xMax - xMin) * i) / n;
    let y;
    try { y = compiled.eval({ x, t: x, theta: x, y: x }); } catch { y = NaN; }
    points.push({ x, y: Number.isFinite(y) ? y : null });
  }
  return points;
}

function buildScreenPath(points, scales, ySpan, plotH) {
  const screen = [];
  let prev = null;
  for (const p of points) {
    if (p.y == null) { screen.push(null); prev = null; continue; }
    const py = scales.sy(p.y);
    const px = scales.sx(p.x);
    if (prev && Math.abs(py - prev.y) > plotH * 0.62) {
      // 采样跨过渐近线：断开，避免画出垂直长线
      screen.push(null);
    }
    screen.push({ x: px, y: py });
    prev = { x: px, y: py, value: p.y };
  }
  return screen;
}

function tangentLine(compiled, x0, xMin, xMax, scales) {
  const h = Math.max(1e-7, (xMax - xMin) * 1e-6);
  const y0 = compiled.eval({ x: x0, t: x0, theta: x0, y: x0 });
  const yl = compiled.eval({ x: x0 - h, t: x0 - h, theta: x0 - h, y: x0 - h });
  const yr = compiled.eval({ x: x0 + h, t: x0 + h, theta: x0 + h, y: x0 + h });
  if (![y0, yl, yr].every((v) => Number.isFinite(v))) return null;
  const slope = (yr - yl) / (2 * h);
  if (!Number.isFinite(slope)) return null;
  const dx = Math.max((xMax - xMin) * 0.18, h * 10);
  const a = Math.max(xMin, x0 - dx);
  const b = Math.min(xMax, x0 + dx);
  return {
    slope,
    x0,
    y0,
    a,
    b,
    x1: scales.sx(a),
    y1: scales.sy(y0 + slope * (a - x0)),
    x2: scales.sx(b),
    y2: scales.sy(y0 + slope * (b - x0)),
  };
}

function integralArea(compiled, a, b, scales, plot) {
  const n = 500;
  const pts = [];
  let sum = 0;
  let prevY = null;
  for (let i = 0; i <= n; i += 1) {
    const x = a + ((b - a) * i) / n;
    const y = compiled.eval({ x, t: x, theta: x, y: x });
    if (!Number.isFinite(y)) return null;
    pts.push({ x: scales.sx(x), y: scales.sy(y) });
    if (prevY != null) sum += ((prevY + y) / 2) * ((b - a) / n);
    prevY = y;
  }
  const y0 = Math.max(plot.y, Math.min(plot.y + plot.h, scales.sy(0)));
  const poly = pts.concat([{ x: pts[pts.length - 1].x, y: y0 }, { x: pts[0].x, y: y0 }]);
  return { path: pathFromPoints(poly) + ' Z', value: sum };
}

function normalizeFunctions(functions) {
  const list = Array.isArray(functions) ? functions : [functions];
  if (!list.length) throw new DiagramError('NO_FUNCTIONS', '至少给一条函数表达式', '例如 functions: [{ expression: "sin(x)" }]');
  if (list.length > MAX_FUNCTIONS) throw new DiagramError('TOO_MANY_FUNCTIONS', '最多同时画 ' + MAX_FUNCTIONS + ' 条函数', '把不重要的曲线去掉，或分成两张图。');
  return list.map((raw, i) => {
    const item = typeof raw === 'string' ? { expression: raw } : (raw || {});
    const expression = String(item.expression ?? '').trim();
    if (!expression) throw new DiagramError('EMPTY_EXPRESSION', '第 ' + (i + 1) + ' 条函数没有表达式', '例如 expression: "x^2 - 1"');
    let compiled;
    try { compiled = compileExpression(expression, { variables: ['x'] }); }
    catch (err) {
      if (err instanceof ExprError) throw new DiagramError('EXPR_ERROR', '第 ' + (i + 1) + ' 条函数表达式有误：' + err.message, err.hint || '只支持 x、数字、+ - * / ^、括号和常见函数；函数名要带括号，如 sin(x)。');
      throw err;
    }
    const label = String(item.label ?? ('y = ' + expression)).slice(0, 60);
    const color = /^#[0-9a-f]{3,8}$/i.test(String(item.color ?? '')) ? item.color : COLORS[i % COLORS.length];
    let domain = null;
    if (item.domain != null) {
      if (!Array.isArray(item.domain) || item.domain.length !== 2) throw new DiagramError('BAD_DOMAIN', '第 ' + (i + 1) + ' 条函数的 domain 必须是 [a, b]', '例如 domain: [0, 3.14]');
      const a = Number(item.domain[0]);
      const b = Number(item.domain[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) throw new DiagramError('BAD_DOMAIN', '第 ' + (i + 1) + ' 条函数的 domain 无效', 'domain 要满足 a < b。');
      domain = [a, b];
    }
    const tangentAt = item.tangentAt == null ? null : Number(item.tangentAt);
    if (tangentAt != null && !Number.isFinite(tangentAt)) throw new DiagramError('BAD_TANGENT', '第 ' + (i + 1) + ' 条函数的 tangentAt 不是有限数', '例如 tangentAt: 1');
    let integral = null;
    if (item.integral != null) {
      if (!Array.isArray(item.integral) || item.integral.length !== 2) throw new DiagramError('BAD_INTEGRAL', '第 ' + (i + 1) + ' 条函数的 integral 必须是 [a, b]', '例如 integral: [0, 2]');
      const a = Number(item.integral[0]);
      const b = Number(item.integral[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) throw new DiagramError('BAD_INTEGRAL', '第 ' + (i + 1) + ' 条函数的积分区间无效', 'integral 要满足 a ≠ b。');
      integral = a < b ? [a, b] : [b, a];
    }
    return { expression, compiled, label, color, domain, tangentAt, integral };
  });
}

/**
 * 主入口。返回 { svg, width, height, meta }，不落盘（落盘由 render.js 负责）。
 */
export function plotFunction(options = {}) {
  const { width, height } = normalizePlotSize(options.width, options.height);
  const fns = normalizeFunctions(options.functions);
  const expressions = fns.map((f) => f.expression);
  const xRange = normalizeRange(options.xRange, 'xRange', defaultXRange(expressions));
  if (xRange[1] - xRange[0] > 1e6) throw new DiagramError('RANGE_TOO_LARGE', 'xRange 跨度太大', '跨度不要超过 1e6。');
  const sampleCount = Math.max(400, Math.min(MAX_SAMPLES, Math.round(clampNumber(options.samples, width * 2))));
  const allValues = [];

  for (const fn of fns) {
    const a = Math.max(xRange[0], fn.domain ? fn.domain[0] : xRange[0]);
    const b = Math.min(xRange[1], fn.domain ? fn.domain[1] : xRange[1]);
    if (!(b > a)) throw new DiagramError('EMPTY_DOMAIN', '函数「' + fn.expression + '」的定义域与 xRange 没有交集', '检查 domain 或放宽 xRange。');
    fn.a = a;
    fn.b = b;
    fn.points = sampleFunction(fn.compiled, a, b, sampleCount);
    for (const p of fn.points) if (p.y != null) allValues.push(p.y);
  }

  let yRange;
  if (options.yRange != null) {
    yRange = normalizeRange(options.yRange, 'yRange', [-1, 1]);
  } else {
    yRange = autoYRange(allValues);
  }
  if (!(yRange[1] > yRange[0])) throw new DiagramError('BAD_RANGE', 'yRange 无效', 'yRange 要满足 min < max。');

  const equalAspect = options.equalAspect === true || options.equalAspect === 1;
  const frame = makeFrame({ width, height, equalAspect });
  if (equalAspect) {
    const eq = equalizeRanges(xRange[0], xRange[1], yRange[0], yRange[1], frame.plot.w, frame.plot.h);
    xRange[0] = eq.xMin; xRange[1] = eq.xMax;
    yRange[0] = eq.yMin; yRange[1] = eq.yMax;
  }
  const scales = makeScales(frame, xRange[0], xRange[1], yRange[0], yRange[1]);
  const ySpan = yRange[1] - yRange[0];
  const xUnit = options.xUnit === 'pi' || (options.xUnit !== 'number' && isPiAligned(xRange[0]) && isPiAligned(xRange[1]) && (xRange[1] - xRange[0]) <= 20 * Math.PI) ? 'pi' : 'number';
  const title = String(options.title ?? (fns.length === 1 ? fns[0].label : '函数图')).slice(0, 120);
  const axis = drawAxes(frame, scales, {
    xUnit,
    yUnit: 'number',
    xTicks: clampNumber(options.xTicks, 6),
    yTicks: clampNumber(options.yTicks, 6),
    title,
    xLabel: String(options.xLabel ?? 'x'),
    yLabel: String(options.yLabel ?? 'y'),
    grid: options.grid !== false,
  });

  const clipId = 'plot-clip';
  const body = [svgHeader(width, height), clipPath(frame, clipId), axis.svg, '<g clip-path="url(#' + clipId + ')">'];
  const legend = [];
  const meta = { functions: [], xRange, yRange, xUnit, width, height, samples: sampleCount, integrals: [] };

  for (const fn of fns) {
    legend.push({ label: fn.label, color: fn.color });
    if (fn.integral) {
      const area = integralArea(fn.compiled, Math.max(fn.a, fn.integral[0]), Math.min(fn.b, fn.integral[1]), scales, frame.plot);
      if (area) {
        body.push(svgPath(area.path, { fill: fn.color, opacity: 0.15, stroke: 'none' }));
        meta.integrals.push({ expression: fn.expression, from: fn.integral[0], to: fn.integral[1], value: area.value });
        const labelX = Math.max(frame.plot.x + 8, Math.min(frame.plot.x + frame.plot.w - 8, scales.sx((fn.integral[0] + fn.integral[1]) / 2)));
        body.push(svgText({ x: labelX, y: frame.plot.y + 20, text: '∫ ≈ ' + fmtNumber(area.value, 4), size: 15, fill: fn.color, anchor: 'middle', weight: 600 }));
      }
    }
    const screen = buildScreenPath(fn.points, scales, ySpan, frame.plot.h);
    body.push(svgPath(pathFromPoints(screen), { stroke: fn.color, width: 2.6 }));
    meta.functions.push({ expression: fn.expression, label: fn.label, domain: [fn.a, fn.b] });

    if (fn.tangentAt != null && fn.tangentAt >= fn.a && fn.tangentAt <= fn.b) {
      const t = tangentLine(fn.compiled, fn.tangentAt, fn.a, fn.b, scales);
      if (t) {
        body.push(svgLine(t.x1, t.y1, t.x2, t.y2, { stroke: fn.color, width: 1.6, dash: '7 5', opacity: 0.85 }));
        body.push(svgCircle(t.x0, scales.sy(t.y0), 4.5, { fill: '#ffffff', stroke: fn.color, width: 2.2 }));
        legend.push({ label: '切线 x=' + fmtNumber(fn.tangentAt, 4), color: fn.color });
        meta.tangents = meta.tangents || [];
        meta.tangents.push({ expression: fn.expression, at: fn.tangentAt, value: t.y0, slope: t.slope });
      }
    }
  }
  body.push('</g>');
  body.push(drawLegend(frame, legend));
  body.push(svgFooter());
  return { svg: body.join(''), width, height, meta };
}
