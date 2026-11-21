/**
 * Stellar —— 小镇快照：把「她这两天在小镇怎么样」写成一份小 JSON，给控制台读。
 *
 * 为什么单独一份文件：面板是另一个进程（stellar-manager），不该为了看一眼小镇
 * 去开我们的 sqlite、更不该拿访问码自己去请求小镇。调度器每轮采集顺手写一份
 * state/town/status.json，面板只读文件 —— 只读、不联网、不碰 token。
 *
 * 里面绝不含访问码（fbo_…）；写之前整份文本过一遍打码。
 */
import fs from 'node:fs';
import path from 'node:path';

import { makeReader } from './town-client.js';
import { townStats, listNotes } from './town-store.js';
import { readActionState, listActionsToday, summarizeActions } from './town-actions.js';
import { townBudgetStateFromDataDir } from './town-budget.js';
import { renderRecall } from './town-memory-pure.js';
import { localDayKey } from './token-budget.js';

export const SNAPSHOT_VERSION = 1;

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 小镇 /status 的结构见过几种写法（snake_case 为主），这里都认。 */
function pickStatus(s) {
  const raw = s && typeof s === 'object' ? s : {};
  const card = raw.card && typeof raw.card === 'object' ? raw.card : {};
  const turns = raw.turns && typeof raw.turns === 'object' ? raw.turns : {};
  const prefs = turns.prefs && typeof turns.prefs === 'object' ? turns.prefs : {};
  const games = Array.isArray(prefs.games) ? prefs.games.map((g) => String(g)).slice(0, 12) : [];
  return {
    online: String(raw.outside_state || raw.outsideState || '') === 'in_town',
    outsideState: String(raw.outside_state || raw.outsideState || ''),
    ready: String(raw.state || '') === 'ready',
    townName: String(raw.town_name || raw.townName || card.town_name || ''),
    fishId: String(raw.fish_id || raw.fishId || ''),
    badge: String(raw.badge || ''),
    name: String(card.name || raw.name || ''),
    piggyYuan: num(raw.piggy_yuan ?? raw.piggyYuan, 0),
    games,
    signup: String(prefs.signup || ''),
    takeVisits: prefs.take_visits !== false,
    visitOthers: prefs.visit_others !== false,
  };
}

function pickBonds(b) {
  const raw = b && typeof b === 'object' ? b : {};
  const names = (v) => (Array.isArray(v) ? v : []).slice(0, 20).map((x) => (typeof x === 'string' ? x : String((x && (x.name || x.nick || x.fish_name)) || ''))).filter(Boolean);
  return {
    friends: names(raw.friends),
    rivals: names(raw.rivals),
    couple: names(raw.couple),
    crush: names(raw.crush),
  };
}

function pickSpending(s) {
  const raw = s && typeof s === 'object' ? s : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/**
 * 组装快照（纯函数，好测）。任何一块缺了都不抛，缺的留空。
 */
export function buildSnapshot({ now = Date.now(), status = null, bonds = null, spending = null, lobby = null, stats = null, actions = null, budget = null, errors = [], pump = null } = {}) {
  const day = localDayKey(new Date(Number(now) || Date.now()));
  const st = pickStatus(status);
  const lob = lobby && typeof lobby === 'object' ? lobby : {};
  const rooms = Array.isArray(lob.rooms) ? lob.rooms : Array.isArray(lob.tables) ? lob.tables : [];
  return {
    version: SNAPSHOT_VERSION,
    at: Number(now) || Date.now(),
    day,
    ok: errors.length === 0,
    errors: errors.slice(0, 6),
    status: st,
    bonds: pickBonds(bonds),
    spending: pickSpending(spending),
    lobby: {
      tables: rooms.length,
      names: rooms.slice(0, 12).map((r) => String((r && (r.name || r.title || r.id)) || '')).filter(Boolean),
    },
    memory: {
      notes: num(stats && stats.notes, 0),
      days: num(stats && stats.days, 0),
      impressions: num(stats && stats.impressions, 0),
      dayLines: num(stats && stats.dayLines, 0),
    },
    actions: {
      today: actions ? listActionsToday(actions, day).length : 0,
      summary: actions ? summarizeActions(actions, day) : '今天还没动过。',
      list: actions ? listActionsToday(actions, day).slice(-5).map((a) => ({ at: num(a.at), type: String(a.type || ''), target: String(a.target || ''), ok: a.ok !== false })) : [],
    },
    budget: {
      spent: num(budget && budget.spent, 0),
      cap: num(budget && budget.cap, 0),
      blocked: Boolean(budget && budget.blocked),
    },
    pump: pump && typeof pump === 'object' ? { running: Boolean(pump.running), connected: Boolean(pump.connected), lastOkAt: num(pump.lastOkAt, 0), errors: num(pump.errors, 0) } : null,
    recall: '',
  };
}

/** 打码：快照里绝不许出现访问码。 */
export function redactSnapshot(obj) {
  return JSON.parse(JSON.stringify(obj).replace(/fbo_[A-Za-z0-9_\-]{6,}/g, 'fbo_***'));
}

/**
 * 采一轮快照并落盘。绝不抛：小镇 502 时旧快照留着，只把错误记进 errors。
 */
export async function writeTownSnapshot({ dir, client, db, now = Date.now(), actionsFile, townConfig = {}, pump = null, log } = {}) {
  const errors = [];
  const reader = makeReader(client);
  const pull = async (name, fn) => {
    try { return await fn(); } catch (err) {
      errors.push(name + ': ' + String((err && err.code) || '') + ' ' + String((err && err.message) || err).slice(0, 80));
      return null;
    }
  };
  const status = await pull('status', () => reader.status());
  const bonds = await pull('bonds', () => reader.bonds());
  const spending = await pull('spending', () => reader.spending());
  const lobby = await pull('lobby', () => reader.lobby());
  let stats = null;
  try { if (db) stats = townStats({ db }); } catch {}
  let actions = null;
  try { if (actionsFile) actions = readActionState(actionsFile, { today: localDayKey(new Date(now)) }); } catch {}
  // 入参是「数据目录」（state/town 往上两级），townSpendToday 那套会再拼一次 stellar，永远读到 0（2026-11-21 修）
  const budget = townBudgetStateFromDataDir(path.dirname(path.dirname(dir)), townConfig);

  const snap = redactSnapshot(buildSnapshot({ now, status, bonds, spending, lobby, stats, actions, budget, errors, pump }));
  // 顺手给面板一句「她现在记得什么」，免得面板自己拼（也就 400 字上限那套）。
  try {
    if (db) snap.recall = String(redactSnapshot({ t: snapshotRecall(db, now) }).t).slice(0, 400);
  } catch {}

  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'status.json');
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file, snapshot: snap };
  } catch (err) {
    if (typeof log === 'function') log('[town] 快照没写成：' + String((err && err.message) || err).slice(0, 120));
    return { ok: false, error: String((err && err.message) || err), snapshot: snap };
  }
}

/** 面板那一句「她现在记得什么」：直接复用 recall 渲染（同样 400 字上限）。 */
function snapshotRecall(db, now) {
  const notes = listNotes({ days: [], limit: 60, db });
  return renderRecall({ notes, today: localDayKey(new Date(Number(now) || Date.now())) });
}
