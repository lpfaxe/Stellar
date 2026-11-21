/**
 * Stellar —— 小镇动作的限额账本（visit / play / goto）。
 *
 * 为什么要有这一层：
 *   她可以自己决定去谁家、坐哪桌，但**次数**和**间隔**必须是有数的：
 *   · 一天最多 actionDailyMax 次（默认 3），免得醒来就刷、把小镇当任务清单；
 *   · 两次之间至少 actionMinGapMin 分钟（默认 15），免得同一桌反复坐下/退出；
 *   · 日预算闸（town-budget.js）是第三层，花到上限直接不让她动。
 * 账本写在 state/town/actions.json（{date, list:[{at,type,target,ok,note}]}），
 * 跨天自动重置；面板读的就是这份文件。访问码、正文原话都不进这里。
 *
 * 只有 IO 边界（read/write）碰文件，其余是纯函数，方便测试。
 */
import fs from 'node:fs';
import path from 'node:path';

export const TOWN_ACTIONS = Object.freeze(['visit', 'play', 'goto']);
export const DEFAULT_ACTION_DAILY_MAX = 3;
export const DEFAULT_ACTION_MIN_GAP_MIN = 15;

/** 账本路径：<townDir>/actions.json（townDir 一般是 <DSH_HOME>/stellar/state/town）。 */
export function actionStatePath(townDir) {
  return path.join(String(townDir || ''), 'actions.json');
}

/** 当天的新账本。 */
export function emptyActionState(today) {
  return { date: String(today || ''), list: [] };
}

/** 读账本；跨天自动重置。文件坏了就当空账本（不阻止她今天动一次，但会覆盖写回）。 */
export function readActionState(file, { today = '' } = {}) {
  const day = String(today || '');
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return emptyActionState(day); }
  let parsed = null;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return emptyActionState(day); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyActionState(day);
  const date = String(parsed.date || '');
  const list = Array.isArray(parsed.list) ? parsed.list.filter((x) => x && Number.isFinite(Number(x.at))) : [];
  // 日期对不上 = 新的一天（或时钟被改），旧记录不参与今天的额度。
  if (day && date !== day) return emptyActionState(day);
  return { date: date || day, list };
}

/** 原子写账本（同目录 tmp + rename）；失败只记日志，不抛给调用方。 */
export function writeActionState(file, state, { log } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    if (typeof log === 'function') log('[town] 动作账本写入失败：' + String((error && error.message) || error).slice(0, 120));
    return false;
  }
}

/** 今天的动作记录（按时间正序）。 */
export function listActionsToday(state, today = '') {
  const day = String(today || (state && state.date) || '');
  const list = Array.isArray(state && state.list) ? state.list : [];
  return list.filter((x) => x && (!day || String(x.date || day) === day)).slice().sort((a, b) => Number(a.at) - Number(b.at));
}

/**
 * 动作前的三道闸。返回 { ok:true } 或 { ok:false, code, reason }。
 * code: 'bad_action' | 'budget' | 'cap' | 'gap'
 */
export function actionGate({ state, today = '', now = Date.now(), cap = DEFAULT_ACTION_DAILY_MAX, minGapMin = DEFAULT_ACTION_MIN_GAP_MIN, budget = null } = {}) {
  const todayList = listActionsToday(state, today);
  if (budget && budget.blocked) {
    return {
      ok: false,
      code: 'budget',
      reason: '今天小镇已经花到上限了（¥' + Number(budget.cap || 0).toFixed(2) + '，已花 ¥' + Number(budget.spent || 0).toFixed(2) + '）。今天先不花钱，只看、只记。'
    };
  }
  const max = Math.max(0, Number(cap) || 0);
  if (max > 0 && todayList.length >= max) {
    return { ok: false, code: 'cap', reason: '今天在小镇已经动过 ' + todayList.length + ' 次了（上限 ' + max + ' 次）。今天先不动，看看别人、记一句就好。' };
  }
  const gapMs = Math.max(0, Number(minGapMin) || 0) * 60_000;
  const last = todayList[todayList.length - 1];
  if (gapMs > 0 && last) {
    const since = Number(now) - Number(last.at);
    if (Number.isFinite(since) && since < gapMs) {
      const left = Math.ceil((gapMs - since) / 60_000);
      return { ok: false, code: 'gap', reason: '刚在小镇动过（' + left + ' 分钟后再说）。这次先不做动作。' };
    }
  }
  return { ok: true };
}

/** 记一笔动作。返回新账本（不落盘）。 */
export function appendAction(state, entry, { today = '' } = {}) {
  const day = String(today || (state && state.date) || '');
  const base = state && String(state.date || '') === day ? state : emptyActionState(day);
  const list = Array.isArray(base.list) ? base.list.slice() : [];
  list.push({
    at: Number(entry && entry.at) || Date.now(),
    type: String((entry && entry.type) || ''),
    target: String((entry && entry.target) || '').slice(0, 60),
    ok: entry && entry.ok === false ? false : true,
    note: String((entry && entry.note) || '').slice(0, 120)
  });
  return { date: day, list };
}

/** 给提示词/面板用的一句话摘要。 */
export function summarizeActions(state, today = '') {
  const list = listActionsToday(state, today);
  if (!list.length) return '今天还没在小镇动过';
  const last = list[list.length - 1];
  const hh = new Date(Number(last.at)).toTimeString().slice(0, 5);
  return '今天动过 ' + list.length + ' 次（最近 ' + hh + ' ' + last.type + (last.target ? ' ' + last.target : '') + '）';
}
