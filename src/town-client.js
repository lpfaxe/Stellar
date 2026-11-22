/**
 * Stellar —— 鱼缸小镇（Fishbowl Town）HTTP 客户端。
 *
 * 边界（这部分是安全关键，改动前先读注释）：
 * - 只允许 https + 白名单域名（fishbowltown.com / fish.bside-moon.cn），禁私网、禁端口、禁凭据；
 * - **不跟随重定向**（3xx 一律报错），防止被引到别的域；
 * - 响应体 ≤ 512KB，超了直接拒；只接受 JSON；
 * - 访问码 fbo_* 只从 fishbowl-town 插件的 settings.json 读，绝不写日志/错误/快照；
 * - 动作端点只有 visit / play / goto 三个，别的路径一律拒。
 */
import fs from 'node:fs';
import path from 'node:path';

export const TOWN_HOSTS = Object.freeze(['fishbowltown.com', 'fish.bside-moon.cn']);
export const DEFAULT_BASE = 'https://fishbowltown.com/town/api/outside';
export const ACT_PATHS = Object.freeze(['visit', 'play', 'goto']);
export const MAX_BODY_BYTES = 512 * 1024;
export const DEFAULT_TIMEOUT_MS = 12000;
/** 相册条目的 id 形态（服务端生成，正则定了才敢拼进 URL）。 */
export const ALBUM_ID_RE = /^al_[0-9a-f]{16}$/;

export class TownError extends Error {
  constructor(code, message, extra = {}) {
    super(String(message || code));
    this.name = 'TownError';
    this.code = code;
    if (extra.status) this.status = extra.status;
    if (extra.retryAfter) this.retryAfter = extra.retryAfter;
    if (extra.path) this.path = extra.path;
  }
}

/** 把访问码从任何字符串里抹掉（错误信息、日志、上报都要过一遍）。 */
export function redactCode(input) {
  return String(input == null ? '' : input).replace(/fbo_[A-Za-z0-9_\-]{6,}/g, 'fbo_***');
}

/** 校验并规范化 base URL；不合法直接抛，不做「猜一个能用的」。 */
export function normalizeBaseUrl(input) {
  const raw = String(input || DEFAULT_BASE).trim();
  let u;
  try { u = new URL(raw); } catch { throw new TownError('bad_base', '小镇地址不是合法 URL'); }
  if (u.protocol !== 'https:') throw new TownError('bad_base', '小镇地址必须是 https');
  if (u.username || u.password) throw new TownError('bad_base', '小镇地址不能带凭据');
  if (u.port) throw new TownError('bad_base', '小镇地址不能指定端口');
  const host = u.hostname.toLowerCase();
  if (!TOWN_HOSTS.includes(host)) throw new TownError('bad_base', '小镇域名不在白名单：' + host);
  let p = u.pathname.replace(/\/+$/, '');
  if (!p) p = '/town/api/outside';
  if (!p.startsWith('/town/api/')) throw new TownError('bad_base', '小镇地址必须在 /town/api/ 下');
  return 'https://' + host + p;
}

/** 从 fishbowl-town 插件的 settings.json 读一条鱼（只读，不写，不打印码）。 */
export function readTownSettings(dshHome, { fishId } = {}) {
  const home = String(dshHome || process.env.DSH_HOME || '').trim();
  if (!home) return null;
  const file = path.join(home, 'fishbowl-town', 'settings.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let conf;
  try { conf = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return null; }
  const fish = Array.isArray(conf && conf.fish) ? conf.fish : [];
  // 指定了 fishId 就只认那一条：它被禁用/不存在时回 null，绝不偷换别的鱼。
  const hit = fishId
    ? fish.find((f) => f && String(f.id) === String(fishId) && f.enabled !== false)
    : fish.find((f) => f && f.enabled !== false);
  if (!hit || !hit.code) return null;
  return {
    fishId: String(hit.id || ''),
    code: String(hit.code),
    persona: String(hit.persona || ''),
    chatSid: String(hit.chatSid || ''),
    alsoSids: Array.isArray(hit.alsoSids) ? hit.alsoSids.map(String) : [],
    baseUrl: normalizeBaseUrl(conf.baseUrl || DEFAULT_BASE),
  };
}

function numOr(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

/**
 * 创建一个客户端。fetchImpl 可注入（测试/离线）。
 * read(path) 只读；act(path, body) 只允许 visit/play/goto。
 */
export function createTownClient({ baseUrl, code, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, minGapMs = 700 } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const token = String(code || '').trim();
  if (!token) throw new TownError('no_code', '缺少小镇访问码（先在鱼缸小镇插件里登记一条鱼）');
  if (typeof fetchImpl !== 'function') throw new TownError('no_fetch', '当前运行环境没有 fetch');

  let lastAt = 0;
  let chain = Promise.resolve();

  async function once(pathname, { method = 'GET', body, query } = {}) {
    const clean = String(pathname || '').replace(/^\/+/, '');
    if (!/^[A-Za-z0-9_\-/]+$/.test(clean)) throw new TownError('bad_path', '非法的小镇路径');
    const gap = Math.max(0, minGapMs - (Date.now() - lastAt));
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastAt = Date.now();

    let url = base + '/' + clean;
    if (query && typeof query === 'object') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v != null && v !== '') qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
      throw new TownError(aborted ? 'timeout' : 'network', aborted ? '小镇请求超时' : '连不上小镇：' + redactCode(err && err.message), { path: clean });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) throw new TownError('redirect', '小镇返回了重定向，已拒绝', { status: res.status, path: clean });
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new TownError('too_large', '小镇返回体过大，已拒绝', { status: res.status, path: clean });

    let data = null;
    if (text.trim()) {
      try { data = JSON.parse(text); } catch { throw new TownError('bad_json', '小镇返回的不是 JSON', { status: res.status, path: clean }); }
    }
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      const reason = data && (data.error || data.reason || data.message);
      throw new TownError(res.status === 401 ? 'auth' : (res.status === 429 ? 'rate_limited' : 'http_' + res.status),
        redactCode('小镇返回 ' + res.status + (reason ? '：' + String(reason).slice(0, 120) : '')),
        { status: res.status, retryAfter, path: clean });
    }
    return data;
  }

  return {
    baseUrl: base,
    read(pathname, opts = {}) {
      chain = chain.then(() => once(pathname, opts), () => once(pathname, opts));
      return chain;
    },
    act(pathname, body) {
      const p = String(pathname || '').replace(/^\/+/, '');
      if (!ACT_PATHS.includes(p)) return Promise.reject(new TownError('bad_action', '不允许的小镇动作：' + p));
      chain = chain.then(() => once(p, { method: 'POST', body: body || {} }), () => once(p, { method: 'POST', body: body || {} }));
      return chain;
    },
  };
}

/**
 * 相册文件地址（不带授权头：服务端这个端点只认 id）。
 * origin 必须来自 normalizeBaseUrl 的结果，id 必须过 ALBUM_ID_RE —— 两样都不合法就抛。
 */
export function albumFileUrl(baseUrl, itemId, { thumb = false } = {}) {
  const id = String(itemId || '');
  if (!ALBUM_ID_RE.test(id)) throw new TownError('bad_album_id', '相册条目 id 不合法');
  const base = normalizeBaseUrl(baseUrl);
  const origin = new URL(base).origin;
  return origin + '/town/api/album/' + id + '/' + (thumb ? 'thumb' : 'file');
}

/** 常用只读端点（都走 rate 队列）。 */
export function makeReader(client) {
  return {
    status: () => client.read('status'),
    bonds: () => client.read('bonds'),
    lobby: () => client.read('lobby'),
    visits: (limit = 30) => client.read('visits', { query: { limit } }),
    visit: (id) => client.read('visits/' + encodeURIComponent(String(id))),
    week: (days = 7) => client.read('week', { query: { days } }),
    receipts: (limit = 30) => client.read('receipts', { query: { limit } }),
    album: (limit = 30) => client.read('album', { query: { limit } }),
    spending: () => client.read('spending'),
  };
}
