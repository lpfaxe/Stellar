/* // 停 / 唤醒 / 以主人身份传话 */
var TASK = { canWrite: true, paused: false, loaded: false };

function renderTask(t) {
  TASK.canWrite = t.canWrite !== false;
  TASK.paused = t.paused === true;
  var pillNode = el('taskState');
  if (pillNode) {
    pillNode.textContent = t.paused === true ? '已休眠（自动唤醒已停）' : (t.paused === false ? '运行中（到点会自己醒）' : '读不到桥接状态');
    pillNode.className = 'pill' + (t.paused === true ? ' off' : '');
  }
  var note = el('taskMsg');
  if (note) note.textContent = t.bridgeOk === false ? ('桥接没连上：' + (t.message || '3100 不通')) : (t.canWrite ? '' : '公网只读：只能看，不能停/唤醒/传话');
  ['taskPause', 'taskResume', 'taskWake', 'taskSend'].forEach(function (id) {
    var b = el(id);
    if (b) b.disabled = !TASK.canWrite;
  });
}

function loadTask() {
  return api('/api/task').then(function (t) { renderTask(t); return t; })
    .catch(function (e) {
      if (el('taskState')) el('taskState').textContent = '读取失败';
      if (el('taskMsg')) setMsg(el('taskMsg'), e.message, false);
    });
}

function taskAction(action, text) {
  if (!TASK.canWrite) return setMsg(el('taskActMsg'), '公网只能看，不能操作', false);
  setMsg(el('taskActMsg'), '执行中…');
  return api('/api/task/action', { method: 'POST', body: JSON.stringify({ action: action, text: text || '' }), timeoutMs: 30000 })
    .then(function (r) {
      setMsg(el('taskActMsg'), ({ pause: '已强制休眠', resume: '已恢复运行', wake: '已叫醒她', command: '已送到她那里' })[action] || '完成', true);
      return loadTask();
    }).catch(function (e) { setMsg(el('taskActMsg'), e.message, false); });
}

if (el('taskPause')) el('taskPause').onclick = function () {
  if (confirm('强制休眠会停掉全部自动唤醒和等待，不会自己恢复（只有点「恢复运行」才解除）。确定？')) taskAction('pause');
};
if (el('taskResume')) el('taskResume').onclick = function () { taskAction('resume'); };
if (el('taskWake')) el('taskWake').onclick = function () { taskAction('wake'); };
if (el('taskSend')) el('taskSend').onclick = function () {
  var text = String(el('taskText').value || '').trim();
  if (!text) return setMsg(el('taskSendMsg'), '先写一句话', false);
  if (text.length > 1500) return setMsg(el('taskSendMsg'), '太长（最多 1500 字）', false);
  if (!confirm('以主人身份发给她：\n\n' + text.slice(0, 300) + (text.length > 300 ? '…' : '') + '\n\n确定？')) return;
  setMsg(el('taskSendMsg'), '发送中…');
  api('/api/task/action', { method: 'POST', body: JSON.stringify({ action: 'command', text: text }), timeoutMs: 30000 })
    .then(function () {
      setMsg(el('taskSendMsg'), '已送到她的会话，下一页就会处理', true);
      el('taskText').value = '';
    }).catch(function (e) { setMsg(el('taskSendMsg'), e.message, false); });
};
