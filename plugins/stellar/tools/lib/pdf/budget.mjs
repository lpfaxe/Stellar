// PDF 深度读取额度（非主人）：每天 5 次、每 10 分钟 2 次；主人不限、不写状态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAILY_LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_LIMIT = 2;

function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'stellar', 'state');
}

function budgetFile() {
  return path.join(stateDir(), 'pdf-budget.json');
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function readState(now) {
  const today = new Date(now);
  try {
    const raw = JSON.parse(fs.readFileSync(budgetFile(), 'utf8'));
    if (!raw || raw.version !== 1) throw new Error('bad state');
    const allowed = Array.isArray(raw.allowed) ? raw.allowed.filter((t) => Number.isFinite(t)) : [];
    const day = raw.day ? new Date(raw.day) : today;
    if (!sameLocalDay(day, today)) return { version: 1, day: today.toISOString(), allowed: [] };
    return { version: 1, day: day.toISOString(), allowed };
  } catch {
    return { version: 1, day: today.toISOString(), allowed: [] };
  }
}

// 必须同步：DSH 的 ctx.tools.guard 是同步执行守卫，返回 Promise 会被当成「已放行」
// 之外的空值/真值误判（2026-11-27 主人被限流的根因就是 await 漏在调用方）。
function writeState(state) {
  const file = budgetFile();
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(state), 'utf8');
    try { fs.fsyncSync(fd); } catch { /* ignore */ }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  try { fs.renameSync(tmp, file); }
  catch (error) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw error; }
}

export function takePdfSlot({ now = Date.now(), isOwner = false } = {}) {
  if (isOwner) return { ok: true, owner: true };
  const t = Number(now) || Date.now();
  const state = readState(t);
  const recent = state.allowed.filter((x) => t - x < WINDOW_MS);
  if (recent.length >= WINDOW_LIMIT) {
    const waitMs = Math.max(0, WINDOW_MS - (t - Math.min(...recent)));
    return { ok: false, window: true, reason: '最近 10 分钟已经读了 ' + recent.length + '/' + WINDOW_LIMIT + ' 次 PDF', waitMs };
  }
  if (state.allowed.length >= DAILY_LIMIT) {
    return { ok: false, daily: true, reason: '今天已经读了 ' + state.allowed.length + '/' + DAILY_LIMIT + ' 次 PDF' };
  }
  state.allowed.push(t);
  writeState(state);
  return { ok: true, remainingDaily: DAILY_LIMIT - state.allowed.length, remainingWindow: WINDOW_LIMIT - recent.length - 1 };
}

export function pdfBudgetStatus({ now = Date.now() } = {}) {
  const t = Number(now) || Date.now();
  const state = readState(t);
  return {
    dailyLimit: DAILY_LIMIT,
    windowLimit: WINDOW_LIMIT,
    usedDaily: state.allowed.length,
    usedWindow: state.allowed.filter((x) => t - x < WINDOW_MS).length
  };
}

export { DAILY_LIMIT, WINDOW_LIMIT, WINDOW_MS, budgetFile, stateDir };
