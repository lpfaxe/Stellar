/* 她的事项：展示 todos.json（她那边用 todo 工具写），主人也能在这里代她加/删。 */
var TODO_STATE = { items: [], pending: 0, overdue: 0, nextAt: 0, canWrite: false };
var TODO_PEOPLE = { loaded: false, people: [], groups: [] };

function todoEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function todoWhen(ts) {
  if (!ts) return '未定时间';
  var d = new Date(ts);
  var now = new Date();
  var sameDay = d.toDateString() === now.toDateString();
  var time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return '今天 ' + time;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time;
}

// 「提醒谁」：targetKey/targetName 优先，其次委托人，都没有就是主人私聊。
function todoWho(it) {
  if (it.targetName) return it.targetName;
  if (it.targetKey) return it.targetKey;
  if (it.requester && (it.requester.nickname || it.requester.userId)) return it.requester.nickname || ('QQ ' + it.requester.userId);
  return '让记这件事的人';
}

function renderTodos(d) {
  TODO_STATE = d || TODO_STATE;
  var items = Array.isArray(d && d.items) ? d.items : [];
  var sum = el('todoSummary');
  if (sum) {
    var next = d && d.nextAt ? ' · 下一条 ' + todoWhen(d.nextAt) : '';
    sum.textContent = (d && d.pending ? d.pending + ' 条待办' : '没有待办') + (d && d.overdue ? ' · ' + d.overdue + ' 条过期' : '') + next;
  }
  var add = el('todoAddToggle');
  if (add) add.classList.toggle('hide', !(d && d.canWrite));
  var box = el('todoList');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<p class="muted">她还没有记下任何要提醒的事。</p>'; return; }
  box.innerHTML = items.map(function (it) {
    var late = it.status === 'pending' && it.dueAt && it.dueAt <= Date.now();
    var who = todoWho(it);
    var st = it.status === 'done' ? '已完成' : it.status === 'cancelled' ? '已取消' : late ? '已过期' : '等待提醒';
    var del = d && d.canWrite && it.status === 'pending'
      ? '<button class="ghost small todo-del" data-id="' + todoEsc(it.id) + '">删除</button>'
      : '';
    return '<div class="todo-item ' + (it.status === 'done' ? 'done ' : '') + (late ? 'late' : '') + '">'
      + '<div class="todo-main"><b>' + todoEsc(it.text) + '</b>'
      + '<span class="todo-meta">' + todoWhen(it.dueAt) + ' · 提醒 ' + todoEsc(who) + '</span></div>'
      + '<span class="todo-tag">' + st + '</span>' + del + '</div>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('.todo-del'), function (b) {
    b.addEventListener('click', function () { deleteTodo(b.getAttribute('data-id')); });
  });
}

function loadTodoPeople() {
  if (TODO_PEOPLE.loaded) return Promise.resolve(TODO_PEOPLE);
  return api('/api/contacts').then(function (d) {
    TODO_PEOPLE.people = (d && d.people) || [];
    TODO_PEOPLE.groups = (d && d.groups) || [];
    TODO_PEOPLE.loaded = true;
    fillTodoTargets();
    return TODO_PEOPLE;
  }).catch(function () { return TODO_PEOPLE; });
}

function fillTodoTargets() {
  var sel = el('tdTarget');
  if (!sel) return;
  var cur = sel.value;
  var out = [['', '让记这件事的人（默认）']];
  TODO_PEOPLE.people.forEach(function (p) { out.push(['private:' + String(p.uin), (p.name || p.nickname || p.uin) + ' · 私聊']); });
  TODO_PEOPLE.groups.forEach(function (g) { out.push(['group:' + String(g.gid), (g.name || g.gid) + ' · 群']); });
  sel.innerHTML = out.map(function (o) { return '<option value="' + todoEsc(o[0]) + '">' + todoEsc(o[1]) + '</option>'; }).join('');
  if (cur) sel.value = cur;
}

function todoFormOpen(open) {
  var box = el('todoForm');
  if (!box) return;
  box.classList.toggle('hide', !open);
  if (open) {
    loadTodoPeople();
    var w = el('tdWhen');
    if (w && !w.value) {
      var t = new Date(Date.now() + 30 * 60 * 1000);
      t.setSeconds(0, 0);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      w.value = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + 'T' + pad(t.getHours()) + ':' + pad(t.getMinutes());
    }
    if (el('tdText')) el('tdText').focus();
  }
}

function addTodo() {
  var text = String((el('tdText') || {}).value || '').trim();
  var when = String((el('tdWhen') || {}).value || '').trim();
  var sel = el('tdTarget');
  if (!text) { setMsg(el('tdMsg'), '先写清楚提醒什么事', false); return; }
  if (!when) { setMsg(el('tdMsg'), '选一个提醒时间', false); return; }
  var due = new Date(when).getTime();
  if (!Number.isFinite(due)) { setMsg(el('tdMsg'), '时间没看懂', false); return; }
  var targetKey = sel ? sel.value : '';
  var targetName = '';
  if (sel && sel.selectedIndex >= 0) targetName = String(sel.options[sel.selectedIndex].textContent || '').replace(/ · (私聊|群)$/, '');
  var btn = el('tdSave');
  if (btn) btn.disabled = true;
  setMsg(el('tdMsg'), '正在加…', true);
  api('/api/todo-add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: text, dueAt: due, targetKey: targetKey, targetName: targetName })
  }).then(function (r) {
    setMsg(el('tdMsg'), '已加进她的事项：' + todoWhen(due), true);
    if (el('tdText')) el('tdText').value = '';
    renderTodos(r.todos || {});
    setTimeout(function () { todoFormOpen(false); }, 1200);
  }).catch(function (e) {
    setMsg(el('tdMsg'), '没加上：' + (e && e.message ? e.message : e), false);
  }).then(function () { if (btn) btn.disabled = false; });
}

function deleteTodo(id) {
  if (!id) return;
  if (!confirm('删掉这条待办？删了就不会再提醒了。')) return;
  setMsg(el('todoMsg'), '正在删…', true);
  api('/api/todo-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: id })
  }).then(function (r) {
    setMsg(el('todoMsg'), '已删除', true);
    renderTodos(r.todos || {});
  }).catch(function (e) {
    setMsg(el('todoMsg'), '删除失败：' + (e && e.message ? e.message : e), false);
  });
}

async function loadTodos() {
  try {
    var d = await api('/api/todos');
    renderTodos(d);
    return d;
  } catch (e) {
    var box = el('todoList');
    if (box) box.innerHTML = '<p class="muted">读取失败：' + todoEsc(e && e.message ? e.message : e) + '</p>';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (el('todoRefresh')) el('todoRefresh').addEventListener('click', loadTodos);
  if (el('todoAddToggle')) el('todoAddToggle').addEventListener('click', function () { todoFormOpen(el('todoForm') && el('todoForm').classList.contains('hide')); });
  if (el('tdCancel')) el('tdCancel').addEventListener('click', function () { todoFormOpen(false); });
  if (el('tdSave')) el('tdSave').addEventListener('click', addTodo);
  fillTodoTargets();
});
