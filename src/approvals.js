/**
 * 通用审批队列（轨道 C）。
 *
 * 非主人想让她做对外写动作（发说说/B站动态/评论/点赞/生图/分享）时，
 * MCP 工具或执行守卫不直接执行，而是往 state/approvals.json 里放一条
 * 不可篡改的请求；主人通过 QQ 私聊或控制台点头后，MCP 轮询器以主人
 * 权限代理执行一次。
 *
 * 设计约束：
 *  - 独立 JSON 文件 + tmp+rename 原子写；三进程（桥接/面板/MCP）用锁文件串行化。
 *  - requestId 幂等：pending→approved 只允许一次，第二次直接拒绝并审计。
 *  - 参数快照 + sha256；执行前重新算 hash，防止有人改 JSON 偷换参数。
 *  - 30 分钟过期；拒绝/过期/已执行都不再执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE_OVERRIDE = String(process.env.STELLAR_APPROVALS_FILE || '').trim();
export const APPROVALS_FILE = FILE_OVERRIDE ? path.resolve(FILE_OVERRIDE) : path.resolve(HERE, '..', 'state', 'approvals.json');
export const APPROVALS_AUDIT = APPROVALS_FILE.replace(/\.json$/i, '-audit.jsonl');
const LOCK_FILE = APPROVALS_FILE + '.lock';
const CONFIG_FILE = String(process.env.STELLAR_CONFIG_FILE || '').trim()
  ? path.resolve(String(process.env.STELLAR_CONFIG_FILE).trim())
  : path.resolve(HERE, '..', 'config.json');

/**
 * 审批总开关。默认开启；config.json 里 approvals.enabled === false 时关闭。
 * 关闭后：写动作恢复成「只有主人能直接做」，非主人直接拒绝；
 * 生图恢复成只受额度闸限制。改配置即时生效（每次调用都读，文件很小）。
 */
export function approvalsEnabled() {
  const env = String(process.env.STELLAR_APPROVALS_ENABLED || '').trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off') return false;
  if (env === '1' || env === 'true' || env === 'on') return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg?.approvals?.enabled !== false;
  } catch {
    return true;
  }
}
const TTL_MS = 30 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export const APPROVAL_ACTIONS = Object.freeze({
  qzone_post: { label: '发 QQ 空间说说', cost: 0.01 },
  qzone_react: { label: 'QQ 空间互动（赞/评论）', cost: 0.01 },
  qzone_delete_comment: { label: '删除空间评论', cost: 0.005 },
  bili_post: { label: '发 B 站动态', cost: 0.01 },
  bili_comment: { label: '发 B 站评论', cost: 0.01 },
  image_generate: { label: '生成图片', cost: 0.08 },
  bili_share: { label: '分享视频', cost: 0.01 },
});

function ensureDir() {
  fs.mkdirSync(path.dirname(APPROVALS_FILE), { recursive: true });
}

function sleep(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** 跨进程互斥：锁文件超过 15 秒视为死锁，直接清理。 */
function withLock(fn) {
  ensureDir();
  const deadline = Date.now() + 4000;
  let fd = null;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(LOCK_FILE, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > 15000) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {}
      sleep(25 + Math.floor(Math.random() * 25));
    }
  }
  if (fd == null) throw new Error('审批队列正忙（拿不到锁），稍后再试');
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

function emptyStore() {
  return { version: 1, updatedAt: 0, approvals: [] };
}

function readStore() {
  try {
    const raw = fs.readFileSync(APPROVALS_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !Array.isArray(j.approvals)) return emptyStore();
    return { version: 1, updatedAt: Number(j.updatedAt) || 0, approvals: j.approvals };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    try { fs.renameSync(APPROVALS_FILE, APPROVALS_FILE + '.corrupt-' + Date.now()); } catch {}
    return emptyStore();
  }
}

function writeStore(store) {
  ensureDir();
  const tmp = APPROVALS_FILE + '.tmp-' + process.pid + '-' + Date.now();
  const next = { version: 1, updatedAt: Date.now(), approvals: store.approvals };
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, APPROVALS_FILE);
}

function canonicalArgs(args) {
  // 只保留 JSON 安全结构；undefined/函数/循环引用一律剔除。
  try {
    return JSON.parse(JSON.stringify(args ?? {}));
  } catch {
    return {};
  }
}

export function hashArgs(args) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalArgs(args))).digest('hex');
}

function newId(now = Date.now()) {
  return 'apr_' + now.toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

export function audit(event, info = {}) {
  try {
    ensureDir();
    const line = JSON.stringify({ at: Date.now(), event, ...info }) + '\n';
    fs.appendFileSync(APPROVALS_AUDIT, line, 'utf8');
    const st = fs.statSync(APPROVALS_AUDIT);
    if (st.size > 2 * 1024 * 1024) {
      try { fs.renameSync(APPROVALS_AUDIT, APPROVALS_AUDIT + '.1'); } catch {}
    }
  } catch {}
}

function isExpired(rec, now = Date.now()) {
  return Number(rec.expiresAt) > 0 && now > Number(rec.expiresAt);
}

function expireInStore(store, now = Date.now()) {
  let changed = false;
  for (const rec of store.approvals) {
    if ((rec.status === 'pending' || rec.status === 'approved') && isExpired(rec, now)) {
      rec.status = 'expired';
      rec.expiredAt = now;
      changed = true;
      audit('expired', { requestId: rec.requestId });
    }
  }
  const cutoff = now - KEEP_MS;
  const kept = store.approvals.filter((rec) => Number(rec.createdAt) >= cutoff || rec.status === 'pending');
  if (kept.length !== store.approvals.length) {
    store.approvals = kept;
    changed = true;
  }
  return changed;
}

/** 清理过期与太老的记录；返回处理条数。 */
export function expireApprovals(now = Date.now()) {
  return withLock(() => {
    const store = readStore();
    if (!expireInStore(store, now)) return 0;
    writeStore(store);
    return 1;
  });
}

/**
 * 从会话 key 推出「这条审批最终要回给谁」。private:<QQ> / group:<群号>。
 * 会话 key 是模型传进来的，必须再和 requester 对一遍：对不上就以 requester 为准，
 * 避免非主人把 key 写成主人的、结果图片发到主人私聊。
 */
function resolveTarget(key, requester) {
  const k = String(key || '');
  const pm = k.match(/^private:(\d+)$/);
  const gm = k.match(/^group:(\d+)$/);
  const userId = String(requester?.userId || '');
  if (pm) {
    // requester.userId 与 key 不一致时（模型串了 key），优先 requester：他才是发起人。
    const qq = userId && userId !== pm[1] && !requester?.groupId ? userId : pm[1];
    return { targetKind: 'private', targetQQ: qq, targetGroup: '', targetSession: '' };
  }
  if (gm) return { targetKind: 'group', targetQQ: '', targetGroup: gm[1], targetSession: '' };
  return { targetKind: 'other', targetQQ: userId, targetGroup: '', targetSession: '' };
}

function readSessionId(key) {
  try {
    const file = path.join(path.dirname(APPROVALS_FILE), 'sessions.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return String(j?.[String(key)] || '');
  } catch {
    return '';
  }
}

/**
 * 建一条待审批请求。
 * @param {{key:string, requester?:object, action:string, args:object, summary?:string, estimatedCost?:number, ttlMs?:number, targetQQ?:string, targetGroup?:string, targetKind?:string, targetSession?:string}} input
 */
export function createApproval(input, now = Date.now()) {
  if (!approvalsEnabled()) throw new Error('审批已关闭（approvals.enabled=false）');
  const action = String(input?.action || '').trim();
  if (!action) throw new Error('缺少动作类型');
  const args = canonicalArgs(input?.args);
  const meta = APPROVAL_ACTIONS[action] || { label: action, cost: 0.01 };
  const requester = {
    key: String(input?.requester?.key || input?.key || ''),
    userId: String(input?.requester?.userId || ''),
    nickname: String(input?.requester?.nickname || ''),
    groupId: String(input?.requester?.groupId || ''),
    groupName: String(input?.requester?.groupName || ''),
  };
  const autoTarget = resolveTarget(input?.key, requester);
  const targetKind = String(input?.targetKind || autoTarget.targetKind || 'other');
  const targetQQ = targetKind === 'group'
    ? ''
    : String(input?.targetQQ || autoTarget.targetQQ || requester.userId || '');
  const targetGroup = targetKind === 'group'
    ? String(input?.targetGroup || autoTarget.targetGroup || requester.groupId || '')
    : '';
  const targetSession = String(input?.targetSession || readSessionId(input?.key) || '');
  const rec = {
    requestId: newId(now),
    key: String(input?.key || ''),
    requester,
    targetKind,
    targetQQ,
    targetGroup,
    targetSession,
    action,
    actionLabel: meta.label,
    args,
    argsHash: hashArgs(args),
    summary: String(input?.summary || buildSummary(action, args, meta)).slice(0, 500),
    estimatedCost: Number.isFinite(Number(input?.estimatedCost)) ? Number(input.estimatedCost) : meta.cost,
    status: 'pending',
    createdAt: now,
    expiresAt: now + Math.max(60_000, Math.min(60 * 60 * 1000, Number(input?.ttlMs) || TTL_MS)),
    notifiedAt: 0,
    wakeSentAt: 0,
    approvedAt: 0,
    approvedBy: '',
    rejectedAt: 0,
    rejectedBy: '',
    executingAt: 0,
    executedAt: 0,
    executedBy: '',
    result: '',
    error: '',
    attempts: 0,
  };
  withLock(() => {
    const store = readStore();
    expireInStore(store, now);
    store.approvals.push(rec);
    writeStore(store);
  });
  audit('created', {
    requestId: rec.requestId, key: rec.key, action, requester: rec.requester,
    targetKind: rec.targetKind, targetQQ: rec.targetQQ, targetGroup: rec.targetGroup,
    targetSession: rec.targetSession, summary: rec.summary, estimatedCost: rec.estimatedCost,
  });
  return rec;
}

function buildSummary(action, args, meta) {
  if (action === 'qzone_post') return '想说：' + String(args.text || '').slice(0, 120);
  if (action === 'bili_post') return '想发动态：' + String(args.text || '').slice(0, 120);
  if (action === 'bili_comment') return '想评论：' + String(args.message || '').slice(0, 120);
  if (action === 'qzone_react') return '空间互动：' + String(args.action || '') + ' ' + String(args.content || args.commentId || '').slice(0, 80);
  if (action === 'qzone_delete_comment') return '想删空间评论：' + String(args.commentId || '');
  if (action === 'image_generate') return '想画：' + String(args.prompt || '').slice(0, 120);
  return meta.label + ' ' + String(args.text || args.message || '').slice(0, 100);
}

export function listApprovals(opts = {}) {
  const now = Number(opts.now) || Date.now();
  const store = readStore();
  const status = String(opts.status || '').trim();
  const items = status ? store.approvals.filter((r) => r.status === status) : store.approvals.slice();
  return items
    .filter((r) => opts.key ? String(r.key) === String(opts.key) : true)
    .filter((r) => opts.action ? String(r.action) === String(opts.action) : true)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    .map((r) => ({ ...r, expired: r.status === 'pending' && isExpired(r, now), secondsLeft: Math.max(0, Math.round((Number(r.expiresAt) - now) / 1000)) }));
}

export function getApproval(id) {
  const wanted = String(id || '');
  return readStore().approvals.find((r) => String(r.requestId) === wanted) || null;
}

export function markApprovalWoken(id, now = Date.now()) {
  return withLock(() => {
    const store = readStore();
    const rec = store.approvals.find((r) => r.requestId === String(id));
    if (!rec || rec.status !== 'approved' || rec.wakeSentAt) return false;
    rec.wakeSentAt = now;
    writeStore(store);
    audit('woken', { requestId: id });
    return true;
  });
}

export function markNotified(id, now = Date.now()) {
  return withLock(() => {
    const store = readStore();
    const rec = store.approvals.find((r) => r.requestId === String(id));
    if (!rec || rec.notifiedAt) return false;
    rec.notifiedAt = now;
    writeStore(store);
    return true;
  });
}

/** 只允许 pending → approved；重复批准直接返回 duplicate，不执行第二次。 */
export function approveApproval(id, by = 'owner', now = Date.now()) {
  let result = null;
  withLock(() => {
    const store = readStore();
    expireInStore(store, now);
    const rec = store.approvals.find((r) => r.requestId === String(id));
    if (!rec) { result = { ok: false, code: 'not_found', message: '没找到这条审批（可能已经过期清理了）' }; return; }
    if (rec.status === 'approved' || rec.status === 'executing' || rec.status === 'executed') {
      audit('duplicate-approve', { requestId: rec.requestId, status: rec.status, by });
      result = { ok: false, code: 'duplicate', message: '这条已经批准过了，不会执行第二次（当前状态：' + rec.status + '）', approval: rec };
      return;
    }
    if (rec.status !== 'pending') {
      result = { ok: false, code: 'not_pending', message: '这条已经不能批准了（当前状态：' + rec.status + '）', approval: rec };
      return;
    }
    rec.status = 'approved';
    rec.approvedAt = now;
    rec.approvedBy = String(by || 'owner');
    writeStore(store);
    result = { ok: true, approval: rec };
  });
  if (result?.ok) audit('approved', { requestId: result.approval.requestId, by, action: result.approval.action });
  else if (result) audit('approve-rejected', { requestId: id, by, code: result.code, message: result.message });
  return result;
}

export function rejectApproval(id, by = 'owner', now = Date.now()) {
  let result = null;
  withLock(() => {
    const store = readStore();
    expireInStore(store, now);
    const rec = store.approvals.find((r) => r.requestId === String(id));
    if (!rec) { result = { ok: false, code: 'not_found', message: '没找到这条审批' }; return; }
    if (rec.status !== 'pending') {
      result = { ok: false, code: 'not_pending', message: '这条已经处理过了（当前状态：' + rec.status + '）', approval: rec };
      return;
    }
    rec.status = 'rejected';
    rec.rejectedAt = now;
    rec.rejectedBy = String(by || 'owner');
    writeStore(store);
    result = { ok: true, approval: rec };
  });
  if (result?.ok) audit('rejected', { requestId: id, by, action: result.approval.action });
  return result;
}

/** 执行前认领：approved → executing，只有一次。 */
export function claimApproval(id, now = Date.now()) {
  let result = null;
  withLock(() => {
    const store = readStore();
    const rec = store.approvals.find((r) => r.requestId === String(id));
    if (!rec) { result = { ok: false, code: 'not_found' }; return; }
    if (rec.status !== 'approved') { result = { ok: false, code: 'not_approved', status: rec.status }; return; }
    if (isExpired(rec, now)) {
      rec.status = 'expired';
      rec.expiredAt = now;
      writeStore(store);
      result = { ok: false, code: 'expired' };
      return;
    }
    rec.status = 'executing';
    rec.executingAt = now;
    rec.attempts = Number(rec.attempts || 0) + 1;
    writeStore(store);
    result = { ok: true, approval: { ...rec } };
  });
  if (result?.ok) audit('claimed', { requestId: id });
  return result;
}

/** 进程崩溃/被杀死后，executing 记录会永远卡住：启动时把超时的标成 failed，允许主人重新提交。 */
export function recoverStaleExecutions(now = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  let fixed = 0;
  withLock(() => {
    const store = readStore();
    for (const rec of store.approvals) {
      if (rec.status !== 'executing') continue;
      const at = Number(rec.executingAt) || Number(rec.approvedAt) || Number(rec.createdAt) || 0;
      if (now - at < maxAgeMs) continue;
      rec.status = 'failed';
      rec.executedAt = now;
      rec.executedBy = 'recovery';
      rec.error = '执行进程中断（MCP 重启/被杀），这次没有完成，需要重新提交';
      fixed += 1;
    }
    if (fixed) writeStore(store);
  });
  if (fixed) audit('failed', { requestId: 'stale-recovery', count: fixed, error: 'executing 超时回收' });
  return fixed;
}

export function finishApproval(id, outcome = {}, now = Date.now()) {
  const ok = outcome.ok === true;
  let result = null;
  withLock(() => {
    const store = readStore();
    const rec = store.approvals.find((r) => r.requestId === String(id));
    if (!rec) { result = { ok: false, code: 'not_found' }; return; }
    rec.status = ok ? 'executed' : 'failed';
    rec.executedAt = now;
    rec.executedBy = String(outcome.by || 'owner-proxy');
    rec.result = String(outcome.result || '').slice(0, 4000);
    rec.error = String(outcome.error || '').slice(0, 1000);
    writeStore(store);
    result = { ok: true, approval: rec };
  });
  audit(ok ? 'executed' : 'failed', {
    requestId: id,
    result: String(outcome.result || '').slice(0, 300),
    error: String(outcome.error || '').slice(0, 300),
  });
  return result;
}

/** 幂等/防篡改校验：参数快照与哈希必须对得上。 */
export function verifyApproval(rec) {
  if (!rec || !rec.argsHash) return false;
  return hashArgs(rec.args) === rec.argsHash;
}

/** 生图守卫用：取当前会话已批准、尚未消费的生图请求，并标记为执行中。 */
export function takeApprovedImage(key, now = Date.now()) {
  let found = null;
  withLock(() => {
    const store = readStore();
    const candidates = store.approvals
      .filter((r) => r.action === 'image_generate' && r.status === 'approved'
        && String(r.key) === String(key) && !isExpired(r, now))
      .sort((a, b) => Number(a.approvedAt) - Number(b.approvedAt));
    const rec = candidates[0];
    if (!rec) return;
    rec.status = 'executing';
    rec.executingAt = now;
    rec.attempts = Number(rec.attempts || 0) + 1;
    writeStore(store);
    found = { ...rec };
  });
  if (found) audit('image-consumed', { requestId: found.requestId, key });
  return found;
}

export function hasPendingImage(key) {
  return listApprovals({ status: 'pending', key, action: 'image_generate' }).length > 0;
}

export function stats(now = Date.now()) {
  const all = listApprovals({ now });
  return {
    pending: all.filter((r) => r.status === 'pending').length,
    approved: all.filter((r) => r.status === 'approved').length,
    executing: all.filter((r) => r.status === 'executing').length,
    executed: all.filter((r) => r.status === 'executed').length,
    rejected: all.filter((r) => r.status === 'rejected').length,
    expired: all.filter((r) => r.status === 'expired').length,
    failed: all.filter((r) => r.status === 'failed').length,
    total: all.length,
  };
}
