/**
 * 代理状态机：LISTEN / ACTIVE / COOLDOWN / SLEEP。
 *
 * 目标（按用户改造规格）：
 *   · 监听事件驱动，不轮询；定时器只做一次 30s 的到期检查（O(keys)）；
 *   · 一条消息只处理一次：按 (会话, messageId) 幂等认领，重复直接丢弃；
 *   · 8 分钟没有对话回 SLEEP；SLEEP 时回调释放重缓存（模型句柄由 DSH 自理）；
 *   · 未完成任务不杀进程，只留在队列里。
 */
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_STATES = ['LISTEN', 'ACTIVE', 'COOLDOWN', 'SLEEP'];

const DEFAULTS = {
  idleMs: 5 * 60 * 1000,      // 5 分钟无对话 → SLEEP（2026-11-10 主人要：空闲 5 分钟自动休眠）
  cooldownMs: 15 * 1000,      // 一轮结束后短暂冷却
  tickMs: 30 * 1000,
  maxSeen: 800,               // 幂等表上限（超出按时间淘汰一半）
};

function emptyState() {
  return { version: 1, updatedAt: new Date().toISOString(), conversations: {}, seen: {} };
}

export function createAgentState({ file, idleMs, cooldownMs, tickMs, maxSeen, onSleep, onWake, log = () => {}, now = () => Date.now() } = {}) {
  const cfg = {
    ...DEFAULTS,
    idleMs: Number(idleMs) || DEFAULTS.idleMs,
    cooldownMs: Number(cooldownMs) || DEFAULTS.cooldownMs,
    tickMs: Number(tickMs) || DEFAULTS.tickMs,
    maxSeen: Number(maxSeen) || DEFAULTS.maxSeen,
  };
  let state = emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      state = {
        ...emptyState(),
        ...raw,
        conversations: raw.conversations && typeof raw.conversations === 'object' ? raw.conversations : {},
        seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
      };
    }
  } catch {}

  // 2026-11-11 主人要的「最低限度运行模式」：只有 QQ 来消息才醒，醒后 2 分钟没动静
  // 就回去睡。idleMs 原来在创建时固化成常量，这里给一个口子让桥接按运行模式改。
  function setIdleMs(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v <= 0) return cfg.idleMs;
    cfg.idleMs = v;
    return cfg.idleMs;
  }

  let dirty = false;
  let saveTimer = null;
  let tickTimer = null;

  function persist(immediate = false) {
    dirty = true;
    if (immediate) { flush(); return; }
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    try {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid);
      state.updatedAt = new Date(now()).toISOString();
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      log('[state] 落盘失败：' + (error?.message || error));
    }
  }

  function entry(key) {
    const k = String(key || '');
    if (!state.conversations[k]) {
      state.conversations[k] = { state: 'LISTEN', lastAt: now(), activeSince: 0, turns: 0 };
    }
    return state.conversations[k];
  }

  function setState(key, next, reason = '') {
    const item = entry(key);
    if (item.state === next) { item.lastAt = now(); return false; }
    const from = item.state;
    item.state = next;
    item.lastAt = now();
    item.reason = reason;
    if (next === 'ACTIVE') item.activeSince = now();
    persist();
    log('[state] ' + key + ': ' + from + ' → ' + next + (reason ? '（' + reason + '）' : ''));
    return true;
  }

  /** 幂等认领：同一条消息（同会话 + messageId）只处理一次。 */
  function claim(key, messageId) {
    const id = String(messageId ?? '').trim();
    if (!id) return true;
    const dedupeKey = String(key || '') + '|' + id;
    if (state.seen[dedupeKey]) return false;
    state.seen[dedupeKey] = now();
    const size = Object.keys(state.seen).length;
    if (size > cfg.maxSeen) {
      const entries = Object.entries(state.seen).sort((a, b) => Number(a[1]) - Number(b[1]));
      for (const [k] of entries.slice(0, Math.floor(size / 2))) delete state.seen[k];
    }
    persist();
    return true;
  }

  /** 收到消息 / 开始处理：进入 ACTIVE。 */
  function touch(key, reason = 'incoming') {
    const item = entry(key);
    item.lastAt = now();
    if (item.state !== 'ACTIVE') {
      const wasSleeping = item.state === 'SLEEP';
      setState(key, 'ACTIVE', reason);
      item.lastAt = now();
      if (wasSleeping && typeof onWake === 'function') {
        try { onWake(key); } catch {}
      }
    } else {
      persist();
    }
  }

  /** 开始一件长任务：busy>0 时 sweep 不判空闲，避免干活干到一半被判 SLEEP。 */
  function beginTask(key, label = '') {
    const item = entry(key);
    item.busy = Math.max(0, Number(item.busy) || 0) + 1;
    item.busyLabel = String(label || '').slice(0, 40);
    item.busyAt = now();
    item.lastAt = now();
    if (item.state !== 'ACTIVE') setState(key, 'ACTIVE', 'task-start');
    else persist();
  }

  /** 任务结束：恢复空闲计时（从这一刻重新算 5 分钟）。 */
  function endTask(key) {
    const item = entry(key);
    item.busy = Math.max(0, (Number(item.busy) || 0) - 1);
    item.lastAt = now();
    persist();
  }

  /** 一轮结束：先 COOLDOWN，冷却结束再回 LISTEN。 */
  function endTurn(key) {
    const item = entry(key);
    item.turns = (Number(item.turns) || 0) + 1;
    setState(key, 'COOLDOWN', 'turn-end');
    item.cooldownUntil = now() + cfg.cooldownMs;
  }

  function sweep() {
    const t = now();
    for (const [key, item] of Object.entries(state.conversations)) {
      if (!item) continue;
      if (item.state === 'COOLDOWN' && t >= (Number(item.cooldownUntil) || 0)) {
        // 直接改字段而不是 setState：setState 会刷新 lastAt，把空闲计时冲掉，永远进不了 SLEEP。
        item.state = 'LISTEN';
        item.reason = 'cooldown-done';
        dirty = true;
      }
      // 8 分钟没有新消息就睡：不看当前处于 ACTIVE 还是 COOLDOWN/LISTEN，
      // 只看到最后一条消息/投递的时间，避免「回合结束就永远叫不醒」。
      // 正在执行任务（busy>0）不睡：任务期间没有新消息是正常的。
      if ((Number(item.busy) || 0) > 0) continue;
      if (item.state !== 'SLEEP' && t - (Number(item.lastAt) || 0) >= cfg.idleMs) {
        setState(key, 'SLEEP', 'idle');
        if (typeof onSleep === 'function') { try { onSleep(key); } catch {} }
      }
    }
  }

  function start() {
    if (tickTimer) return;
    tickTimer = setInterval(sweep, cfg.tickMs);
    if (tickTimer.unref) tickTimer.unref();
  }

  function stop() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    flush();
  }

  function status() {
    const conversations = Object.entries(state.conversations).map(([key, item]) => ({
      key,
      state: item?.state || 'LISTEN',
      lastAt: item?.lastAt || 0,
      activeSince: item?.activeSince || 0,
      turns: Number(item?.turns) || 0,
      reason: item?.reason || '',
    }));
    return {
      states: AGENT_STATES,
      counts: conversations.reduce((acc, item) => { acc[item.state] = (acc[item.state] || 0) + 1; return acc; }, {}),
      conversations,
      seen: Object.keys(state.seen).length,
      updatedAt: state.updatedAt,
    };
  }

  return { claim, touch, beginTask, endTask, endTurn, setState, status, start, stop, sweep, flush, setIdleMs, config: cfg };
}
