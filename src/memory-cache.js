/**
 * 记忆库的「写入侧」薄封装（bridge 用）。
 *
 * 为什么单独一层：
 *  · bridge.js 是被 vm.runInNewContext 加载做审计的，顶层再挂一个 node:sqlite 依赖
 *    会连新符号一起带进沙箱 → 老测试从「缺 normalizeHybridConfig」变成「缺 DatabaseSync」，
 *    失败清单更难读。这里改成**首次用时才动态 import**，沙箱里不调用就永远不加载。
 *  · 写库是旁路：任何异常都只记日志、绝不抛到消息链路上（消息发不出去比少记一条严重）。
 *
 * 开关：stellar/config.json 的 memory.cache（默认开）。
 * 注意：engine 只决定「唤醒时注入什么」，cache 决定「记不记」——两个开关独立，
 * 这样即使注入还走旧卡片，新库也能先把对话攒起来。
 */
// 故意不从 memory-db.js 静态 import（它顶层就 `import { DatabaseSync } from 'node:sqlite'`，
// 会把 sqlite 依赖带进 vm 沙箱）。owner 标签规则就 5 行，这里内联一份，两边保持一致。
function ownerIdForKey(conversationKey) {
  const k = String(conversationKey || '');
  if (k.startsWith('private:')) return k.slice(8);
  if (k.startsWith('group:')) return k;
  if (k.startsWith('owner:')) return k;
  return k || 'unknown';
}

let modPromise = null;
let lastErrorAt = 0;

function load() {
  if (!modPromise) {
    modPromise = import('./memory-db.js').catch((error) => {
      modPromise = null;
      throw error;
    });
  }
  return modPromise;
}

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }

/** 消息段落 → cache_msg.kind。只区分「模型重新看时能不能认出这是什么」。 */
export function cacheKind(media, forwardIds) {
  const list = Array.isArray(media) ? media : [];
  if (list.length) {
    const first = list[0] || {};
    if (first.kind === 'face' || first.kind === 'sticker') return 'sticker';
    return 'image';
  }
  if (Array.isArray(forwardIds) && forwardIds.length) return 'forward';
  return 'text';
}

/** 入站：有人说话。空正文 + 无媒体（纯拍一拍等）不落库。 */
export function cacheInbound(entry, log) {
  const text = String(entry?.text || '').trim();
  const media = Array.isArray(entry?.media) ? entry.media : [];
  const forwardIds = Array.isArray(entry?.forwardIds) ? entry.forwardIds : [];
  if (!text && !media.length && !forwardIds.length) return null;
  const conversationKey = String(entry?.conversationKey || '');
  if (!conversationKey) return null;
  const payload = {
    conversationKey,
    ownerId: entry.ownerId || ownerIdForKey(conversationKey),
    speakerId: entry.speakerId != null ? String(entry.speakerId) : '',
    speakerName: String(entry.speakerName || ''),
    role: 'user',
    kind: cacheKind(media, forwardIds),
    text: text || (media.length ? '[图片]' : '[转发]'),
    at: num(entry.at) || Date.now(),
  };
  load().then((mod) => mod.safeAppend(payload, log)).catch((error) => {
    // 库不可用很常见（旧角色目录没写权限等），第一次报一次、之后每 10 分钟最多一次。
    const now = Date.now();
    if (log && now - lastErrorAt > 10 * 60 * 1000) {
      lastErrorAt = now;
      try { log('记忆库不可用（入站未记录）：' + (error?.message ?? error)); } catch {}
    }
  });
  return payload;
}

/**
 * 桥接自己发的系统提示（错误横幅、审批请求、已停止…）。这些不是她说的话，
 * 记进 memory.db 会被当成 role='self'，切不出双人话题就降级成「零碎记忆」，
 * 之后她侧写/检索时会把它们当成自己说过的内容（2026-11-18 的 502 横幅就是这么进去的）。
 * 只认桥接自己的固定前缀，不按「像不像系统话」猜。
 */
const SYSTEM_NOTICE_PREFIXES = [
  '⚠️ agent 处理出错：',
  '⚠️ 本条回复因疑似包含敏感信息',
  '⚠️ 消息未被接受：',
  '⚠️ 回答提交失败，请再回复一次。',
  '⚠️ 审批回执提交失败，请再回复一次',
  '⏹️ 已停止',
  '🔐 agent 请求审批：',
  '✅ 已通过审批',
  '❌ 已拒绝审批',
];

export function isSystemNotice(text) {
  const body = String(text || '').trim();
  if (!body) return false;
  return SYSTEM_NOTICE_PREFIXES.some((p) => body.startsWith(p));
}
/** 出站：她自己说的话。没有这一条，切出来的话题就是「对方一个人在说话」。 */
export function cacheOutbound({ conversationKey, text, at, selfUserId } = {}, log) {
  const body = String(text || '').trim();
  if (!body || !conversationKey) return null;
  // 系统提示不进记忆：她没说过，别让她以后以为说过。
  if (isSystemNotice(body)) return null;
  const payload = {
    conversationKey: String(conversationKey),
    ownerId: ownerIdForKey(conversationKey),
    speakerId: String(selfUserId || ''),
    speakerName: '',
    role: 'self',
    kind: 'text',
    text: body,
    at: num(at) || Date.now(),
  };
  load().then((mod) => mod.safeAppend(payload, log)).catch((error) => {
    const now = Date.now();
    if (log && now - lastErrorAt > 10 * 60 * 1000) {
      lastErrorAt = now;
      try { log('记忆库不可用（出站未记录）：' + (error?.message ?? error)); } catch {}
    }
  });
  return payload;
}
