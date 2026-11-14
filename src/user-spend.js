/**
 * 非管理员每人每天聊天额度（默认 ¥1）。
 *
 * 为什么要单独记账：tokenLedger 是「按会话」记的，群里所有人共用一个 group:<id>。
 * 这里按**触发这一轮的人**记：桥接在回合结束时取这一轮的费用，累加到该 QQ 名下。
 * 状态文件：%USERPROFILE%\.dsh\stellar\state\user-spend.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const USER_SPEND_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'stellar', 'state', 'user-spend.json');
const KEEP_DAYS = 3;

function dayKey(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(USER_SPEND_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (data && typeof data === 'object' && data.users && typeof data.users === 'object') return data;
  } catch {}
  return { version: 1, users: {}, seenTurns: {} };
}

function writeAll(state) {
  fs.mkdirSync(path.dirname(USER_SPEND_FILE), { recursive: true });
  const tmp = USER_SPEND_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, USER_SPEND_FILE);
}

function prune(state, now = Date.now()) {
  const cutoff = dayKey(now - KEEP_DAYS * 24 * 3600 * 1000);
  for (const [uin, row] of Object.entries(state.users || {})) {
    if (!row || String(row.day || '') < cutoff) delete state.users[uin];
  }
  const seenCutoff = now - 2 * 24 * 3600 * 1000;
  for (const [key, at] of Object.entries(state.seenTurns || {})) {
    if (Number(at) < seenCutoff) delete state.seenTurns[key];
  }
}

export function spentToday(uin, now = Date.now()) {
  const key = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(key)) return 0;
  const state = readAll();
  const row = state.users?.[key];
  if (!row || row.day !== dayKey(now)) return 0;
  return Math.max(0, Number(row.cost) || 0);
}

/**
 * 记一轮费用。turnKey 用来幂等（同一轮重复回填不会翻倍）。
 * @returns {{ok:boolean, cost:number, total:number, skipped?:string}}
 */
export function addTurnCost({ uin, cost, turnKey, at = Date.now(), key = '' } = {}) {
  const user = String(uin || '').trim();
  const amount = Math.max(0, Number(cost) || 0);
  if (!/^\d{5,12}$/.test(user)) return { ok: false, cost: 0, total: 0, skipped: 'no-uin' };
  if (amount <= 0) return { ok: false, cost: 0, total: spentToday(user, at), skipped: 'zero' };
  const state = readAll();
  prune(state, at);
  const tk = String(turnKey || '');
  if (tk && state.seenTurns?.[tk]) return { ok: false, cost: 0, total: spentToday(user, at), skipped: 'seen' };
  if (tk) state.seenTurns[tk] = at;
  const day = dayKey(at);
  const cur = state.users?.[user];
  const row = cur && cur.day === day ? cur : { day, cost: 0, tokens: 0, turns: 0, updatedAt: 0, lastKey: '' };
  row.cost = Math.round((Number(row.cost) + amount) * 10000) / 10000;
  row.turns = (Number(row.turns) || 0) + 1;
  row.updatedAt = at;
  row.lastKey = String(key || '');
  state.users = state.users || {};
  state.users[user] = row;
  writeAll(state);
  return { ok: true, cost: amount, total: row.cost, skipped: '' };
}

/**
 * 当天额度标记：warned = 已经提醒过「快用完」，farewelled = 已经解释过并收尾。
 * 和花费记在同一行，跨桥接重启保留（否则重启一次就再解释一遍）。
 */
export function quotaFlags(uin, now = Date.now()) {
  const key = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(key)) return { warned: false, farewelled: false };
  const state = readAll();
  const row = state.users?.[key];
  if (!row || row.day !== dayKey(now)) return { warned: false, farewelled: false };
  return { warned: Boolean(row.warnedAt), farewelled: Boolean(row.farewellAt) };
}

/** 打一个标记：flag = 'warn' | 'farewell'。没有花费行时也建一行，保证当天有效。 */
export function markQuotaFlag(uin, flag, now = Date.now()) {
  const key = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(key)) return false;
  const state = readAll();
  prune(state, now);
  const day = dayKey(now);
  const cur = state.users?.[key];
  const row = cur && cur.day === day ? cur : { day, cost: 0, tokens: 0, turns: 0, updatedAt: 0, lastKey: '' };
  if (flag === 'farewell') row.farewellAt = now;
  else row.warnedAt = now;
  row.updatedAt = now;
  state.users = state.users || {};
  state.users[key] = row;
  writeAll(state);
  return true;
}

export function snapshot(now = Date.now()) {
  const state = readAll();
  const day = dayKey(now);
  const rows = Object.entries(state.users || {})
    .filter(([, row]) => row && row.day === day)
    .map(([uin, row]) => ({ uin, cost: Number(row.cost) || 0, turns: Number(row.turns) || 0, updatedAt: Number(row.updatedAt) || 0, lastKey: row.lastKey || '' }))
    .sort((a, b) => b.cost - a.cost);
  return { day, rows, total: rows.reduce((s, r) => s + r.cost, 0) };
}
