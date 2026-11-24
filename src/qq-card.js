// QQ 卡片（json / xml 消息段）→ 一两行可读文本。
//
// 为什么要单独一个模块：
// - 同一张卡片会在两条路上出现：普通消息（src/bridge.js 的 segmentsToText）和
//   合并转发里的每一条（src/forward.js 的 segmentText）。以前两处各写一套，
//   转发那条路干脆把卡片拍平成「[卡片消息]」—— 2026-11-24 主人转发的 QQ 空间卡片
//   她读不出来，就是这条路的锅。
// - 卡片里有 token（登录凭据）。这个模块**只取标题/简介/链接/说说 id**，
//   config、preview、tagIcon、ciphertext 一律不返回，避免凭据进上下文。
//
// 安全原则：纯函数、不联网、不读文件；调用方负责把结果塞进消息文本。

// 分享链接后面常拖着一大串埋点参数，对理解内容没用却占上下文。
// b23.tv / bilibili.com 只留 scheme+host+path 就够了，她拿去丢给 stellar_bili_watch 一样能跳。
export function trimShareUrl(url) {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    const keep = /(^|\.)(b23\.tv|bilibili\.com)$/i.test(u.hostname);
    if (!keep) return s;
    return u.origin + u.pathname;
  } catch { return s; }
}

// mqqapi://qzoneschema/?schema=<base64> 里的 schema 是一段 base64 的 qzone 深层链接，
// 解码后 query 里有 oldlink=<urlencoded 真实 https>。对她来说只有这个 https 有用。
export function decodeMqqSchema(url) {
  const s = String(url ?? '').trim();
  const m = s.match(/[?&]schema=([A-Za-z0-9+/=_-]+)/);
  if (!m) return '';
  let text = '';
  try {
    text = Buffer.from(m[1], 'base64').toString('utf8');
  } catch { return ''; }
  const hit = text.match(/[?&]oldlink=([^&]+)/);
  if (hit) {
    try { return decodeURIComponent(hit[1]); } catch { /* 落到下面原样用 */ }
  }
  // 没有 oldlink 时，schema 本身就是 qzone://… 或 https://… 的链接，返回它
  return /^https?:\/\//i.test(text) ? text : '';
}

// 从空间链接里抠出说说 id（cellid，24 位十六进制）和作者 QQ。
// 支持的形状：mobile.qzone.qq.com/l?…&i=<cellid>&u=<uin>、
//            user.qzone.qq.com/<uin>/mood/<cellid>、qzone://arouse/detail?…cellid=<cellid>
export function qzoneIdsFromUrl(url) {
  const s = String(url ?? '').trim();
  const out = { cellId: '', uin: '' };
  if (!s) return out;
  const direct = s.match(/\/mood\/([0-9a-f]{24})/i);
  if (direct) out.cellId = direct[1];
  if (!out.cellId) {
    const q = s.match(/[?&](?:i|cellid)=([0-9a-f]{24})/i);
    if (q) out.cellId = q[1];
  }
  const u = s.match(/[?&]u(?:in)?=(\d{5,12})/);
  if (u) out.uin = u[1];
  if (!out.uin) {
    const p = s.match(/user\.qzone\.qq\.com\/(\d{5,12})/i);
    if (p) out.uin = p[1];
  }
  return out;
}

function clip(value, max) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 空间说说卡片的标题常被 QQ 自己截断成「✨…来啦！✨...」这种尾巴，念出来很别扭。
function tidyTitle(value) {
  const s = String(value ?? '').trim();
  return s.replace(/[.．。]{2,}$/, '').replace(/…+$/, '').trim();
}

function pickStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

// 卡片正文没地方放时，标题经常就是应用名/「分享了一条说说」，念出来像两个人说话。
const APP_NAMES = /^(哔哩哔哩|bilibili|QQ|QQ空间|微信|WeChat|小程序|迷你世界|分享)$/i;

function xmlAttrs(text) {
  const attrs = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) attrs[m[1].toLowerCase()] = decodeXmlText(m[2]).replace(/&amp;/g, '&');
  return attrs;
}

function parseXmlCard(text) {
  const src = String(text ?? '');
  const head = src.match(/<msg\b[^>]*>/i);
  if (!head) return null;
  const attrs = xmlAttrs(head[0]);
  const title = (src.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const summary = (src.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '';
  const source = src.match(/<source\b[^>]*>/i);
  const sourceName = source ? (xmlAttrs(source[0]).name || '') : '';
  const url = pickStr(attrs.url, attrs.Url);
  if (!title && !summary && !url) return null;
  return {
    kind: /qzone|空间/i.test(sourceName + ' ' + title + ' ' + (attrs.brief || '')) ? 'qzone' : 'xml',
    app: sourceName,
    tag: sourceName,
    title: clip(decodeXmlText(title), 120),
    desc: clip(decodeXmlText(summary), 160),
    prompt: clip(decodeXmlText(attrs.brief || ''), 60),
    url,
    preview: '',
  };
}

function decodeXmlText(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 卡片原文 → 结构化卡片。
 * 接受三种形状：
 *  1. OneBot 的 json 段 data（字符串 JSON、已经解析好的对象）
 *  2. xml 段（<msg …> 字符串）
 *  3. 随便一段 http(s) 链接
 * 返回 null 表示「认不出来，调用方用兜底文案」。
 */
export function parseCard(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    if (s.startsWith('<')) {
      const xml = parseXmlCard(s);
      if (xml) {
        const ids = qzoneIdsFromUrl(xml.url);
        xml.cellId = ids.cellId;
        xml.uin = ids.uin;
      }
      return xml;
    }
    if (/^https?:\/\//i.test(s)) {
      const ids = qzoneIdsFromUrl(s);
      return { kind: ids.cellId ? 'qzone' : 'link', title: '', desc: '', url: s, preview: '', cellId: ids.cellId, uin: ids.uin };
    }
    if (!s.startsWith('{')) return null;
    try { return parseCard(JSON.parse(s)); } catch { return null; }
  }
  if (typeof raw !== 'object') return null;

  const obj = raw;
  const meta = obj.meta && typeof obj.meta === 'object' ? obj.meta : obj;
  // 空间说说卡有两种形状，2026-11-24 两种都要认：
  //  - com.tencent.tuwen.lua（纯文字说说）→ 字段在 meta.news
  //  - com.tencent.miniapp.lua + bizsrc=qzone.shuoshuosharepicture（带图说说）→ 字段在 meta.miniapp
  // B站/小程序卡在 meta.detail_1 或平铺的 meta 上。
  const news = meta.news && typeof meta.news === 'object' ? meta.news : null;
  const mini = !news && meta.miniapp && typeof meta.miniapp === 'object' ? meta.miniapp : null;
  const detail = news || mini || (meta.detail_1 && typeof meta.detail_1 === 'object' ? meta.detail_1 : meta);

  const title = tidyTitle(pickStr(detail.title, meta.title, obj.title));
  const desc = pickStr(detail.desc, meta.desc, detail.summary, obj.desc);
  const rawJump = pickStr(
    detail.qqdocurl, detail.jumpUrl, detail.jump_url, detail.pcJumpUrl, detail.legacyUrl,
    meta.qqdocurl, meta.jumpUrl, meta.jump_url, meta.pcJumpUrl, meta.legacyUrl,
    obj.jumpUrl, obj.jump_url, detail.url, meta.url, obj.url,
  );
  const preview = pickStr(detail.preview, meta.preview, obj.preview);
  const tag = pickStr(detail.tag, meta.tag, obj.tag, obj.sourceName);
  const app = pickStr(obj.app, meta.app);
  const prompt = pickStr(obj.prompt, meta.prompt);

  if (!title && !desc && !rawJump) return null;

  // 优先给 https：mqqapi:// 对模型没用，legacyUrl/pcJumpUrl 才是真地址。
  const https = pickStr(detail.legacyUrl, detail.pcJumpUrl, meta.legacyUrl, meta.pcJumpUrl)
    || decodeMqqSchema(rawJump)
    || (/^https?:\/\//i.test(rawJump) ? rawJump : '');
  const url = https || rawJump;
  const ids = qzoneIdsFromUrl(https || rawJump);
  const isQzone = /qzone|shuoshuo/i.test(app + ' ' + (obj.bizsrc || '') + ' ' + tag + ' ' + title + ' ' + desc) || (ids.cellId && /qzone\.qq\.com/i.test(url));

  return {
    kind: isQzone ? 'qzone' : (app && /miniapp/i.test(app) ? 'miniapp' : (news ? 'news' : 'other')),
    app,
    tag,
    title: clip(title, 120),
    desc: clip(desc && desc !== title ? desc : '', 160),
    prompt: clip(prompt, 60),
    url: clip(url, 400),
    preview,
    cellId: ids.cellId,
    uin: ids.uin,
  };
}

/** 卡片 → 一行文本。控制长度，别让一张卡吃掉几百 token。 */
export function cardText(card, { hint = true } = {}) {
  if (!card) return '[卡片消息]';
  const bv = (String(card.url || '').match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
  const titleIsApp = !card.title || APP_NAMES.test(card.title);
  const bits = [];
  if (!titleIsApp) bits.push(card.title);
  if (card.desc) bits.push(card.desc);
  else if (titleIsApp && card.title) bits.push(card.title);
  if (card.tag && !bits.some((b) => b.includes(card.tag)) && card.kind !== 'qzone') bits.push(card.tag);

  const kindLabel = card.kind === 'qzone' ? '卡片·QQ空间'
    : card.kind === 'miniapp' ? '卡片·小程序'
    : card.kind === 'xml' ? '卡片'
    : card.kind === 'link' ? '链接'
    : '卡片';

  let line = '[' + kindLabel + ']';
  if (bits.length) line += ' ' + bits.join(' — ');
  if (card.cellId) {
    const who = card.uin ? 'QQ ' + card.uin : '';
    line += '（说说 ' + card.cellId + (who ? '｜作者 ' + who : '') + '）';
  } else if (bv) {
    line += '（' + bv + '）';
  } else if (card.url && !/^mqqapi:/i.test(card.url)) {
    line += '（链接：' + trimShareUrl(card.url) + '）';
  }
  if (hint && card.cellId) line += '\n（想看这条说说的正文，用 stellar_qzone_card 传说说 id 或链接）';
  return clip(line, card.cellId ? 420 : 330);
}

/**
 * 认不出的卡片只留形状（app / bizsrc / meta 的键名），供调用方记一行日志。
 * 2026-11-24：兜底成「[卡片消息]」时既不报错也不留痕，"卡片本来没内容"和"解析器不认这种形状"
 * 看起来一模一样（PITFALLS #326）。**这里绝不返回 config / token / 正文。**
 */
export function cardShape(raw) {
  let obj = raw;
  try {
    if (typeof obj === 'string') {
      const s = obj.trim();
      if (s.startsWith('<')) return { kind: 'xml' };
      if (!s.startsWith('{')) return { kind: 'text' };
      obj = JSON.parse(s);
    }
  } catch { return { kind: 'unparsed' }; }
  if (!obj || typeof obj !== 'object') return { kind: 'none' };
  const meta = obj.meta && typeof obj.meta === 'object' ? obj.meta : {};
  const metaKeys = Object.keys(meta).filter((k) => k !== 'config' && k !== 'token').slice(0, 6);
  return {
    kind: 'json',
    app: String(obj.app ?? '').slice(0, 40),
    bizsrc: String(obj.bizsrc ?? '').slice(0, 48),
    prompt: String(obj.prompt ?? '').slice(0, 24),
    metaKeys,
  };
}

/** 合并转发里的一个消息段 data → 文本（json / xml 段都走这里）。 */
export function cardTextFromSegmentData(data) {
  if (data == null) return '[卡片消息]';
  let raw = data;
  if (typeof data === 'object') raw = data.data ?? data.json ?? data.content ?? data;
  const card = parseCard(raw);
  return card ? cardText(card) : '[卡片消息]';
}

/**
 * 说说/评论里的图 → 原图 URL 列表（最多 max 张）。
 * 结构：media_items[].image.default_url.url，或 image.photo_url[].url（多档尺寸）。
 * 同一张图的 lloc 相同，去重；拿不到 URL 的条目跳过。纯函数，下载交给调用方。
 */
export function mediaImageUrls(items, { max = 9 } = {}) {
  const urls = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const img = it?.image ?? it?.pic ?? null;
    if (!img) continue;
    const key = String(img.lloc ?? img.sloc ?? '') || String(urls.length);
    if (seen.has(key)) continue;
    seen.add(key);
    const dft = typeof img.default_url === 'string' ? img.default_url : img.default_url?.url;
    if (typeof dft === 'string' && dft) { urls.push(dft); continue; }
    for (const p of Array.isArray(img.photo_url) ? img.photo_url : []) {
      const u = typeof p === 'string' ? p : (p?.url?.url ?? p?.url ?? '');
      if (typeof u === 'string' && u) { urls.push(u); break; }
    }
  }
  return urls.slice(0, Math.max(1, Number(max) || 9));
}

function pad2(n) { return String(n).padStart(2, '0'); }

// epoch 秒/毫秒/数字串 → 「2026-11-08 23:50」。认不出来返回空串，不瞎猜。
function feedTime(value) {
  let ms = 0;
  if (typeof value === 'number' && Number.isFinite(value)) ms = value;
  else if (typeof value === 'string' && /^\d{9,14}$/.test(value.trim())) ms = Number(value.trim());
  if (!ms) return '';
  if (ms < 1e12) ms *= 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * get_qzone_feed_detail 返回的 feed → 可读文本。
 * 这条说说读不到正文时（比如对方删了/仅自己可见），调用方负责说清楚，不要编。
 */
export function feedCardText(feed, { tid = '' } = {}) {
  const f = feed && typeof feed === 'object' ? feed : null;
  if (!f) return '';
  const common = f.cell_common || {};
  const user = (f.cell_user_info && f.cell_user_info.user) || {};
  const cells = (f.cell_summary && Array.isArray(f.cell_summary.summary)) ? f.cell_summary.summary : [];
  const body = cells.map((c) => (typeof c === 'object' ? c.content : String(c))).filter(Boolean).join('\n').trim();
  const media = (f.cell_media && Array.isArray(f.cell_media.media_items)) ? f.cell_media.media_items : [];
  const pics = media.length;
  const comments = Number((f.cell_comment && f.cell_comment.num) || 0) || 0;
  const nick = user.nick || '';
  const uin = user.uin || '';
  const id = String(tid || common.feed_id || '');
  const time = feedTime(common.time);
  const link = (uin && id) ? 'https://user.qzone.qq.com/' + uin + '/mood/' + id : '';

  const head = [nick ? nick + (uin ? '（' + uin + '）' : '') : (uin ? 'QQ ' + uin : 'QQ空间'), time].filter(Boolean).join(' · ');
  const lines = [];
  lines.push('[空间说说] ' + (head || '（读不到作者）'));
  lines.push(body ? '正文：' + clip(body, 800) : '正文：（这条没有文字，可能只有图）');
  if (pics) lines.push('图 ' + pics + ' 张');
  if (comments) lines.push('评论 ' + comments + ' 条');
  if (link) lines.push('链接：' + link);
  return lines.join('\n');
}
