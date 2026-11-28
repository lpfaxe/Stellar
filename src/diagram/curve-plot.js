// 参数曲线与极坐标曲线。参数用 t，极坐标用 theta（也接受 t）。
import { compileExpression, ExprError } from './expr.js';
import { DiagramError } from './errors.js';
import { COLORS, clipPath, drawAxes, drawLegend, equalizeRanges, makeFrame, makeScales, svgFooter, svgHeader } from './axes.js';
import { pathFromPoints, svgPath, svgText } from './svg.js';

const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;
const MAX_CURVES = 3;
const MAX_SAMPLES = 4000;

function normalizeRange(range, name, fallback) {
  if (range == null) return fallback.slice();
  if (!Array.isArray(range) || range.length !== 2) throw new DiagramError('BAD_RANGE', name + ' 必须是 [min, max] 两个数', '例如 range: [0, 6.283]');
  const a = Number(range[0]);
  const b = Number(range[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) throw new DiagramError('BAD_RANGE', name + ' 必须是两个不同的有限数', '例如 range: [0, 6.283]');
  if (Math.abs(b - a) > 1000 * Math.PI) throw new DiagramError('RANGE_TOO_LARGE', name + ' 跨度太大', '参数范围不要超过 1000π。');
  return a < b ? [a, b] : [b, a];
}

function normalizeCurves(curves) {
  const list = Array.isArray(curves) ? curves : [curves];
  if (!list.length) throw new DiagramError('NO_CURVES', '至少给一条曲线', '例如 curves: [{ kind: "parametric", x: "cos(t)", y: "sin(t)", range: [0, 6.283] }]');
  if (list.length > MAX_CURVES) throw new DiagramError('TOO_MANY_CURVES', '最多同时画 ' + MAX_CURVES + ' 条曲线', '把不重要的曲线去掉，或分成两张图。');
  return list.map((raw, i) => {
    const item = raw || {};
    const kind = String(item.kind || item.mode || (item.r != null ? 'polar' : 'parametric')).toLowerCase();
    const color = /^#[0-9a-f]{3,8}$/i.test(String(item.color ?? '')) ? item.color : COLORS[i % COLORS.length];
    const range = normalizeRange(item.range ?? item.tRange ?? item.thetaRange, 'range', [0, 2 * Math.PI]);
    if (kind === 'polar' || kind === 'r') {
      const expression = String(item.r ?? item.expression ?? '').trim();
      if (!expression) throw new DiagramError('EMPTY_EXPRESSION', '第 ' + (i + 1) + ' 条极坐标曲线没有 r 表达式', '例如 r: "1 + cos(theta)"');
      let compiled;
      try { compiled = compileExpression(expression, { variables: ['t', 'theta'] }); }
      catch (err) {
        if (err instanceof ExprError) throw new DiagramError('EXPR_ERROR', '第 ' + (i + 1) + ' 条极坐标表达式有误：' + err.message, err.hint || '只支持 theta、数字、+ - * / ^、括号和常见函数。');
        throw err;
      }
      return { kind: 'polar', expression, compiled, range, color, label: String(item.label ?? ('r = ' + expression)).slice(0, 60) };
    }
    if (kind !== 'parametric' && kind !== 'param') throw new DiagramError('BAD_KIND', '第 ' + (i + 1) + ' 条曲线的 kind 只能是 parametric 或 polar', '例如 kind: "parametric"');
    const sx = String(item.x ?? '').trim();
    const sy = String(item.y ?? '').trim();
    if (!sx || !sy) throw new DiagramError('EMPTY_EXPRESSION', '第 ' + (i + 1) + ' 条参数曲线缺少 x 或 y 表达式', '例如 x: "cos(t)", y: "sin(t)"');
    let cx; let cy;
    try {
      cx = compileExpression(sx, { variables: ['t', 'theta'] });
      cy = compileExpression(sy, { variables: ['t', 'theta'] });
    } catch (err) {
      if (err instanceof ExprError) throw new DiagramError('EXPR_ERROR', '第 ' + (i + 1) + ' 条参数曲线表达式有误：' + err.message, err.hint || '只支持 t、数字、+ - * / ^、括号和常见函数。');
      throw err;
    }
    return {
      kind: 'parametric', xExpr: sx, yExpr: sy, cx, cy, range, color,
      label: String(item.label ?? ('(' + sx + ', ' + sy + ')')).slice(0, 60),
    };
  });
}

function pointsFor(curve, n) {
  const [a, b] = curve.range;
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const t = a + ((b - a) * i) / n;
    let x; let y;
    try {
      if (curve.kind === 'polar') {
        const r = curve.compiled.eval({ t, theta: t, x: t, y: t });
        x = r * Math.cos(t);
        y = r * Math.sin(t);
      } else {
        x = curve.cx.eval({ t, theta: t, x: t, y: t });
        y = curve.cy.eval({ t, theta: t, x: t, y: t });
      }
    } catch { x = NaN; y = NaN; }
    out.push({ x: Number.isFinite(x) ? x : null, y: Number.isFinite(y) ? y : null });
  }
  return out;
}

function boundsOf(points) {
  let xMin = Infinity; let xMax = -Infinity; let yMin = Infinity; let yMax = -Infinity;
  for (const p of points) {
    if (p.x == null || p.y == null) continue;
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return null;
  return { xMin, xMax, yMin, yMax };
}

function padBounds(bounds) {
  let { xMin, xMax, yMin, yMax } = bounds;
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  if (!(xSpan > 0) && !(ySpan > 0)) return { xMin: xMin - 1, xMax: xMax + 1, yMin: yMin - 1, yMax: yMax + 1 };
  const padX = Math.max(xSpan * 0.08, 1e-6);
  const padY = Math.max(ySpan * 0.08, 1e-6);
  return { xMin: xMin - padX, xMax: xMax + padX, yMin: yMin - padY, yMax: yMax + padY };
}

/**
 * 主入口。曲线在平面上的几何形状需要等比，所以默认 equalAspect=true。
 */
export function plotCurve(options = {}) {
  const width = Math.max(320, Math.min(1200, Math.round(Number(options.width) || DEFAULT_WIDTH)));
  const height = Math.max(320, Math.min(1200, Math.round(Number(options.height) || DEFAULT_HEIGHT)));
  const curves = normalizeCurves(options.curves);
  const n = Math.max(200, Math.min(MAX_SAMPLES, Math.round(Number(options.samples) || (width >= 700 ? 2400 : 1600))));

  for (const c of curves) c.points = pointsFor(c, n);
  const all = curves.flatMap((c) => c.points);
  const raw = boundsOf(all);
  if (!raw) throw new DiagramError('NO_FINITE_VALUES', '曲线在给定范围内没有有限坐标', '检查表达式是否对所有参数都产生 NaN，或换一个 range。');

  let xMin; let xMax; let yMin; let yMax;
  if (options.xRange != null || options.yRange != null) {
    const xr = normalizeRange(options.xRange, 'xRange', [raw.xMin, raw.xMax]);
    const yr = normalizeRange(options.yRange, 'yRange', [raw.yMin, raw.yMax]);
    xMin = xr[0]; xMax = xr[1]; yMin = yr[0]; yMax = yr[1];
  } else {
    const padded = padBounds(raw);
    xMin = padded.xMin; xMax = padded.xMax; yMin = padded.yMin; yMax = padded.yMax;
  }

  const equalAspect = options.equalAspect !== false && options.equalAspect !== 0;
  const frame = makeFrame({ width, height, equalAspect });
  if (equalAspect) {
    const eq = equalizeRanges(xMin, xMax, yMin, yMax, frame.plot.w, frame.plot.h);
    xMin = eq.xMin; xMax = eq.xMax; yMin = eq.yMin; yMax = eq.yMax;
  }
  const scales = makeScales(frame, xMin, xMax, yMin, yMax);
  const title = String(options.title ?? (curves.length === 1 ? curves[0].label : '参数曲线')).slice(0, 120);
  const axis = drawAxes(frame, scales, {
    xUnit: 'number', yUnit: 'number',
    xTicks: Number(options.xTicks) || 6, yTicks: Number(options.yTicks) || 6,
    title,
    xLabel: String(options.xLabel ?? 'x'), yLabel: String(options.yLabel ?? 'y'),
    grid: options.grid !== false,
  });

  const clipId = 'curve-clip';
  const body = [svgHeader(width, height), clipPath(frame, clipId), axis.svg, '<g clip-path="url(#' + clipId + ')">'];
  for (const c of curves) {
    const screen = [];
    let prev = null;
    for (const p of c.points) {
      if (p.x == null || p.y == null) { screen.push(null); prev = null; continue; }
      const px = scales.sx(p.x);
      const py = scales.sy(p.y);
      if (prev && (Math.abs(py - prev.y) > frame.plot.h * 0.8 || Math.abs(px - prev.x) > frame.plot.w * 0.8)) {
        screen.push(null);
      }
      screen.push({ x: px, y: py });
      prev = { x: px, y: py };
    }
    body.push(svgPath(pathFromPoints(screen), { stroke: c.color, width: 2.6 }));
  }
  body.push('</g>');
  body.push(drawLegend(frame, curves.map((c) => ({ label: c.label, color: c.color }))));
  body.push(svgFooter());

  return {
    svg: body.join(''),
    width,
    height,
    meta: {
      curves: curves.map((c) => ({ kind: c.kind, expression: c.expression || (c.xExpr + ', ' + c.yExpr), label: c.label, range: c.range })),
      xRange: [xMin, xMax], yRange: [yMin, yMax], samples: n,
    },
  };
}
