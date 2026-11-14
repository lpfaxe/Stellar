/**
 * 「去问主人」队列。
 * 非主人会话里遇到只有主人能回答的问题时，她调用 stellar_ask_owner 建一条记录；
 * 桥接每 15 秒扫一次并私聊主人，主人回「回答 <id> <答案>」后：
 *   ① 标记 answered；② 把答案唤回原会话，让她按主人的答案回复。
 * 状态文件：%USERPROFILE%\.dsh\stellar\state\owner-questions.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const QUESTIONS_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'stellar', 'state', 'owner-questions.json');
const TTL_MS = 12 * 3600 * 1000;

function clean(value, max = 500) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
  } catch {}
  return [];
}

function writeAll(items) {
  fs.mkdirSync(path.dirname(QUESTIONS_FILE), { recursive: true });
  const tmp = QUESTIONS_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, QUESTIONS_FILE);
}

function normalize(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id || '').trim();
  const question = clean(row.question, 300);
  if (!id || !question) return null;
  const createdAt = Math.max(0, Number(row.createdAt) || 0);
  return {
    id,
    key: String(row.key || ''),
    question,
    context: clean(row.context, 300),
    requester: row.requester && typeof row.requester === 'object' ? {
      userId: String(row.requester.userId || ''),
      nickname: clean(row.requester.nickname, 60),
      groupId: String(row.requester.groupId || ''),
      groupName: clean(row.requester.groupName, 80)
    } : {},
    status: ['pending', 'answered', 'expired', 'cancelled'].includes(row.status) ? row.status : 'pending',
    createdAt,
    expiresAt: Math.max(0, Number(row.expiresAt) || (createdAt + TTL_MS)),
    notifiedAt: Math.max(0, Number(row.notifiedAt) || 0),
    answeredAt: Math.max(0, Number(row.answeredAt) || 0),
    answer: clean(row.answer, 500)
  };
}

export function listQuestions({ status = '', limit = 100 } = {}) {
  const now = Date.now();
  const items = readAll().map(normalize).filter(Boolean).map((it) => {
    if (it.status === 'pending' && it.expiresAt > 0 && now >= it.expiresAt) return { ...it, status: 'expired' };
    return it;
  });
  return items
    .filter((it) => !status || it.status === status)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

export function getQuestion(id) {
  const key = String(id || '').trim();
  return listQuestions({ limit: 500 }).find((it) => it.id === key) || null;
}

export function createQuestion({ key, question, context = '', requester = {} } = {}) {
  const cleanQuestion = clean(question, 300);
  if (!cleanQuestion) throw new Error('问题不能为空');
  const k = String(key || '').trim();
  if (!k) throw new Error('缺少会话 key');
  const items = readAll().map(normalize).filter(Boolean);
  const now = Date.now();
  const today = new Date(now).toDateString();
  const sameDay = items.filter((it) => new Date(it.createdAt).toDateString() === today);
  if (sameDay.length >= 12) throw new Error('今天问主人的次数太多了（上限 12 条），先自己处理');
  const pendingSameKey = items.filter((it) => it.status === 'pending' && it.key === k);
  if (pendingSameKey.length >= 2) throw new Error('这个会话已经有两条在等主人回答，先别重复问');
  const row = normalize({
    id: 'q' + now.toString(36) + Math.random().toString(36).slice(2, 5),
    key: k,
    question: cleanQuestion,
    context: clean(context, 300),
    requester,
    status: 'pending',
    createdAt: now,
    expiresAt: now + TTL_MS
  });
  items.push(row);
  writeAll(items);
  return row;
}

export function markNotified(id, at = Date.now()) {
  const items = readAll().map(normalize).filter(Boolean);
  const idx = items.findIndex((it) => it.id === String(id));
  if (idx < 0) return null;
  items[idx].notifiedAt = at;
  writeAll(items);
  return items[idx];
}

export function answerQuestion(id, answer, at = Date.now()) {
  const items = readAll().map(normalize).filter(Boolean);
  const idx = items.findIndex((it) => it.id === String(id));
  if (idx < 0) throw new Error('找不到这条提问：' + id);
  if (items[idx].status !== 'pending') throw new Error('这条提问已经是 ' + items[idx].status + ' 状态');
  items[idx].status = 'answered';
  items[idx].answer = clean(answer, 500);
  items[idx].answeredAt = at;
  writeAll(items);
  return items[idx];
}

export function cancelQuestion(id, at = Date.now()) {
  const items = readAll().map(normalize).filter(Boolean);
  const idx = items.findIndex((it) => it.id === String(id));
  if (idx < 0) return null;
  if (items[idx].status === 'pending') {
    items[idx].status = 'cancelled';
    items[idx].answeredAt = at;
    writeAll(items);
  }
  return items[idx];
}

export function pruneQuestions({ keepDays = 7 } = {}) {
  const before = Date.now() - Math.max(1, keepDays) * 24 * 3600 * 1000;
  const items = readAll().map(normalize).filter(Boolean).filter((it) => it.createdAt >= before);
  writeAll(items);
  return items.length;
}
