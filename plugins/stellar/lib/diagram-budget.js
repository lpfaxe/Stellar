/* 绘图额度：非主人每天 20 张、10 分钟 10 张；主人不限。
 * 硬闸在 qq-tool-restrict 的 diagramBudgetGuard，不靠提示词自觉。
 * 状态落 state/diagram-budget.json，桥接/面板/插件共用同一份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const WINDOW_MS = 10 * 60 * 1000;
export const WINDOW_LIMIT = 10;
export const DAILY_LIMIT = 20;

function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function nextLocalMidnight(now) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'stellar', 'state');
}

export function budgetFile() { return path.join(stateDir(), 'diagram-budget.json'); }

function emptyState() {
  return { version: 1, allowed: [], updatedAt: new Date(0).toISOString() };
}

export function readBudgetState(now = Date.now()) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(budgetFile(), 'utf8')); } catch { /* 读坏按空处理 */ }
  const st = raw && typeof raw === 'object' ? raw : emptyState();
  st.allowed = Array.isArray(st.allowed) ? st.allowed.map(Number).filter((n) => Number.isFinite(n)) : [];
  const cutoff = now - 24 * 3600 * 1000;
  st.allowed = st.allowed.filter((t) => t > cutoff);
  return st;
}

export function writeBudgetState(st) {
  const file = budgetFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(st, null, 2) + '\n', 'utf8');
    try { fs.fsyncSync(fd); } catch { /* ignore */ }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  try { fs.renameSync(tmp, file); } catch (error) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw error; }
}

export function budgetStatus(now = Date.now()) {
  const st = readBudgetState(now);
  return {
    dailyUsed: st.allowed.filter((t) => sameLocalDay(t, now)).length,
    dailyLimit: DAILY_LIMIT,
    windowUsed: st.allowed.filter((t) => now - t < WINDOW_MS).length,
    windowLimit: WINDOW_LIMIT,
    windowMs: WINDOW_MS,
  };
}

/**
 * 调用绘图工具前先占额度。
 * @returns {{ok:true, owner:boolean, remainingDaily:number, remainingWindow:number}|{ok:false, daily:boolean, window:boolean, reason:string, waitMs:number}}
 */
export function takeDiagramSlot({ now = Date.now(), isOwner = false } = {}) {
  if (isOwner) {
    return { ok: true, owner: true, remainingDaily: Infinity, remainingWindow: Infinity };
  }
  const st = readBudgetState(now);
  const todayCount = st.allowed.filter((t) => sameLocalDay(t, now)).length;
  if (todayCount >= DAILY_LIMIT) {
    return {
      ok: false,
      daily: true,
      window: false,
      reason: '今天已经画了 ' + todayCount + '/' + DAILY_LIMIT + ' 张（非主人每日上限）',
      waitMs: Math.max(0, nextLocalMidnight(now) - now),
    };
  }
  const recent = st.allowed.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= WINDOW_LIMIT) {
    const oldest = Math.min(...recent);
    return {
      ok: false,
      daily: false,
      window: true,
      reason: '最近 10 分钟已经画了 ' + recent.length + '/' + WINDOW_LIMIT + ' 张',
      waitMs: Math.max(0, WINDOW_MS - (now - oldest)),
    };
  }
  st.allowed.push(now);
  st.updatedAt = new Date(now).toISOString();
  writeBudgetState(st);
  return {
    ok: true,
    owner: false,
    remainingDaily: Math.max(0, DAILY_LIMIT - todayCount - 1),
    remainingWindow: Math.max(0, WINDOW_LIMIT - recent.length - 1),
  };
}
