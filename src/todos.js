/**
 * 她的待办事项：跨进程共享（MCP 工具写入、调度器读取、控制台展示）。
 * 状态文件：%USERPROFILE%\.dsh\stellar\state\todos.json
 *
 * 一条记录：
 *   { id, text, dueAt, createdAt, createdBy, requester, key, targetKey, targetName,
 *     status, remindedAt, reminderCount, doneAt, note }
 *
 * targetKey / targetName = 「到点提醒谁」。有它就按它投递（控制台加的待办靠这两个字段
 * 指定对象）；没有才退回 key（谁让它记的）→ requester.userId。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const TODOS_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'stellar', 'state', 'todos.json');

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
  } catch {}
  return [];
}

function writeRaw(items) {
  fs.mkdirSync(path.dirname(TODOS_FILE), { recursive: true });
  const tmp = TODOS_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, TODOS_FILE);
}

function normalize(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id || '').trim();
  const text = cleanText(row.text, 300);
  if (!id || !text) return null;
  return {
    id,
    text,
    dueAt: Math.max(0, Number(row.dueAt) || 0),
    createdAt: Math.max(0, Number(row.createdAt) || 0),
    createdBy: String(row.createdBy || ''),
    requester: row.requester && typeof row.requester === 'object' ? {
      userId: String(row.requester.userId || ''),
      nickname: cleanText(row.requester.nickname, 60),
      groupId: String(row.requester.groupId || ''),
      groupName: cleanText(row.requester.groupName, 80)
    } : {},
    key: String(row.key || ''),
    targetKey: cleanText(row.targetKey, 80),
    targetName: cleanText(row.targetName, 60),
    status: ['pending', 'done', 'cancelled'].includes(row.status) ? row.status : 'pending',
    remindedAt: Math.max(0, Number(row.remindedAt) || 0),
    reminderCount: Math.max(0, Number(row.reminderCount) || 0),
    doneAt: Math.max(0, Number(row.doneAt) || 0),
    note: cleanText(row.note, 300)
  };
}

export function listTodos({ includeDone = false, limit = 100 } = {}) {
  const items = readRaw().map(normalize).filter(Boolean)
    .filter((it) => includeDone || it.status === 'pending')
    .sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity) || a.createdAt - b.createdAt);
  return items.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

export function getTodo(id) {
  const key = String(id || '').trim();
  return listTodos({ includeDone: true, limit: 500 }).find((it) => it.id === key) || null;
}

export function addTodo({ text, dueAt, key = '', requester = {}, createdBy = '', note = '', targetKey = '', targetName = '' } = {}) {
  const clean = cleanText(text, 300);
  if (!clean) throw new Error('待办内容不能为空');
  const due = Number(dueAt);
  if (!Number.isFinite(due) || due <= 0) throw new Error('提醒时间无效');
  if (due > Date.now() + 370 * 24 * 3600 * 1000) throw new Error('提醒时间超过一年，先记近期的事');
  const items = readRaw().map(normalize).filter(Boolean);
  if (items.filter((it) => it.status === 'pending').length >= 200) throw new Error('待办太多了（上限 200 条），先清理');
  const row = normalize({
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: clean,
    dueAt: due,
    createdAt: Date.now(),
    createdBy: String(createdBy || ''),
    requester,
    key: String(key || ''),
    targetKey: String(targetKey || ''),
    targetName: String(targetName || ''),
    status: 'pending',
    note: cleanText(note, 300)
  });
  items.push(row);
  writeRaw(items);
  return row;
}

export function updateTodo(id, patch = {}) {
  const key = String(id || '').trim();
  const items = readRaw().map(normalize).filter(Boolean);
  const idx = items.findIndex((it) => it.id === key);
  if (idx < 0) throw new Error('找不到这条待办：' + key);
  const cur = items[idx];
  const next = normalize({ ...cur, ...patch, id: cur.id });
  if (patch.status === 'done' && !next.doneAt) next.doneAt = Date.now();
  items[idx] = next;
  writeRaw(items);
  return next;
}

export function markReminded(id, at = Date.now()) {
  const cur = getTodo(id);
  if (!cur) return null;
  return updateTodo(id, {
    remindedAt: at,
    reminderCount: Math.min(9, (Number(cur.reminderCount) || 0) + 1)
  });
}

/** 到点且需要提醒的待办；同一轮只取最早的一条，避免一次叫醒塞满。 */
export function dueTodos(now = Date.now(), { gapMs = 10 * 60_000 } = {}) {
  return listTodos({ includeDone: false, limit: 500 })
    .filter((it) => it.dueAt > 0 && it.dueAt <= now)
    .filter((it) => !it.remindedAt || now - it.remindedAt >= gapMs)
    .filter((it) => (Number(it.reminderCount) || 0) < 6);
}

/** 自然语言时间：支持 ISO / YYYY-MM-DD HH:mm / 带“后天/明天/今天 HH:mm”的短句。 */
export function parseDueAt(input, now = Date.now()) {
  const raw = String(input ?? '').trim();
  if (!raw) return 0;
  const direct = new Date(raw);
  if (Number.isFinite(direct.getTime()) && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(raw)) return direct.getTime();
  const rel = raw.match(/(今天|明天|后天|大后天)?\s*(?:(上午|下午|晚上|中午|凌晨)\s*)?(\d{1,2})[:：点](\d{1,2})?/);
  if (!rel) {
    // 相对时间：「20 分钟后」「2 小时后」「3 天后」——控制台与侧边栏都用这种人话写法。
    const after = raw.match(/^(\d{1,4})\s*(分钟|分|小时|钟头|天)\s*(?:后|以后|之后)$/);
    if (!after) return 0;
    const n = Number(after[1]);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const unit = after[2];
    const unitMs = unit === '天' ? 86_400_000 : (unit === '小时' || unit === '钟头') ? 3_600_000 : 60_000;
    return now + n * unitMs;
  }
  const dayOffset = rel[1] === '明天' ? 1 : rel[1] === '后天' ? 2 : rel[1] === '大后天' ? 3 : 0;
  let hour = Number(rel[3]);
  const minute = Number(rel[4] || 0);
  const period = rel[2] || '';
  if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
  if (period === '中午' && hour < 11) hour += 12;
  if (period === '凌晨' && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || hour > 23 || !Number.isFinite(minute) || minute > 59) return 0;
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

export function formatTodo(row) {
  if (!row) return '';
  const when = row.dueAt ? new Date(row.dueAt).toLocaleString('zh-CN', { hour12: false }) : '未定时间';
  const to = todoTarget(row);
  return '#' + row.id + ' ' + (row.status === 'pending' ? '待办' : row.status === 'done' ? '已完成' : '已取消') + ' · ' + when + (to.key ? ' · 提醒 ' + (to.name || to.key) : '') + '\n' + row.text;
}

/** 到点该提醒谁：targetKey/targetName 优先，其次回头看这条是谁让记的。 */
export function todoTarget(row) {
  if (!row) return { key: '', name: '' };
  const key = String(row.targetKey || row.key || (row.requester?.userId ? 'private:' + row.requester.userId : '') || '');
  const name = String(row.targetName || row.requester?.nickname || (row.requester?.userId ? 'QQ ' + row.requester.userId : '') || '');
  return { key, name };
}
