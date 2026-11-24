// QQ 私聊会话 → 鱼缸小镇插件的「也放近况」绑定（2026-11-22，主人 m04974 选 B 的第二半）。
//
// 为什么需要它：插件里「把 QQ 那边的话也带进小镇」靠两条 —— ① 全局 `bridgeChat:true`
// （拿主意时带上主人在聊天里的最近两来回）；② 把 QQ 会话 id 登记进这条鱼的 `alsoSids`。
// 但桥接的 QQ 会话**会滚动**：`maybeRollSessionV2()` 按上下文预算每 2–3 次唤醒就 retire 旧会话、
// 换一个新的 `session-xxxx`（见 src/bridge.js）。静态绑一次，几小时后插件就绑在一个死会话上。
//
// 所以这里在每次投递前看一眼「主人私聊现在用的是哪个 session」，只有跟记录不同才去改插件设置。
// 走的是插件自己的 `POST /fishbowl-town/save`（第三方内部路由），失败**静默** —— 最坏情况退回
// 「主人在插件页手动绑一次」，不会比不绑更糟。
//
// 拆除（小镇关门时）：删本文件 + src/bridge.js 里那一句 `void syncTownChatBinding(...)` 的调用块 +
// 状态文件 <DSH_HOME>/stellar/state/town/chat-bind.json。scripts/town-decoupling-lib.mjs 有登记。
import fs from 'node:fs';
import path from 'node:path';

export const CHAT_BIND_FILE = 'chat-bind.json';
/** 失败后至少隔这么久再试（避免插件没装、路由改了时每轮都打一发）。 */
export const CHAT_BIND_RETRY_MS = 10 * 60 * 1000;
/** 插件里一条鱼最多接这么多个「也放近况」的会话（插件 MAX_ALSO，这里只用来判断要不要先摘旧的）。 */
export const CHAT_BIND_MAX_ALSO = 4;
const SESSION_ID_RE = /^session-[0-9a-zA-Z-]{8,}$/u;

export function chatBindPath(stellarDir) {
  return path.join(String(stellarDir || ''), 'state', 'town', CHAT_BIND_FILE);
}

/** 读绑定记录；坏文件/不存在都回空对象，绝不抛。 */
export function readChatBind(stellarDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(chatBindPath(stellarDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeChatBind(stellarDir, record) {
  try {
    const file = chatBindPath(stellarDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** 只认主人私聊那一个 key。 */
export function isOwnerPrivateKey(key, ownerUin) {
  const uin = String(ownerUin ?? '').trim();
  if (!uin) return false;
  return String(key ?? '').trim() === `private:${uin}`;
}

/**
 * 把「主人 QQ 私聊当前这个会话」登记进插件的 alsoSids。
 * 每次投递前调用；**只有** sid 变化时才会发请求，失败静默。
 *
 * @param {{
 *   stellarDir: string, key: string, ownerUin: string, sessionId: string,
 *   baseUrl: string, fetchImpl?: typeof fetch, fishId?: string,
 *   now?: number, log?: (msg: string) => void, force?: boolean,
 * }} input
 * @returns {Promise<{ ok: boolean, skipped?: string, changed?: boolean, removed?: string, error?: string, status?: number }>}
 */
export async function syncTownChatBinding(input = {}) {
  const {
    stellarDir, key, ownerUin, sessionId, baseUrl,
    fetchImpl = globalThis.fetch, fishId = 'whale', now = Date.now(), log = () => {}, force = false,
  } = input;
  try {
    if (!isOwnerPrivateKey(key, ownerUin)) return { ok: false, skipped: 'not-owner' };
    const sid = String(sessionId ?? '').trim();
    if (!SESSION_ID_RE.test(sid)) return { ok: false, skipped: 'bad-session' };
    const base = String(baseUrl ?? '').trim().replace(/\/+$/u, '');
    if (!base) return { ok: false, skipped: 'no-base' };
    if (typeof fetchImpl !== 'function') return { ok: false, skipped: 'no-fetch' };

    const prev = readChatBind(stellarDir);
    const prevSid = String(prev.sid ?? '').trim();
    if (!force && prev.ok === true && prevSid === sid) return { ok: true, skipped: 'same', changed: false };
    // 上一轮刚失败过：同一个 sid 在退避窗口内不再打（插件没装/路由改名时每轮打一发没意义）。
    if (!force && prev.ok === false && prevSid === sid && Number(prev.at) > 0 && now - Number(prev.at) < CHAT_BIND_RETRY_MS) {
      return { ok: false, skipped: 'backoff', error: String(prev.error ?? '') };
    }

    const body = { addAlso: sid, bridgeChat: true };
    // 换会话时顺手把上一个摘掉，免得 alsoSids 堆满 4 个之后新的再也进不去。
    if (prevSid && prevSid !== sid) body.removeAlso = prevSid;
    const url = `${base}/fishbowl-town/save?fish=${encodeURIComponent(fishId)}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const record = { ok: false, sid, at: now, error: String(error?.message ?? error).slice(0, 300) };
      writeChatBind(stellarDir, record);
      log(`[town-chat-sync] 绑定失败（网络）：${record.error}`);
      return { ok: false, error: record.error };
    }
    const status = Number(res?.status) || 0;
    if (status < 200 || status >= 300) {
      let message = '';
      try { message = (await res.text()).slice(0, 300); } catch {}
      const record = { ok: false, sid, at: now, status, error: message || `HTTP ${status}` };
      writeChatBind(stellarDir, record);
      log(`[town-chat-sync] 绑定失败（HTTP ${status}）：${record.error}`);
      return { ok: false, status, error: record.error };
    }
    const record = { ok: true, sid, at: now, base, fishId, removed: body.removeAlso ?? '' };
    writeChatBind(stellarDir, record);
    log(`[town-chat-sync] 已把主人私聊会话登记进小镇近况：${sid}${body.removeAlso ? `（摘掉旧会话 ${body.removeAlso}）` : ''}`);
    return { ok: true, changed: true, removed: body.removeAlso ?? '' };
  } catch (error) {
    return { ok: false, skipped: 'error', error: String(error?.message ?? error) };
  }
}
