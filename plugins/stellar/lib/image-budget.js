/* 生图额度（owner 2026-11-11 22:25：开放生图，不再请示主人，每天最多 3 张）
 *
 * 本轮改动（2026-11-11）：
 *   · 原来的「超出额度 → 记待审 → 私聊主人请示」整条链路拆掉：主人说不用请示了；
 *   · 每日上限从 8 降到 3，这是现在唯一的硬闸；
 *   · 10 分钟窗口仍留 3 张，只作短时防抖（避免一口气刷图），不是主要限制。
 *
 * 原注释保留在下面，方便以后想恢复审批时看懂当初为什么这么写。
 *
 * 设计原则：
 *   · 硬闸在执行期守卫里（qq-tool-restrict），不靠提示词自觉；
 *   · 状态落在 state/image-budget.json，桥接 / 面板 / 插件都能读；
 *   · 审批只认「主人私聊里说同意」→ 桥接把 pending 标成 approved，她再调一次即放行并消费。
 *     这样不用给主人加面板操作，也不用解析她的自然语言。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const WINDOW_MS = 10 * 60 * 1000;
export const LIMIT = 3;
// 每日硬上限（owner 2026-11-11：每天最多 3 张，代码拦截；不再需要主人批准）。
export const DAILY_LIMIT = 3;
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

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

export function dailyUsed(now = Date.now(), st = null) {
  const state = st || readBudgetState(now);
  return state.allowed.filter((t) => sameLocalDay(t, now)).length;
}

export function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'stellar', 'state');
}
export function budgetFile() { return path.join(stateDir(), 'image-budget.json'); }

function emptyState() {
  return { version: 1, allowed: [], approvals: [], updatedAt: new Date().toISOString() };
}

export function readBudgetState(now = Date.now()) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(budgetFile(), 'utf8')); } catch {}
  const st = raw && typeof raw === 'object' ? raw : emptyState();
  st.allowed = Array.isArray(st.allowed) ? st.allowed.map(Number).filter((n) => Number.isFinite(n)) : [];
  st.approvals = Array.isArray(st.approvals) ? st.approvals.filter((a) => a && typeof a === 'object') : [];
  // 保留 24 小时内的记录，避免文件无限长
  const cutoff = now - 24 * 3600 * 1000;
  st.allowed = st.allowed.filter((t) => t > cutoff);
  st.approvals = st.approvals.filter((a) => Number(a.at) > cutoff);
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
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  try { fs.renameSync(tmp, file); } catch (error) { try { fs.unlinkSync(tmp); } catch {} throw error; }
}

export function usedInWindow(now = Date.now()) {
  const st = readBudgetState(now);
  return st.allowed.filter((t) => now - t < WINDOW_MS).length;
}

/** 主人私聊里说「同意 / 可以 / 画吧 / 批准」→ 放行一条待审请求。 */
export function approvePending({ by = 'owner', text = '', now = Date.now() } = {}) {
  const st = readBudgetState(now);
  const pending = st.approvals
    .filter((a) => a.status === 'pending' && now - Number(a.at) < APPROVAL_TTL_MS)
    .sort((a, b) => Number(b.at) - Number(a.at))[0];
  if (!pending) return null;
  pending.status = 'approved';
  pending.approvedAt = now;
  pending.approvedBy = by;
  pending.approvedText = String(text || '').slice(0, 120);
  st.updatedAt = new Date(now).toISOString();
  writeBudgetState(st);
  return pending;
}

/**
 * 调 image_generate 之前调它。
 * @returns {{ok:true, remaining:number}|{ok:false, reason:string, waitMs:number, pending:boolean}}
 */
export function takeImageSlot({ now = Date.now() } = {}) {
  const st = readBudgetState(now);
  // 0) 每日硬上限：批准额度也不能突破；到点直接拒绝，不生成待审。
  const todayCount = st.allowed.filter((t) => sameLocalDay(t, now)).length;
  if (todayCount >= DAILY_LIMIT) {
    return {
      ok: false,
      daily: true,
      reason: `今天已经画了 ${todayCount}/${DAILY_LIMIT} 张（每日上限）`,
      waitMs: Math.max(0, nextLocalMidnight(now) - now),
      pending: false,
    };
  }
  // 1) 先看有没有主人批过的额度
  const approved = st.approvals
    .filter((a) => a.status === 'approved' && now - Number(a.approvedAt || a.at) < APPROVAL_TTL_MS)
    .sort((a, b) => Number(a.approvedAt || 0) - Number(b.approvedAt || 0))[0];
  if (approved) {
    approved.status = 'used';
    approved.usedAt = now;
    st.allowed.push(now);
    st.updatedAt = new Date(now).toISOString();
    writeBudgetState(st);
    return { ok: true, remaining: 0, approved: true };
  }
  const recent = st.allowed.filter((t) => now - t < WINDOW_MS);
  if (recent.length < LIMIT) {
    // 只追加，不把 24 小时内的旧记录裁掉：每日上限要按全天计数。
    st.allowed.push(now);
    st.updatedAt = new Date(now).toISOString();
    writeBudgetState(st);
    return { ok: true, remaining: Math.max(0, LIMIT - recent.length) };
  }
  // 2) 超限：不再记待审、不再私聊主人（2026-11-11 主人决定开放生图）。
  //    只回一个可解释的拒绝，让调用方能算出「多久后能画」。
  const oldest = Math.min(...recent);
  return {
    ok: false,
    reason: `最近 10 分钟已经画了 ${recent.length}/${LIMIT} 张（每天最多 ${DAILY_LIMIT} 张）`,
    waitMs: Math.max(0, WINDOW_MS - (now - oldest)),
    pending: false,
  };
}

/** 待审列表（桥接用来私聊提醒主人，一次只提醒一条新增的）。 */
export function pendingApprovals(now = Date.now()) {
  const st = readBudgetState(now);
  return st.approvals
    .filter((a) => a.status === 'pending' && now - Number(a.at) < APPROVAL_TTL_MS)
    .sort((a, b) => Number(a.at) - Number(b.at));
}

export function approvalStatus(now = Date.now()) {
  const st = readBudgetState(now);
  const pending = st.approvals.filter((a) => a.status === 'pending' && now - Number(a.at) < APPROVAL_TTL_MS);
  const approved = st.approvals.filter((a) => a.status === 'approved' && now - Number(a.approvedAt || a.at) < APPROVAL_TTL_MS);
  return {
    used: st.allowed.filter((t) => now - t < WINDOW_MS).length,
    limit: LIMIT,
    dailyUsed: st.allowed.filter((t) => sameLocalDay(t, now)).length,
    dailyLimit: DAILY_LIMIT,
    pending: pending.length,
    approved: approved.length,
    lastPendingAt: pending.at(-1)?.at || 0,
  };
}
