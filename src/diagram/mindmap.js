// 思维导图：根居中、一级分支按子树高度分到左右两侧，最多 5 层 / 60 节点。
import { DiagramError } from './errors.js';
import { COLORS, svgFooter, svgHeader } from './axes.js';
import { fmtNumber, svgPath, svgRect, svgText, textWidth, wrapText } from './svg.js';

const MAX_NODES = 60;
const MAX_DEPTH = 4; // 根 + 4 层 = 5 层
const MAX_CHILDREN = 12;
const MAX_TEXT = 32;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1400;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;
const MARGIN = 32;

const METRICS = Object.freeze([
  { font: 16, rootFont: 20, maxTextW: 220, rootTextW: 250, gapX: 36, gapY: 12, padX: 12, padY: 8 },
  { font: 14.5, rootFont: 18, maxTextW: 210, rootTextW: 235, gapX: 28, gapY: 9, padX: 11, padY: 7 },
  { font: 13, rootFont: 16, maxTextW: 190, rootTextW: 210, gapX: 22, gapY: 7, padX: 10, padY: 6 },
  { font: 12, rootFont: 15, maxTextW: 175, rootTextW: 195, gapX: 18, gapY: 6, padX: 9, padY: 5 },
]);

function normalizeText(value, path) {
  const raw = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) throw new DiagramError('EMPTY_TEXT', path + ' 的文字为空', '每个节点都要有文字。');
  return raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT - 1) + '…' : raw;
}

function normalizeTree(input) {
  if (!input || typeof input !== 'object') throw new DiagramError('BAD_TREE', '思维导图需要一个根节点对象', '例如 { text: "主题", children: [...] }');
  let count = 0;
  let maxDepth = 0;
  const warnings = [];

  function walk(raw, depth, path) {
    if (depth > MAX_DEPTH) throw new DiagramError('TOO_DEEP', path + ' 超过 5 层', '思维导图最多 5 层（根 + 4 层），把更深的内容合并到上层。');
    if (!raw || typeof raw !== 'object') throw new DiagramError('BAD_TREE', path + ' 不是节点对象', '节点形如 { text: "标题", children: [...] }');
    count += 1;
    if (count > MAX_NODES) throw new DiagramError('TOO_MANY_NODES', '节点超过 ' + MAX_NODES + ' 个', '删掉次要分支，或拆成两张图。');
    maxDepth = Math.max(maxDepth, depth);
    const text = normalizeText(raw.text ?? raw.name ?? raw.label, path);
    if (String(raw.text ?? raw.name ?? raw.label ?? '').trim().length > MAX_TEXT) warnings.push(path + ' 文字超过 ' + MAX_TEXT + ' 字，已截断');
    const kidsRaw = raw.children == null ? [] : raw.children;
    if (!Array.isArray(kidsRaw)) throw new DiagramError('BAD_TREE', path + ' 的 children 不是数组', 'children 必须是节点数组。');
    if (kidsRaw.length > MAX_CHILDREN) throw new DiagramError('TOO_MANY_CHILDREN', path + ' 有 ' + kidsRaw.length + ' 个子节点', '每个节点最多 ' + MAX_CHILDREN + ' 个直接子节点。');
    const children = kidsRaw.map((child, i) => walk(child, depth + 1, path + '.' + (i + 1)));
    return { text, depth, children, color: COLORS[0], parent: null, side: 'root' };
  }

  const root = walk(input, 0, 'root');
  return { root, count, maxDepth, warnings };
}

function nodeMetrics(node, metrics, isRoot) {
  const size = isRoot ? metrics.rootFont : metrics.font;
  const maxW = isRoot ? metrics.rootTextW : metrics.maxTextW;
  const lines = wrapText(node.text, maxW, size, isRoot ? 2 : 3);
  const w = Math.max(isRoot ? 120 : 76, Math.min(maxW + metrics.padX * 2, Math.max(...lines.map((l) => textWidth(l, size))) + metrics.padX * 2));
  const lineH = size * 1.3;
  const h = Math.max(isRoot ? 48 : 36, lines.length * lineH + metrics.padY * 2);
  return { lines, w: Math.round(w), h: Math.round(h), size, lineH };
}

function sideOfChildren(root) {
  const groups = { right: [], left: [] };
  let rightH = 0;
  let leftH = 0;
  for (const child of root.children) {
    // 子树高度先按占位估，真正布局时再重算；这里只做左右平衡。
    const h = subtreeHeight(child);
    if (rightH <= leftH) { groups.right.push(child); child.side = 'right'; rightH += h; }
    else { groups.left.push(child); child.side = 'left'; leftH += h; }
  }
  return groups;
}

function subtreeHeight(node) {
  if (!node.children.length) return node.h;
  let total = node.children.reduce((s, c) => s + subtreeHeight(c), 0);
  total += (node.children.length - 1) * (node.gapY ?? 0);
  return Math.max(node.h, total);
}

function assignSide(node, side) {
  node.side = side;
  for (const child of node.children) assignSide(child, side);
}

function colorize(node, color) {
  node.color = color;
  for (const child of node.children) colorize(child, color);
}

function layoutSide(nodes, side, rootBox, colW, metrics, centerY) {
  const total = nodes.reduce((s, n) => s + subtreeHeight(n), 0) + Math.max(0, nodes.length - 1) * metrics.gapY;
  let cursor = centerY - total / 2;
  for (const child of nodes) {
    const h = subtreeHeight(child);
    const cx = cursor + h / 2;
    const depth = child.depth;
    let x;
    if (side === 'right') {
      x = rootBox.x + rootBox.w + metrics.gapX;
      for (let d = 1; d < depth; d += 1) x += colW[d] + metrics.gapX;
    } else {
      let rightEdge = rootBox.x - metrics.gapX;
      for (let d = 1; d < depth; d += 1) rightEdge -= colW[d] + metrics.gapX;
      x = rightEdge - child.w;
    }
    child.x = Math.round(x);
    child.y = Math.round(cx - child.h / 2);
    placeDescendants(child, side, colW, metrics, cx);
    cursor += h + metrics.gapY;
  }
}

function placeDescendants(node, side, colW, metrics, centerY) {
  node.y = Math.round(centerY - node.h / 2);
  if (!node.children.length) return;
  const total = node.children.reduce((s, c) => s + subtreeHeight(c), 0) + (node.children.length - 1) * metrics.gapY;
  let cursor = centerY - total / 2;
  for (const child of node.children) {
    const h = subtreeHeight(child);
    const cx = cursor + h / 2;
    let x;
    if (side === 'right') {
      x = node.x + node.w + metrics.gapX;
      for (let d = node.depth + 1; d < child.depth; d += 1) x += colW[d] + metrics.gapX;
    } else {
      let rightEdge = node.x - metrics.gapX;
      for (let d = node.depth + 1; d < child.depth; d += 1) rightEdge -= colW[d] + metrics.gapX;
      x = rightEdge - child.w;
    }
    child.x = Math.round(x);
    child.y = Math.round(cx - child.h / 2);
    placeDescendants(child, side, colW, metrics, cx);
    cursor += h + metrics.gapY;
  }
}

function collectSide(root, side) {
  const out = [];
  const walk = (node) => { if (node.side === side) out.push(node); for (const c of node.children) walk(c); };
  walk(root);
  return out;
}

function buildLayout(tree, metrics) {
  const { root } = tree;
  const rm = nodeMetrics(root, metrics, true);
  root.w = rm.w; root.h = rm.h; root.lines = rm.lines; root.size = rm.size; root.lineH = rm.lineH;
  root.gapY = metrics.gapY;

  // 先给所有节点算尺寸，才能按列宽定位、按子树高度分左右
  const measure = (node) => {
    const m = nodeMetrics(node, metrics, false);
    node.w = m.w; node.h = m.h; node.lines = m.lines; node.size = m.size; node.lineH = m.lineH;
    node.gapY = metrics.gapY;
    for (const c of node.children) measure(c);
  };
  for (const c of root.children) measure(c);

  const groups = sideOfChildren(root);
  root.children.forEach((child, i) => {
    child.color = COLORS[i % COLORS.length];
    colorize(child, child.color);
    assignSide(child, child.side);
  });
  const sideNodes = { left: collectSide(root, 'left'), right: collectSide(root, 'right') };
  const colW = { left: Array(MAX_DEPTH + 1).fill(0), right: Array(MAX_DEPTH + 1).fill(0) };
  for (const side of ['left', 'right']) {
    for (const n of sideNodes[side]) colW[side][n.depth] = Math.max(colW[side][n.depth], n.w);
  }
  const depthCount = { left: 0, right: 0 };
  for (const side of ['left', 'right']) {
    for (let d = 1; d <= MAX_DEPTH; d += 1) if (colW[side][d] > 0) depthCount[side] = d;
  }
  const extent = (side) => {
    if (!depthCount[side]) return 0;
    let w = metrics.gapX;
    for (let d = 1; d <= depthCount[side]; d += 1) w += colW[side][d] + metrics.gapX;
    return w - metrics.gapX;
  };
  const leftExtent = extent('left');
  const rightExtent = extent('right');
  const contentW = leftExtent + root.w + rightExtent;
  const leftH = groups.left.reduce((s, n) => s + subtreeHeight(n), 0) + Math.max(0, groups.left.length - 1) * metrics.gapY;
  const rightH = groups.right.reduce((s, n) => s + subtreeHeight(n), 0) + Math.max(0, groups.right.length - 1) * metrics.gapY;
  const contentH = Math.max(root.h, leftH, rightH);

  const width = Math.max(MIN_WIDTH, Math.ceil(contentW + MARGIN * 2));
  const height = Math.max(MIN_HEIGHT, Math.ceil(contentH + MARGIN * 2));
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new DiagramError('TOO_LARGE', '思维导图需要 ' + width + '×' + height + '，超过 ' + MAX_WIDTH + '×' + MAX_HEIGHT, '减少分支或缩短节点文字，工具会自动缩小字号再试一次。');
  }

  const centerY = MARGIN + contentH / 2;
  root.x = Math.round(MARGIN + leftExtent);
  root.y = Math.round(centerY - root.h / 2);
  layoutSide(groups.right, 'right', root, colW.right, metrics, centerY);
  layoutSide(groups.left, 'left', root, colW.left, metrics, centerY);

  return { width, height, leftExtent, rightExtent, contentW, contentH, rootBox: root };
}

function curve(parent, child) {
  const pRight = parent.side === 'root' ? child.side !== 'left' : parent.side !== 'left';
  const px = pRight ? parent.x + parent.w : parent.x;
  const py = parent.y + parent.h / 2;
  const cx = pRight ? child.x : child.x + child.w;
  const cy = child.y + child.h / 2;
  const dx = Math.max(24, Math.abs(cx - px) * 0.45);
  const sign = pRight ? 1 : -1;
  return 'M ' + fmtNumber(px, 2) + ' ' + fmtNumber(py, 2)
    + ' C ' + fmtNumber(px + dx * sign, 2) + ' ' + fmtNumber(py, 2)
    + ' ' + fmtNumber(cx - dx * sign, 2) + ' ' + fmtNumber(cy, 2)
    + ' ' + fmtNumber(cx, 2) + ' ' + fmtNumber(cy, 2);
}

function renderNode(node, root) {
  const isRoot = node === root;
  const depth = node.depth;
  const fill = isRoot ? '#0f172a' : (depth === 1 ? node.color : '#ffffff');
  const stroke = isRoot ? '#0f172a' : node.color;
  const textColor = isRoot || depth === 1 ? '#ffffff' : '#1f2937';
  const weight = isRoot ? 700 : (depth === 1 ? 600 : 400);
  const parts = [svgRect({ x: node.x, y: node.y, w: node.w, h: node.h, rx: 9, fill, stroke, width: depth >= 2 ? 1.4 : 0 })];
  const total = node.lines.length * node.lineH;
  const first = node.y + node.h / 2 - total / 2 + node.size * 0.92;
  node.lines.forEach((line, i) => {
    parts.push(svgText({
      x: node.x + node.w / 2,
      y: first + i * node.lineH,
      text: line,
      size: node.size,
      fill: textColor,
      anchor: 'middle',
      weight,
    }));
  });
  return parts.join('');
}

function renderTree(root) {
  const lines = [];
  const nodes = [];
  const walk = (node) => {
    for (const child of node.children) {
      lines.push(svgPath(curve(node, child), {
        stroke: child.color, width: child.depth === 1 ? 2.8 : 1.8, opacity: child.depth === 1 ? 0.75 : 0.55,
      }));
      walk(child);
    }
    nodes.push(node);
  };
  walk(root);
  // 父节点在下层画，保证连线被节点盖住
  const body = lines.join('') + nodes.reverse().map((n) => renderNode(n, root)).join('');
  return body;
}

/**
 * 主入口。返回 { svg, width, height, meta }。
 * 自动在 480–1600 宽、360–1400 高内收窄；放不下就报 TOO_LARGE。
 */
export function drawMindmap(treeInput, options = {}) {
  const tree = normalizeTree(treeInput);
  let chosen = null;
  let lastError = null;
  for (const metrics of METRICS) {
    try {
      const layout = buildLayout(tree, metrics);
      chosen = { metrics, layout };
      break;
    } catch (err) {
      if (err instanceof DiagramError && err.code === 'TOO_LARGE') { lastError = err; continue; }
      throw err;
    }
  }
  if (!chosen) throw lastError || new DiagramError('TOO_LARGE', '思维导图放不下', '减少分支或缩短文字。');

  // 重新构建一次，保证节点尺寸/位置与最终 metrics 一致（buildLayout 会写节点）
  const layout = buildLayout(tree, chosen.metrics);
  const reqW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(Number(options.width) || layout.width)));
  const reqH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(Number(options.height) || layout.height)));
  const width = Math.max(layout.width, reqW);
  const height = Math.max(layout.height, reqH);
  if (width > MAX_WIDTH || height > MAX_HEIGHT) throw new DiagramError('TOO_LARGE', '画布超过 ' + MAX_WIDTH + '×' + MAX_HEIGHT, '减少分支或缩短文字。');

  const offsetX = Math.round((width - layout.width) / 2);
  const offsetY = Math.round((height - layout.height) / 2);
  const shift = (node) => {
    node.x += offsetX; node.y += offsetY;
    for (const c of node.children) shift(c);
  };
  if (offsetX || offsetY) shift(tree.root);

  const svg = svgHeader(width, height) + renderTree(tree.root) + svgFooter();
  return {
    svg,
    width,
    height,
    meta: {
      nodeCount: tree.count,
      depth: tree.maxDepth,
      width,
      height,
      fontSize: chosen.metrics.font,
      warnings: tree.warnings,
    },
  };
}
