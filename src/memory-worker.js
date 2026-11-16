/**
 * 记忆库的后台作业（worker）。
 *
 * 职责（P0 只有前两件，都是纯代码、不调模型）：
 *  1) split   —— 把 cache_msg 里 process_state='new' 的行按「同一会话 + 间隔 ≤20 分钟 + ≤60 条 + ≤6000 字」
 *                切段；段内**双方都说过话**才建话题（topic），单边段先 held，挂满 2 小时丢 dropped，
 *                够长（≥40 字）的单边独白降级成 fragment（零碎记忆），不当话题。
 *  2) window  —— 每天 00:05 把 D-2 的 cache/topic/fragment 复核后清空（先导出到 trash，再删）。
 *                important 的不参与删除（keep=1）。
 *  3) profile / style 留接口不实现 —— 它们要调模型，放在插件侧（有 ctx.llm），见 P1。
 *
 * 为什么切分放这里而不是 prompt：模型每分钟被叫醒一次的成本太高，而「哪几句是一个话题」
 * 本质上可以用时间间隔与说话人判断。标题/摘要先用「首条用户消息 + 前两条拼起来」的机械做法，
 * 复核阶段（P1）再让模型改写成更好读的标题。
 *
 * 这个文件**不 import 任何桥接/插件模块**，只依赖 memory-db.js，方便插件侧与脚本侧都用。
 */
import {
  openDb, pendingRows, heldRows, segmentRows, insertTopic, insertFragment,
  markRows, dropStaleHeld, pruneWindow, saveJobState, jobState, dayKey, stats,
  promoteTopic, getProfile, upsertProfile, upsertFact,
} from './memory-db.js';
import { extractFacts, looksFactful } from './memory-facts.js';

const HOLD_MS = 2 * 60 * 60 * 1000;      // 单边段最多挂 2 小时
const MONOLOGUE_MIN_CHARS = 40;          // 单边独白够长才降级成零碎记忆
// 复核时间（本地）：默认 06:30 —— 这台机器 0 点后断电断网、早上 6 点恢复供电，
// 排在 00:05 的作业等于永远不跑。实际值由 config.json 的 memory.window 覆盖。
const WINDOW_HOUR = 6;
const WINDOW_MINUTE = 30;
const WINDOW_DAYS = 2;                    // D-2

function ymd(at) {
  const d = new Date(at);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

/** 机械标题：首条用户消息的前 24 字；没有用户消息用首条 self。 */
function autoTitle(rows) {
  const pick = rows.find((r) => r.role === 'user' && String(r.text || '').trim()) || rows.find((r) => String(r.text || '').trim());
  const text = String(pick?.text || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 24) : '（未命名话题）';
}

/** 机械摘要：用户那边前两段拼起来（120 字内）。P1 的复核阶段会改写成更好的。 */
function autoSummary(rows) {
  const parts = rows.filter((r) => r.role === 'user').map((r) => String(r.text || '').trim()).filter(Boolean);
  return parts.slice(0, 2).join(' / ').slice(0, 120);
}

/**
 * 切一段（已确认可建话题）。
 * 返回 { ok, id } 或 { ok:false, reason }。
 */
function buildTopic(seg, db, { importance = 0, tier } = {}) {
  const rows = seg.rows;
  const topic = {
    ownerId: seg.oid,
    conversationKey: seg.ck,
    dayKey: rows[0]?.day_key || dayKey(seg.startedAt),
    title: autoTitle(rows),
    summary: autoSummary(rows),
    startedAt: seg.startedAt,
    endedAt: seg.endedAt,
    importance,
    tier,
  };
  return insertTopic({ topic, rows, db });
}

/**
 * 跑一次切分。
 * opts: { limit=400, minCharsForTopic=0, dryRun=false, db, log }
 * 返回 { ok, segments, topics:[id], held, dropped, fragments, errors }
 */
/**
 * 从一批 user 行里抽事实写进 fact 表（纯代码，不花钱）。
 *
 * 为什么不放在复核（模型）里：生日是「一句话就能定」的事实，等一天后的复核等于当天用不上；
 * 而复核那一步是给「这段话值不值得记」用的，两件事混在一起会让复核 prompt 变长变慢。
 * 归属只用行自己的 owner_id —— 群聊里谁说的就算谁的，绝不按当前会话 owner 猜。
 *
 * 返回 { scanned, written, rows }：写进 job_state 的 stats 里，出问题时能看出来是「没抽到」
 * 还是「没扫描」。
 */
export function extractFactsFromRows(rows = [], { db: conn, log } = {}) {
  const db = conn || openDb();
  const out = { scanned: 0, written: 0, ids: [] };
  for (const row of rows) {
    if (String(row.role || '') !== 'user') continue;
    const text = String(row.text || '');
    if (!looksFactful(text)) continue;
    out.scanned += 1;
    let list = [];
    try { list = extractFacts(text); } catch { list = []; }
    for (const f of list) {
      try {
        const res = upsertFact({
          ownerId: row.oid || row.owner_id || 'unknown',
          kind: f.kind,
          label: f.label,
          text: f.text,
          privacy: f.privacy,
          weight: f.weight,
          source: 'auto',
          at: Number(row.at) || Date.now(),
          db,
        });
        if (res && res.ok) { out.written += 1; out.ids.push(res.id); }
      } catch (error) {
        try { if (log) log('[记忆] 事实写入失败：' + (error?.message ?? error)); } catch {}
      }
    }
  }
  return out;
}

/**
 * 一次性回填：把库里已有的 user 行重新抽一遍事实。
 *
 * 为什么需要它：事实抽取是后加的能力，而「生日是1月1日」那条消息早就被切分标成
 * fragment/dropped 了 —— 等新消息重新提到生日，可能是一年后。只写 fact 表，
 * 不动 cache_msg 的 process_state、不建话题，跑几次都幂等（upsertFact 按 owner+kind+label 去重）。
 */
export function backfillFacts({ db: conn, limit = 5000, log } = {}) {
  const db = conn || openDb();
  const rows = db.prepare(
    "SELECT id, conversation_key AS ck, owner_id AS oid, role, text, at, day_key FROM cache_msg "
    + "WHERE role = 'user' ORDER BY at DESC LIMIT ?",
  ).all(Number(limit) || 5000);
  const res = extractFactsFromRows(rows, { db, log });
  let facts = 0;
  try { facts = Number(db.prepare('SELECT COUNT(*) AS n FROM fact').get().n) || 0; } catch {}
  return { ok: true, rows: rows.length, ...res, facts };
}

export function runSplit(opts = {}) {
  const db = opts.db || openDb();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const out = { ok: true, segments: 0, topics: [], held: 0, dropped: 0, fragments: 0, errors: [] };

  // 1) 先处理挂太久的单边段（now 可注入，测试里要能把时钟推到未来）
  try {
    const stale = dropStaleHeld({ holdMs: HOLD_MS, now: Number(opts.now) || Date.now(), db });
    out.dropped += stale.dropped || 0;
  } catch (error) {
    out.errors.push('dropStaleHeld: ' + (error?.message ?? error));
  }

  // 2) 新行 + 之前 held 的行一起切（held 可能这次能配上对方的话）
  let rows = [];
  try {
    const fresh = pendingRows({ limit: opts.limit || 400, db });
    const held = heldRows({ limit: 200, db });
    rows = fresh.concat(held).sort((a, b) => (a.ck === b.ck ? a.at - b.at : String(a.ck).localeCompare(String(b.ck))));
  } catch (error) {
    return { ...out, ok: false, errors: out.errors.concat('read: ' + (error?.message ?? error)) };
  }
  if (!rows.length) return out;

  // 2.5) 先把事实抽出来（纯代码、不花钱）：切分要双方发言，事实不用等对方回话。
  try {
    const facts = extractFactsFromRows(rows.map((r) => ({ ...r, owner_id: r.oid })), { db, log });
    out.facts = facts.written;
    if (facts.written) log('[记忆] 抽到 ' + facts.written + ' 条人物事实');
  } catch (error) {
    out.errors.push('facts: ' + (error?.message ?? error));
  }

  // 3) 切段
  const segments = segmentRows(rows, { gapMs: 20 * 60 * 1000, maxMsgs: 60, maxChars: 6000 });
  out.segments = segments.length;

  for (const seg of segments) {
    const roles = new Set(seg.rows.map((r) => r.role));
    const both = roles.has('user') && roles.has('self');
    const ids = seg.rows.map((r) => r.id);
    if (opts.dryRun) {
      out.topics.push({ dryRun: true, ck: seg.ck, n: seg.rows.length, both, title: autoTitle(seg.rows) });
      continue;
    }
    if (!both) {
      // 单边段：够长就是独白（零碎记忆），不够长就 held 等下一轮
      const text = seg.rows.map((r) => String(r.text || '').trim()).filter(Boolean).join(' ');
      try {
        if (text.length >= MONOLOGUE_MIN_CHARS) {
          const facet = roles.has('self') ? 'self-monologue' : 'user-monologue';
          insertFragment({ ownerId: seg.oid, day: seg.rows[0]?.day_key || dayKey(seg.startedAt), text, facet, weight: 1, at: seg.endedAt, db });
          markRows(ids, 'fragment', { db });
          out.fragments += 1;
        } else {
          markRows(ids, 'held', { db });
          out.held += ids.length;
        }
      } catch (error) {
        out.errors.push('single-side ' + seg.ck + ': ' + (error?.message ?? error));
      }
      continue;
    }
    try {
      const res = buildTopic(seg, db, opts.topic || {});
      if (res.ok) out.topics.push(res.id);
      else {
        out.errors.push('topic ' + seg.ck + ': ' + (res.reason || 'unknown'));
        markRows(ids, 'held', { db });
        out.held += ids.length;
      }
    } catch (error) {
      out.errors.push('topic ' + seg.ck + ': ' + (error?.message ?? error));
    }
  }

  try {
    saveJobState('split', { lastRunAt: Date.now(), lastError: out.errors[0] || '', stats: { segments: out.segments, topics: out.topics.length, held: out.held, fragments: out.fragments, facts: Number(out.facts) || 0 } }, { db });
  } catch {}
  if (out.errors.length) log('[memory] 切分告警：' + out.errors.slice(0, 3).join(' | '));
  return out;
}

/**
 * 取 D-2 的候选（复核输入）：只给标题 + 摘要 + 零碎文本，不含全文。
 * 折中：全文可能几千字，这里每人最多 12 条、每条 80 字，够判断又不烧钱。
 */
export function reviewCandidates({ targetDay, db: conn, perOwner = 12, maxChars = 80 } = {}) {
  const db = conn || openDb();
  const day = String(targetDay || '');
  if (!day) return { day: '', topics: [], fragments: [] };
  const clip = (v) => {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    return s.length > maxChars ? s.slice(0, maxChars) + '…' : s;
  };
  const topics = db.prepare(
    "SELECT id, owner_id, title, summary, importance FROM topic WHERE day_key = ? AND tier = 'daily' ORDER BY owner_id, ended_at",
  ).all(day).slice(0, perOwner * 6).map((r) => ({
    id: r.id, ownerId: r.owner_id, title: clip(r.title), summary: clip(r.summary), importance: Number(r.importance) || 0,
  }));
  const fragments = db.prepare(
    "SELECT id, owner_id, text, facet FROM fragment WHERE day_key = ? AND tier = 'daily' ORDER BY owner_id, at",
  ).all(day).slice(0, perOwner * 6).map((r) => ({ id: Number(r.id), ownerId: r.owner_id, text: clip(r.text), facet: r.facet || '' }));
  return { day, topics, fragments };
}

/** 复核用的 prompt（模型只回 JSON）。 */
export function buildReviewPrompt(cand) {
  const lines = [];
  lines.push('下面是 ' + cand.day + '（前天）留下的记忆条目。判断哪些「两天后还值得记住」，只回 JSON，不要解释。');
  lines.push('');
  lines.push('## 话题');
  if (!cand.topics.length) lines.push('（无）');
  for (const item of cand.topics) {
    lines.push('- ' + item.id + ' | ' + item.title + (item.summary && item.summary !== item.title ? ' | ' + item.summary : ''));
  }
  lines.push('');
  lines.push('## 零碎');
  if (!cand.fragments.length) lines.push('（无）');
  for (const frag of cand.fragments) {
    lines.push('- #' + frag.id + ' [' + (frag.facet || 'note') + '] ' + frag.text);
  }
  lines.push('');
  lines.push('判断标准：称呼、约定、雷区、身份事实、长期偏好、未完成的事 → 值得；');
  lines.push('一次性的寒暄、当天的心情、已经被后来的话推翻的内容 → 不值得。');
  lines.push('');
  lines.push('要求：');
  lines.push('1) 只输出一个 JSON 对象：{"promote":["话题id或#零碎id"],"rewrite":[{"id":"话题id","title":"不超过20字","summary":"不超过60字"}],"reason":"一句话"}');
  lines.push('2) promote 里只能出现上面列出的 id；宁少不多，没有就空数组。');
  lines.push('3) rewrite 只对话题用，改的是给人看的标题与摘要，不要编造原文没有的事实。');
  return lines.join('\n');
}

/** 从模型输出里抠出 JSON（容忍围栏与前后废话）。围栏字符用 charCode 拼，避免本文件出现三反引号。 */
export function parseReviewJson(text) {
  const FENCE = String.fromCharCode(96, 96, 96);
  let raw = String(text || '').trim();
  raw = raw.split(FENCE + 'json').join('').split(FENCE).join('').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/**
 * 复核 + 晋升 + 清理（P1 主体）。
 *
 * 硬规则（不靠模型）：
 *  · ask 不可用 / 返回解析失败 → **这一次整体不删**，job_state 记 failed，等下一次 tick；
 *  · 只晋升，不删 important；删除交给 pruneWindow（它只动 tier='daily' 与 keep=0）；
 *  · 晋升写 promote_reason='review'，面板上能看出是机器判的。
 */
export async function runReview(opts = {}) {
  const db = opts.db || openDb();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = Number(opts.now) || Date.now();
  const check = windowDue({ now, db, window: opts.window });
  const targetDay = opts.targetDay || check.targetDay;
  const ask = typeof opts.ask === 'function' ? opts.ask : null;
  if (!opts.force && !check.due) return { ok: true, skipped: check.reason, targetDay };
  if (!targetDay) return { ok: true, skipped: 'no-target', targetDay: '' };

  const cand = reviewCandidates({ targetDay, db });
  const reviewed = cand.topics.length + cand.fragments.length;
  if (!reviewed) {
    // 没东西可复核：直接清理（只清缓存），不花钱调模型
    const res = opts.dryRun ? { ok: true, dryRun: true, deleted: {} } : pruneWindow({ targetDay, trashDir: opts.trashDir, db });
    try {
      saveJobState('window', { dayKey: check.today || ymd(now), cursor: targetDay, state: 'done', lastRunAt: now, lastError: '', stats: { reviewed: 0, promoted: 0, deleted: res.deleted || {} } }, { db });
    } catch {}
    return { ok: true, targetDay, empty: true, reviewed: 0, promoted: 0, promotedIds: [], deleted: res.deleted || {}, reason: 'nothing-to-review' };
  }
  if (!ask) {
    try { saveJobState('window', { dayKey: check.today || ymd(now), cursor: targetDay, state: 'pending', lastRunAt: now, lastError: 'model-unavailable', stats: { reviewed } }, { db }); } catch {}
    log('[memory] 复核跳过：模型通道不可用，' + targetDay + ' 的数据先留着');
    return { ok: false, skipped: 'model-unavailable', targetDay, reviewed };
  }

  let decision = null;
  let askError = '';
  try {
    const text = await ask({
      system: '你是 Stellar 的记忆复核器。只输出 JSON。',
      user: buildReviewPrompt(cand),
      maxTokens: 1200,
      reasoningEffort: 'low',
    });
    decision = parseReviewJson(text);
    if (!decision) askError = 'model-returned-non-json';
  } catch (error) {
    askError = error && error.message ? error.message : String(error);
  }
  if (!decision) {
    try { saveJobState('window', { dayKey: check.today || ymd(now), cursor: targetDay, state: 'failed', lastRunAt: now, lastError: askError, stats: { reviewed } }, { db }); } catch {}
    log('[memory] 复核失败（不删除，等下一轮）：' + askError);
    return { ok: false, error: askError, targetDay, reviewed };
  }

  const topicIds = new Set(cand.topics.map((item) => item.id));
  const fragIds = new Set(cand.fragments.map((item) => Number(item.id)));
  const promoteRaw = Array.isArray(decision.promote) ? decision.promote : [];
  const promotedIds = [];
  const errors = [];
  for (const raw of promoteRaw) {
    const key = String(raw || '').trim();
    if (topicIds.has(key)) {
      try { if (promoteTopic(key, { reason: 'review', db })) promotedIds.push(key); } catch (e) { errors.push('promote ' + key + ': ' + (e && e.message ? e.message : e)); }
      continue;
    }
    const fid = Number(key.replace(/^#/, ''));
    if (Number.isFinite(fid) && fragIds.has(fid)) {
      try {
        const info = db.prepare("UPDATE fragment SET tier = 'important', promoted_at = ? WHERE id = ? AND tier = 'daily'").run(now, fid);
        if (Number(info.changes || 0) > 0) promotedIds.push('#' + fid);
      } catch (e) { errors.push('promote #' + fid + ': ' + (e && e.message ? e.message : e)); }
    }
  }

  const rewrites = Array.isArray(decision.rewrite) ? decision.rewrite : [];
  let rewritten = 0;
  for (const item of rewrites.slice(0, 40)) {
    const id = String((item && item.id) || '').trim();
    if (!topicIds.has(id)) continue;
    const title = String((item && item.title) || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const summary = String((item && item.summary) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title && !summary) continue;
    try {
      db.prepare("UPDATE topic SET title = CASE WHEN ? <> '' THEN ? ELSE title END, summary = CASE WHEN ? <> '' THEN ? ELSE summary END WHERE id = ?")
        .run(title, title, summary, summary, id);
      rewritten += 1;
    } catch (e) { errors.push('rewrite ' + id + ': ' + (e && e.message ? e.message : e)); }
  }

  let deleted = {};
  if (!opts.dryRun) {
    const res = pruneWindow({ targetDay, trashDir: opts.trashDir, db });
    if (res.ok) deleted = res.deleted || {};
    else errors.push('prune: ' + (res.reason || 'failed'));
  }
  try {
    saveJobState('window', {
      dayKey: check.today || ymd(now), cursor: targetDay, state: errors.length ? 'failed' : 'done', lastRunAt: now, lastError: errors[0] || '',
      stats: { reviewed, promoted: promotedIds.length, rewritten, deleted, reason: String(decision.reason || '').slice(0, 80) },
    }, { db });
  } catch {}
  log('[memory] 复核 ' + targetDay + '：看过 ' + reviewed + ' 条 / 晋升 ' + promotedIds.length + ' / 改写 ' + rewritten + ' / 删除 话题' + (deleted.topics || 0) + ' 零碎' + (deleted.fragments || 0) + ' 缓存' + (deleted.cache || 0));
  return { ok: errors.length === 0, targetDay, reviewed, promoted: promotedIds.length, promotedIds, rewritten, deleted, errors, reason: String(decision.reason || '') };
}

/**
 * 到点了吗：本地 memory.window（默认 06:30）之后、且今天还没跑过 window。
 * 用 job_state 记 dayKey，避免进程重启后重复跑。
 */
export function windowDue({ now = Date.now(), db: conn, window: win } = {}) {
  const db = conn || openDb();
  const d = new Date(now);
  const hour = Number.isFinite(Number(win && win.hour)) ? Number(win.hour) : WINDOW_HOUR;
  const minute = Number.isFinite(Number(win && win.minute)) ? Number(win.minute) : WINDOW_MINUTE;
  if (d.getHours() < hour) return { due: false, reason: 'too-early' };
  if (d.getHours() === hour && d.getMinutes() < minute) return { due: false, reason: 'too-early' };
  const today = ymd(now);
  const st = jobState('window', { db });
  if (st && st.dayKey === today && st.state === 'done') return { due: false, reason: 'done-today', targetDay: st.cursor || '' };
  const target = ymd(now - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { due: true, targetDay: target, today };
}

/**
 * 跑一次窗口清理（只清 D-2，且不碰 important）。
 * opts: { now, targetDay, trashDir, dryRun, db, log }
 */
export function runWindow(opts = {}) {
  const db = opts.db || openDb();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = Number(opts.now) || Date.now();
  const check = windowDue({ now, db, window: opts.window });
  const targetDay = opts.targetDay || check.targetDay;
  if (!opts.force) {
    if (!check.due) return { ok: true, skipped: check.reason, targetDay };
    if (!targetDay) return { ok: true, skipped: 'no-target', targetDay: '' };
  }
  if (opts.dryRun) {
    const s = stats({ db });
    return { ok: true, dryRun: true, targetDay, before: s };
  }
  try {
    const res = pruneWindow({ targetDay, trashDir: opts.trashDir, db });
    saveJobState('window', { dayKey: check.today || ymd(now), cursor: targetDay, state: 'done', lastRunAt: now, lastError: '', stats: res.deleted || {} }, { db });
    log('[memory] 窗口清理 ' + targetDay + '：话题 ' + (res.deleted?.topics || 0) + ' / 零碎 ' + (res.deleted?.fragments || 0) + ' / 缓存 ' + (res.deleted?.cache || 0));
    return res;
  } catch (error) {
    const message = error?.message ?? String(error);
    try { saveJobState('window', { dayKey: check.today || ymd(now), cursor: targetDay, state: 'failed', lastRunAt: now, lastError: message }, { db }); } catch {}
    log('[memory] 窗口清理失败：' + message);
    return { ok: false, error: message, targetDay };
  }
}

/**
 * 定时器一次心跳：切分 → 复核（有模型通道时复核+晋升后清理；没有通道时才退化成纯清理）。
 * 插件侧每 10 分钟调一次。返回结构里 window 与 review 是同一个作业的两条路，只会有其一非空。
 */
export function runTick(opts = {}) {
  const split = runSplit(opts);
  const hasAsk = typeof opts.ask === 'function';
  let window = null;
  let review = null;
  if (hasAsk) {
    // runReview 是 async（要等模型），这里同步返回 promise 链：调用方 await runTick 即可
    return Promise.resolve(runReview(opts)).then((res) => ({ split, window: null, review: res, ...(res && res.ok === false ? {} : {}) }));
  }
  window = runWindow(opts);
  return { split, window, review: null };
}

/**
 * 人物侧写（模块四，P1）：把「近 2 天话题标题 + important 标题 + 零碎」压成一句 ≤50 字的人设。
 * 输入只给标题与零碎，不给全文 —— 每人一次调用约 1.5K in / 100 out。
 */
const FRAGMENT_PROMPT_CHARS = 160;

export function profileCandidates({ db: conn, perOwner = 20, maxChars = 60, fragChars = FRAGMENT_PROMPT_CHARS } = {}) {
  const db = conn || openDb();
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const owners = db.prepare('SELECT DISTINCT owner_id FROM topic WHERE ended_at >= ? UNION SELECT DISTINCT owner_id FROM fragment WHERE at >= ?').all(since, since);
  const out = [];
  for (const row of owners) {
    const ownerId = String(row.owner_id || '');
    if (!ownerId) continue;
    const prof = getProfile(ownerId, { db });
    if (prof && String(prof.source) === 'manual') continue; // 手改过的不再自动覆盖
    const topics = db.prepare(
      "SELECT title, tier, importance FROM topic WHERE owner_id = ? AND (ended_at >= ? OR tier = 'important') ORDER BY ended_at DESC LIMIT ?",
    ).all(ownerId, since, perOwner).map((item) => String(item.title || '').slice(0, maxChars)).filter(Boolean);
    // 2026-11-16 修：零碎原来也按 maxChars(60) 截，于是「生日是6月29日」被截成
    // 「生日是6月2」，模型照着写出「6月2日生日」并落进 detail。标题需要短，零碎需要完整，
    // 两者用同一个上限是错的。
    const fragMax = Math.max(maxChars, Number(fragChars) || FRAGMENT_PROMPT_CHARS);
    const frags = db.prepare('SELECT text FROM fragment WHERE owner_id = ? ORDER BY at DESC LIMIT ?')
      .all(ownerId, perOwner).map((item) => String(item.text || '').slice(0, fragMax)).filter(Boolean);
    if (!topics.length) continue;
    const msgCount = Number(db.prepare('SELECT COUNT(*) AS n FROM cache_msg WHERE owner_id = ?').get(ownerId)?.n || 0);
    out.push({
      ownerId, topics, frags, msgCount,
      persona: prof ? String(prof.persona || '') : '',
      detail: prof ? String(prof.detail || '') : '',
      // profile.tags 在库里是 JSON 字符串，直接 Array.isArray 会永远拿不到旧标签。
      tags: (() => {
        if (!prof) return [];
        if (Array.isArray(prof.tags)) return prof.tags.map((x) => String(x || '')).filter(Boolean).slice(0, 4);
        try { const arr = JSON.parse(String(prof.tags || '[]')); return Array.isArray(arr) ? arr.map((x) => String(x || '')).filter(Boolean).slice(0, 4) : []; } catch { return []; }
      })(),
    });
  }
  return out;
}

/**
 * 从模型输出里抠出侧写 JSON。
 *
 * 2026-11-16 修：原来只做「去掉围栏 → 找第一个 { 和最后一个 }」，任何截断都直接抛
 * 「模型没有返回 JSON」。deepseek-flash 的思考 token 计入输出预算，主人那条提示词最长
 * （800 字符，含 4 条零碎 + 上一版 detail），maxTokens=500 时 JSON 被腰斩成
 * {"persona":"…","detail":"…（没收尾），于是每轮都失败、侧写永远停在旧内容。
 * 现在保留宽松兜底（能抠出 persona 就用），但只当兜底，正文仍然优先整段解析。
 */
export function parseProfileJson(text) {
  const FENCE = String.fromCharCode(96, 96, 96);
  const raw = String(text || '').trim().split(FENCE + 'json').join('').split(FENCE).join('').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  // ① 完整对象优先：最后一个 } 在第一个 { 之后才算有闭合。
  if (s >= 0 && e > s) {
    try {
      const obj = JSON.parse(raw.slice(s, e + 1));
      if (obj && typeof obj === 'object') return { obj, partial: false };
    } catch {}
  }
  // ② 截断兜底：persona 在最前面，通常已经写完。**不能写在 ① 里面**
  //    （没有闭合的 } 时 e < s，走不进 ①，兜底就永远摸不到）。
  if (s >= 0) {
    const m = raw.slice(s).match(/"persona"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try { return { obj: { persona: JSON.parse('"' + m[1] + '"') }, partial: true }; } catch {}
    }
  }
  return { obj: null, partial: false };
}
export function buildProfilePrompt(cand) {
  const lines = [];
  lines.push('下面是这个人和她聊过的内容的标题与零碎（不是全文）。用一句话写出这个人：他是谁、怎么相处、要注意什么。');
  lines.push('');
  if (cand.topics.length) {
    lines.push('## 聊过的事');
    for (const item of cand.topics) lines.push('- ' + item);
  }
  if (cand.frags.length) {
    lines.push('');
    lines.push('## 零碎');
    for (const item of cand.frags) lines.push('- ' + item);
  }
  if (cand.persona || cand.detail) {
    lines.push('');
    lines.push('## 现在的侧写（在上面修订，不要从头重写）');
    if (cand.persona) lines.push('persona：' + cand.persona);
    if (cand.detail) lines.push('detail：' + cand.detail);
    if (cand.tags && cand.tags.length) lines.push('tags：' + cand.tags.join('、'));
    lines.push('');
    lines.push('上一版里仍然成立的细节要留着（称呼、口味、作息、答应过的事）；新看到的事加进去；');
    lines.push('只有明显过时或矛盾的才删。detail 如果没什么可加，就把上一版原样抄回来。');
  }
  lines.push('');
  lines.push('只输出 JSON：{"persona":"不超过50字的一句话","detail":"不超过150字的补充","tags":["最多4个词"]}');
  lines.push('写「习惯与相处方式」，不要写「关系称谓」，不要编原文没有的事。');
  // 2026-11-16：零碎是长文本截出来的，末尾可能断在半句话上（「生日是6月2」）。
  // 不提醒的话模型会把断口当事实补全，写出错误日期。
  lines.push('零碎是从长消息里截出来的，末尾可能断在半句上；没说完的不要补全、不要猜数字和日期。');
  return lines.join('\n');
}

/** 每日侧写：有模型通道才跑；每人一次调用，失败不影响别人。 */
export async function runProfiles(opts = {}) {
  const db = opts.db || openDb();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = Number(opts.now) || Date.now();
  const ask = typeof opts.ask === 'function' ? opts.ask : null;
  const cands = profileCandidates({ db });
  if (!ask) return { ok: false, skipped: 'model-unavailable', candidates: cands.length };
  if (!cands.length) return { ok: true, skipped: 'no-candidates', candidates: 0 };
  const done = [];
  const errors = [];
  for (const cand of cands.slice(0, 6)) {
    try {
      const user = buildProfilePrompt(cand);
      // 第一遍：留足预算（思考 token 也算在这个额度里）。
      // 第二遍：关掉思考 + 更大额度，只在第一遍拿不到可用 persona 时走，避免多花钱。
      const attempts = [
        { maxTokens: 1200, reasoningEffort: 'low' },
        { maxTokens: 2000, reasoningEffort: 'off', note: '只输出一行 JSON，不要写解释。' },
      ];
      let obj = null;
      let persona = '';
      let lastText = '';
      for (const attempt of attempts) {
        const text = await ask({
          system: '你是 Stellar 的侧写器。只输出 JSON。',
          user: attempt.note ? user + '\n\n' + attempt.note : user,
          maxTokens: attempt.maxTokens,
          reasoningEffort: attempt.reasoningEffort,
        });
        lastText = String(text || '');
        const parsed = parseProfileJson(lastText);
        const got = String((parsed.obj && parsed.obj.persona) || '').replace(/\s+/g, ' ').trim().slice(0, 50);
        // 抠到 persona 才算这遍成立；只有 detail 的 JSON 也要再试一次。
        if (parsed.obj && got) { obj = parsed.obj; persona = got; break; }
      }
      if (!obj) throw new Error('模型没有返回 JSON（原文：' + lastText.replace(/\s+/g, ' ').slice(0, 80) + '）');
      // 模型有时把 detail 留空：那就保留上一版，别把好不容易攒的细节洗掉。
      const nextDetail = String(obj.detail || '').replace(/\s+/g, ' ').trim().slice(0, 200) || String(cand.detail || '').slice(0, 200);
      const nextTags = (Array.isArray(obj.tags) ? obj.tags.slice(0, 4).map((x) => String(x).slice(0, 12)) : []).filter(Boolean);
      const res = upsertProfile({
        ownerId: cand.ownerId, persona,
        detail: nextDetail,
        tags: nextTags.length ? nextTags : (cand.tags || []),
        source: 'auto', confidence: 70, msgCount: cand.msgCount, editedBy: 'worker', db,
      });
      if (res && res.ok) done.push(cand.ownerId);
      else errors.push(cand.ownerId + ': ' + ((res && res.reason) || 'upsert failed'));
    } catch (error) {
      errors.push(cand.ownerId + ': ' + (error && error.message ? error.message : String(error)));
    }
  }
  try {
    saveJobState('profile', { lastRunAt: now, lastError: errors[0] || '', stats: { candidates: cands.length, written: done.length } }, { db });
  } catch {}
  if (done.length) log('[memory] 侧写更新 ' + done.length + ' 人');
  if (errors.length) log('[memory] 侧写失败：' + errors.slice(0, 2).join(' | '));
  return { ok: errors.length === 0, candidates: cands.length, written: done.length, owners: done, errors };
}
