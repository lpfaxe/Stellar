/**
 * 这一条依赖 stellar-manager（控制台，端口 3300）的源码做源码级断言。
 * 公开仓库**不发布**控制台目录，所以这里先探测：缺了就跳过（打印原因并以 0 退出），
 * 有就照常跑。真实仓库里 stellar-manager 与 stellar 同级，6 条断言全部生效。
 */
import fsProbe from 'node:fs';
import pathProbe from 'node:path';
import { fileURLToPath as urlProbe } from 'node:url';
const scriptsDir = pathProbe.dirname(urlProbe(import.meta.url));
// 控制台源码的两个候选位置：仓库自己那份（发布仓库里是最小控制台，没有 lib/auth.js），
// 以及「stellar 与 stellar-manager 同级」的完整部署布局。先看前者，避免发布仓库里
// 因为机器上碰巧存在 ../stellar-manager 就把断言跑到别人家的目录上。
const repoRoot = pathProbe.resolve(scriptsDir, '..');
// 先认**本仓库自己的** stellar-manager（存在就用它，不管里面是完整面板还是最小控制台），
// 只有本仓库里根本没有这个目录时，才回退到「stellar 与 stellar-manager 同级」的完整部署布局。
// 这样发布仓库不会因为开发机上碰巧有 ../stellar-manager 就把断言跑到别人的目录里。
const ownManager = pathProbe.join(repoRoot, 'stellar-manager');
const siblingManager = pathProbe.resolve(repoRoot, '..', 'stellar-manager');
const panelRoot = (() => {
  try { if (fsProbe.statSync(ownManager).isDirectory()) return ownManager; } catch {}
  return siblingManager;
})();
// 公开仓库里 stellar-manager 只是一个空占位（仅 README.md），所以判定的是「有没有控制台源码」：
// server.mjs 与 lib/auth.js 是这批断言真正要读的两个文件，缺一个就跳过。
const panelSrc = (() => {
  try {
    return fsProbe.existsSync(pathProbe.join(panelRoot, 'server.mjs'))
      && fsProbe.existsSync(pathProbe.join(panelRoot, 'lib', 'auth.js'));
  } catch { return false; }
})();
if (!panelSrc) {
  console.log('SKIP 待办提醒对象：仓库自带的 stellar-manager 是最小控制台（只有 server.mjs，没有 lib/auth.js）；这条断言的是完整面板，只在完整部署里跑');
  process.exit(0);
}
/**
 * 待办「提醒谁」回归：targetKey/targetName 优先，其次会话 key，最后 requester；
 * 控制台代加/代删只写 fixture，不碰真实 todos.json。
 *
 * 跑法：node scripts/test-todo-target.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-todos-'));
// 两个模块各自读 env：stellar/src/todos.js 看 DSH_HOME，面板 lib/todos.js 看 STELLAR_DATA_DIR（缺省退回 DSH_HOME/stellar）
process.env.DSH_HOME = root;
process.env.STELLAR_DATA_DIR = path.join(root, 'stellar');

const src = await import('../src/todos.js');
const panel = await import('../../stellar-manager/lib/todos.js');

test.after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('todoTarget：显式 targetKey 优先，其次会话 key，最后 requester', () => {
  assert.deepEqual(src.todoTarget({ targetKey: 'private:1000000003', targetName: '示例好友', key: 'private:1000000001' }),
    { key: 'private:1000000003', name: '示例好友' });
  assert.deepEqual(src.todoTarget({ key: 'group:123456', requester: { nickname: '群里的人' } }),
    { key: 'group:123456', name: '群里的人' });
  assert.deepEqual(src.todoTarget({ requester: { userId: '1000000005' } }),
    { key: 'private:1000000005', name: 'QQ 1000000005' });
  assert.deepEqual(src.todoTarget({}), { key: '', name: '' });
});

test('addTodo 把 targetKey/targetName 落盘，formatTodo 显示提醒对象', () => {
  const r = src.addTodo({ text: '提醒她带伞', dueAt: Date.now() + 60000, createdBy: 'panel', targetKey: 'private:1000000003', targetName: '示例好友' });
  assert.ok(r && r.id);
  const row = src.getTodo(r.id);
  assert.equal(row.targetKey, 'private:1000000003');
  assert.equal(row.targetName, '示例好友');
  assert.match(src.formatTodo(row), /提醒 示例好友/);
});

test('面板代加：校验失败抛错（server 转 400），正常条目进列表并保留目标', () => {
  // 面板这层用 throw 表达拒绝，server.mjs 的 /api/todo-add 把它转成 400 + message
  assert.throws(() => panel.addTodoFromPanel({ text: '', dueAt: Date.now() + 60000 }), /要写清楚提醒什么事/);
  assert.throws(() => panel.addTodoFromPanel({ text: '没有时间' }), /要选一个提醒时间/);
  // 目标 key 不在白名单时直接拒绝（别把任意 URL 当成投递目标，也别静默改成别人）
  assert.throws(() => panel.addTodoFromPanel({ text: '坏目标', dueAt: Date.now() + 60000, targetKey: 'http://evil.example.com' }), /private:<QQ 号>|group:<群号>/);
  // 不填目标 = 让记这件事的人，合法
  const plain = panel.addTodoFromPanel({ text: '不指定对象', dueAt: Date.now() + 60000 });
  assert.equal(plain.targetKey, '');
  const good = panel.addTodoFromPanel({ text: '面板加的提醒', dueAt: Date.now() + 3600000, targetKey: 'group:123456', targetName: '班级群' });
  assert.equal(good.targetKey, 'group:123456');
  // 展示用的 norm 不带 createdBy，但原始条目必须留着（面板不认识的字段不能洗掉）
  const rawFile = JSON.parse(fs.readFileSync(src.TODOS_FILE, 'utf8'));
  const rawRow = rawFile.items.find((x) => x.id === good.id);
  assert.equal(rawRow.createdBy, 'panel');
  const list = panel.readTodos();
  assert.ok(list.items.some((x) => x.id === good.id && x.targetKey === 'group:123456'));
});

test('面板代删：删得掉已有条目，删不存在的抛错', () => {
  const added = panel.addTodoFromPanel({ text: '待删条目', dueAt: Date.now() + 7200000 });
  assert.ok(added.id);
  const gone = panel.removeTodoFromPanel(added.id);
  assert.equal(gone.id, added.id);
  assert.ok(!PanelListHas(added.id), '删掉之后不该还在列表里');
  assert.throws(() => panel.removeTodoFromPanel(added.id), /没找到这条待办/);
  assert.throws(() => panel.removeTodoFromPanel(''), /缺 id/);
});

test('面板写入保留它不认识的字段（别把 MCP 写的 requester 洗掉）', () => {
  const seeded = src.addTodo({ text: '外部字段', dueAt: Date.now() + 9000000, key: 'private:1000000001', requester: { userId: '1000000001', nickname: '主人' } });
  const list = panel.readTodos();
  const hit = list.items.find((x) => x.id === seeded.id);
  assert.ok(hit);
  assert.equal(hit.requester && hit.requester.nickname, '主人');
  assert.equal(hit.key, 'private:1000000001');
});

function PanelListHas(id) {
  return panel.readTodos().items.some((x) => x.id === id);
}
