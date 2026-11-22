// 群聊不发 B站 视频链接（2026-11-22 主人要求，m02721）。
//
// 背景：她会在聊天里顺手贴「标题 + https://www.bilibili.com/video/BV…」。
// 私聊无所谓，群聊里刷链接既像广告，主人也不希望以她的名义往外丢链接。
// 这个模块只做「识别 + 剥掉」，不做策略判断；开不开由调用方按
// config.socialV2.send.allowBiliLinksInGroups 决定（默认开闸）。
//
// 设计取舍：
// * 只剥 B站 链接与 BV 号，别的链接（新闻、图床）不碰 —— 主人要禁的是「往群里分享视频」。
// * 剥完只做最小清理（行内多余空格、空行、首尾空白），不改写句子、不补语气词。
// * 纯函数、不读配置、不写日志：桥接与单测共用同一份实现。

const LINK_TAIL = '[^\\s"\'<>()（）【】\\[\\]，。；;、!！?？]*';

export const BILI_LINK_RE = new RegExp(
  '(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(?:b23\\.tv|bilibili\\.com)(?:\\/' + LINK_TAIL + ')?',
  'gi'
);
export const BILI_BVID_RE = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/g;

const GUARDED_RES = [BILI_LINK_RE, BILI_BVID_RE];

function asList(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  return list.map((m) => String(m ?? ''));
}

/** 找出文本里的 B站 链接与 BV 号（去重后返回）。
 *  链接里本来就带 BV 号，先在「把链接挖掉」的副本里找 BV，避免同一个东西报两次。 */
export function findBiliLinks(text) {
  const source = String(text ?? '');
  BILI_LINK_RE.lastIndex = 0;
  const links = Array.from(source.matchAll(BILI_LINK_RE)).map((m) => m[0]).filter(Boolean);
  const rest = source.replace(BILI_LINK_RE, ' ');
  BILI_BVID_RE.lastIndex = 0;
  const bvids = Array.from(rest.matchAll(BILI_BVID_RE)).map((m) => m[0]).filter(Boolean);
  return Array.from(new Set([...links, ...bvids]));
}

/** 剥掉 B站 链接与 BV 号，返回 { text, removed }。removed 为空表示原文没动。 */
export function stripBiliLinks(text) {
  const source = String(text ?? '');
  const removed = [];
  let out = source;
  for (const re of GUARDED_RES) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      removed.push(m);
      return ' ';
    });
  }
  if (!removed.length) return { text: source, removed };
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return { text: out, removed };
}

/**
 * 按群聊策略处理一组消息。
 * allow=true（主人显式放开）时原样返回；否则剥链接，剥空的消息直接丢掉，
 * dropped=true 表示「本来有内容，剥完一条都不剩」，调用方应回错误而不是发空消息。
 */
export function guardGroupMessages(messages, { allow = false } = {}) {
  const list = asList(messages);
  if (allow) return { messages: list, removed: [], dropped: false, changed: false };
  const removed = [];
  const out = [];
  for (const msg of list) {
    const r = stripBiliLinks(msg);
    if (r.removed.length) removed.push(...r.removed);
    if (r.text.trim()) out.push(r.text);
  }
  const hadContent = list.some((m) => m.trim().length > 0);
  return {
    messages: out,
    removed,
    dropped: hadContent && out.length === 0,
    changed: removed.length > 0 || out.length !== list.length,
  };
}

/** 给 OneBot 消息段用：只改 text 段，剥空的段删掉；别的段（图片、表情）原样保留。 */
export function guardGroupSegments(segments, { allow = false } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (allow) return { segments: list, removed: [], dropped: false, changed: false };
  const removed = [];
  const out = [];
  for (const seg of list) {
    const isText = seg && seg.type === 'text' && seg.data && typeof seg.data.text === 'string';
    if (!isText) { out.push(seg); continue; }
    const r = stripBiliLinks(seg.data.text);
    if (r.removed.length) removed.push(...r.removed);
    if (!r.text.trim()) continue;
    out.push({ ...seg, data: { ...seg.data, text: r.text } });
  }
  return {
    segments: out,
    removed,
    dropped: removed.length > 0 && out.length === 0,
    changed: removed.length > 0,
  };
}

export const GROUP_LINK_HINT = '群聊里不发 B站 视频链接（主人要求）：链接已省略。想推荐就直接讲视频讲了什么，不要贴链接或 BV 号。';
