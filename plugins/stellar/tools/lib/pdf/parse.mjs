// PDF 章节索引与图注解析的纯函数（无 I/O）。
// 这一层只做字符串/几何计算，方便单测，也方便以后整块替换。

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

export function compactText(text) {
  return String(text || '').replace(/\s+/g, '');
}

export function tidyLine(text) {
  return String(text || '')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/[\u00a0\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[·•.．，,、\s]+/, '')
    .replace(/[·•.．，,、\s]+$/, '')
    .trim();
}

export function chineseToInt(input) {
  const s = String(input || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (number === 0) number = 1;
      section += number * unit;
      number = 0;
    } else {
      return 0;
    }
  }
  total = section + number;
  return total;
}

/** 从「第7章固体的结构与性质」这样的行里取出章号和标题。 */
export function parseChapterHeading(text) {
  const compact = compactText(text);
  const m = /^第\s*([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*章\s*(.*)$/.exec(compact);
  if (!m) return null;
  const num = chineseToInt(m[1]);
  if (!num) return null;
  let title = tidyLine(m[2] || '');
  // 标题后面常粘着页码或标点，切掉明显不属于标题的尾巴。
  title = title.replace(/[.．·•，,、\s]*\d{1,4}\s*$/, '').trim();
  if (title.length > 40) title = title.slice(0, 40);
  return { num, title };
}

/** 页眉/页脚的印刷页码（TOC OCR 的第一行常常就是它）。 */
export function pageHeaderNumber(lines) {
  for (const line of (Array.isArray(lines) ? lines : []).slice(0, 3)) {
    const s = compactText(line.text).replace(/[·•.．，,、]/g, '');
    const m = /^(\d{1,4})$/.exec(s);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 2000) return n;
    }
  }
  return 0;
}

function normalizeOcrDigits(text) {
  return compactText(text)
    .replace(/[ilI|\]!]/g, '1')
    .replace(/[Oo]/g, '0')
    .replace(/[·•.．，,、]/g, '');
}

function pageNumberNear(lines, titleLine, width) {
  let best = 0;
  let bestDy = Infinity;
  for (const line of lines) {
    if (line === titleLine) continue;
    if (Number(line.x) < width * 0.62) continue;
    const dy = Math.abs(Number(line.y) - Number(titleLine.y));
    if (dy > 70 || dy >= bestDy) continue;
    const s = normalizeOcrDigits(line.text);
    const m = /(\d{1,4})/.exec(s);
    if (!m) continue;
    const n = Number(m[1]);
    if (!n || n > 2000) continue;
    best = n;
    bestDy = dy;
  }
  return best;
}

function titleBeside(lines, headingLine) {
  let best = null;
  let bestDx = Infinity;
  const hy = Number(headingLine.y) || 0;
  const hx = Number(headingLine.x) || 0;
  for (const line of lines) {
    if (line === headingLine || !line.text) continue;
    if (parseChapterHeading(line.text)) continue;
    const dy = Math.abs((Number(line.y) || 0) - hy);
    const dx = (Number(line.x) || 0) - hx;
    if (dy > 42 || dx < 60 || dx >= bestDx) continue;
    best = line;
    bestDx = dx;
  }
  return best ? tidyLine(best.text) : '';
}

/**
 * 从目录 OCR 页里解析章节。
 * pages: [{ page, width, height, lines:[{text,x,y,w,h}] }]
 */
export function parseTocChapters(pages) {
  const out = [];
  const seen = new Set();
  for (const page of Array.isArray(pages) ? pages : []) {
    const width = Number(page.width) || 0;
    const lines = Array.isArray(page.lines) ? page.lines : [];
    for (const line of lines) {
      if (!line || !line.text) continue;
      if (width && Number(line.x) > width * 0.58) continue;
      const heading = parseChapterHeading(line.text);
      if (!heading) continue;
      if (seen.has(heading.num)) continue;
      const printed = pageNumberNear(lines, line, width || 1);
      const beside = heading.title ? '' : titleBeside(lines, line);
      out.push({ num: heading.num, title: heading.title || beside, printedStart: printed || 0, tocPage: page.page });
      seen.add(heading.num);
    }
  }
  return out.sort((a, b) => a.num - b.num);
}

/** 把「图 7-1」「图7.1」「图7，1」统一成 7-1。 */
export function normalizeFigureLabel(input) {
  let s = compactText(input).replace(/^图/, '');
  s = s.replace(/[－—–~至]/g, '-').replace(/[，,．.]/g, '-');
  const m = /^(\d{1,3})-(\d{1,3})$/.exec(s);
  return m ? m[1] + '-' + m[2] : '';
}

function figurePattern(label) {
  const m = /^(\d{1,3})-(\d{1,3})$/.exec(label);
  if (!m) return null;
  return new RegExp('图\\s*' + m[1] + '\\s*[，,．.\\-－—–~]\\s*' + m[2]);
}

/**
 * 从图注里认图号，容忍 OCR 把 7.5 认成「7 巧」、把 7.19 认成「7口9」。
 * 做法：图字之后只取开头连续数字；巧→5、儿/口→1，再按章号切分。
 */
export function captionFigureNumber(text, chapterNum) {
  const s = compactText(text);
  const at = s.indexOf('图');
  if (at < 0) return null;
  const head = (/^[\s0-9，,．.、\-－—–~巧儿口iIlOo|]{1,12}/.exec(s.slice(at + 1)) || [''])[0];
  const tail = head
    .replace(/巧/g, '5')
    .replace(/[儿口]/g, '1')
    .replace(/[ilI|\]!]/g, '1')
    .replace(/[Oo]/g, '0')
    .replace(/[^0-9]/g, '');
  if (!tail) return null;
  const chapter = Number(chapterNum) || 0;
  if (chapter && tail.startsWith(String(chapter)) && tail.length > String(chapter).length) {
    return { chapter, fig: Number(tail.slice(String(chapter).length)), digits: tail };
  }
  if (tail.length >= 2 && !chapter) return { chapter: Number(tail[0]), fig: Number(tail.slice(1)), digits: tail };
  return null;
}

/** 在整段文字里找图注，返回命中的那一行和行号。 */
export function findCaption(text, label, { captionOnly = false } = {}) {
  const normalized = normalizeFigureLabel(label);
  if (!normalized) return null;
  const [chapter, fig] = normalized.split('-').map(Number);
  const re = figurePattern(normalized);
  const lines = String(text || '').split(/\r?\n/);
  // 图注行以「图」开头；正文里“如图 7.5 所示”只是引用，先跳过，找不到再退回。
  const passes = captionOnly ? [true] : [true, false];
  for (const pass of passes) {
    for (let i = 0; i < lines.length; i += 1) {
      const compact = compactText(lines[i]);
      if (pass && !compact.startsWith('图')) continue;
      if (re && re.test(compact)) return { label: normalized, line: tidyLine(lines[i]), lineIndex: i };
      const parsed = captionFigureNumber(lines[i], chapter);
      if (parsed && parsed.chapter === chapter && parsed.fig === fig) {
        return { label: normalized, line: tidyLine(lines[i]), lineIndex: i };
      }
    }
  }
  return null;
}

/** 在 OCR 行里找图注，返回行对象（带 bbox）。 */
export function findCaptionLine(lines, label) {
  const normalized = normalizeFigureLabel(label);
  if (!normalized) return null;
  const [chapter, fig] = normalized.split('-').map(Number);
  const re = figurePattern(normalized);
  const all = Array.isArray(lines) ? lines : [];
  for (const pass of [true, false]) {
    for (const line of all) {
      const compact = compactText(line.text);
      if (pass && !compact.startsWith('图')) continue;
      if (re && re.test(compact)) return { label: normalized, line };
      const parsed = captionFigureNumber(line.text, chapter);
      if (parsed && parsed.chapter === chapter && parsed.fig === fig) return { label: normalized, line };
    }
  }
  return null;
}

/**
 * 根据图注位置估算插图裁切区域（像素坐标，针对同一页渲染图）。
 * 图注在图下方时向上找最近的正文行；图注在图上方时向下找。
 */
export function estimateFigureCrop(lines, captionLine, pageWidth, pageHeight) {
  const W = Number(pageWidth) || 0;
  const H = Number(pageHeight) || 0;
  const cap = captionLine;
  if (!cap || !W || !H) return null;
  const capX = Number(cap.x) || 0;
  const capY = Number(cap.y) || 0;
  const capW = Number(cap.w) || 0;
  const capH = Number(cap.h) || 0;
  // 图注靠左/靠右时，插图通常也在同一栏；先按图注中心定栏，避免把另一栏正文当边界。
  const center = (capX + capW / 2) / W;
  const columnLeft = center > 0.65 ? W * 0.48 : 8;
  const columnRight = center < 0.35 ? W * 0.52 : W - 8;
  const others = (Array.isArray(lines) ? lines : []).filter((l) => {
    if (l === cap || Number(l.h) <= 0) return false;
    const x = Number(l.x) || 0;
    const w = Number(l.w) || 0;
    return x + w > columnLeft && x < columnRight;
  });
  const narrow = center > 0.65 || center < 0.35;
  let left = narrow ? columnLeft : Math.max(columnLeft, Math.min(capX, ...others.map((l) => Number(l.x) || capX)) - 18);
  let right = narrow ? columnRight : Math.min(columnRight, Math.max(capX + capW, ...others.map((l) => (Number(l.x) || 0) + (Number(l.w) || 0))) + 18);
  // 图里的短标签（如 NaCl 的 “0 C 1 一”）不算正文边界，否则会把图注误判到图上方。
  const textLines = others.filter((l) => compactText(l.text).length >= 6);
  const sorted = [cap, ...textLines].sort((a, b) => Number(a.y) - Number(b.y));
  const idx = sorted.indexOf(cap);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
  const gapAbove = prev ? capY - (Number(prev.y) + Number(prev.h)) : capY;
  const gapBelow = next ? Number(next.y) - (capY + capH) : H - (capY + capH);
  // 图注通常紧贴插图：离哪边空白大，插图就在哪边。
  const captionBelow = gapAbove > gapBelow && gapAbove > 120 ? true
    : gapBelow > gapAbove && gapBelow > 120 ? false
      : capY > H * 0.45;
  let top = 8;
  let bottom = H - 8;
  if (narrow) {
    // 栏内图注：图通常就在本栏上方。用图内的短标签（(a)/(b)、OOcOO 之类）估图的左右边界，
    // 再按标签上沿往上放一段，避免把栏内正文行带进裁切。
    bottom = Math.max(8, capY - 10);
    let labels = others.filter((l) => {
      const b = Number(l.y) + Number(l.h);
      if (b >= capY - 20) return false;
      const text = compactText(l.text);
      const x = Number(l.x) || 0;
      const w = Number(l.w) || 0;
      if (center > 0.65 ? x + w <= columnLeft : x >= columnRight) return false;
      return text.length < 10 || text.startsWith('(') || text.startsWith('（');
    });
    if (!labels.length) labels = others.filter((l) => Number(l.y) + Number(l.h) < capY - 20);
    if (labels.length) {
      const labelLeft = Math.min(...labels.map((l) => Number(l.x) || capX));
      const labelRight = Math.max(...labels.map((l) => (Number(l.x) || 0) + (Number(l.w) || 0)));
      const labelTop = Math.min(...labels.map((l) => Number(l.y) || capY));
      left = Math.max(columnLeft, Math.min(capX, labelLeft) - (center > 0.65 ? 50 : 40));
      right = Math.min(columnRight, Math.max(capX + capW, labelRight) + (center > 0.65 ? 30 : 60));
      top = Math.max(8, labelTop - 260);
    } else {
      top = Math.max(8, H * 0.08);
    }
    if (bottom - top < 120) top = Math.max(8, capY - H * 0.55);
  } else if (captionBelow) {
    bottom = Math.max(8, capY - 10);
    let aboveBottom = 0;
    for (const l of textLines) {
      const b = Number(l.y) + Number(l.h);
      if (b < capY - 16 && b > aboveBottom) aboveBottom = b;
    }
    top = aboveBottom > 0 ? aboveBottom + 10 : Math.max(8, capY - H * 0.55);
    if (bottom - top < 120) top = Math.max(8, capY - H * 0.55);
  } else {
    top = Math.min(H - 8, capY + capH + 10);
    let belowTop = H;
    for (const l of textLines) {
      const y = Number(l.y);
      if (y > capY + capH + 16 && y < belowTop) belowTop = y;
    }
    bottom = belowTop < H ? belowTop - 10 : Math.min(H - 8, capY + H * 0.55);
    if (bottom - top < 120) bottom = Math.min(H - 8, capY + H * 0.55);
  }
  const x = Math.max(0, Math.round(left));
  const y = Math.max(0, Math.round(top));
  const w = Math.max(1, Math.min(W - x, Math.round(right - left)));
  const h = Math.max(1, Math.min(H - y, Math.round(bottom - top)));
  return { x, y, w, h };
}
