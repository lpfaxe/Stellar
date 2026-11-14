/* 待办审批：非主人写动作的通过/拒绝。状态机在插件仓库的 src/approvals.js。 */
var apprState = { pending: [], items: [] };

function apprTime(ts) {
  if (!ts) return '—';
  var d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function apprWho(a) {
  var r = a.requester || {};
  var who = r.nickname || (r.userId ? 'QQ ' + r.userId : '') || a.key || '未知';
  if (r.groupName) who += '（' + r.groupName + '）';
  else if (r.groupId) who += '（群 ' + r.groupId + '）';
  return who;
}

function apprLeft(a) {
  var s = Number(a.secondsLeft) || 0;
  if (s <= 0) return '已过期';
  if (s < 60) return s + ' 秒后作废';
  return Math.round(s / 60) + ' 分钟后作废';
}

function apprButton(label, cls, onclick) {
  var b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

function renderApprovals(data) {
  var box = el('apprList');
  if (!box) return;
  var pending = (data && data.pending) || [];
  var items = (data && data.items) || [];
  apprState.pending = pending;
  apprState.items = items;
  if (el('apprHint')) {
    var n = Number(data && data.stats && data.stats.pending) || pending.length;
    el('apprHint').textContent = n ? n + ' 条等你点头' : '没有人等她发东西';
  }
  box.textContent = '';
  if (!pending.length) {
    var empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = '没有待批的事。';
    box.appendChild(empty);
  }
  pending.forEach(function (a) {
    var row = document.createElement('div');
    row.className = 'appr-row';
    var head = document.createElement('div');
    head.className = 'appr-head';
    var title = document.createElement('b');
    title.textContent = a.actionLabel || a.action;
    var id = document.createElement('code');
    id.textContent = a.requestId;
    head.appendChild(title);
    head.appendChild(id);
    row.appendChild(head);

    var who = document.createElement('div');
    who.className = 'appr-who';
    who.textContent = '谁：' + apprWho(a);
    row.appendChild(who);

    var summary = document.createElement('div');
    summary.className = 'appr-summary';
    summary.textContent = a.summary || '';
    row.appendChild(summary);

    var meta = document.createElement('div');
    meta.className = 'appr-meta';
    meta.textContent = (a.estimatedCost ? '预计 ' + a.estimatedCost + ' · ' : '') + apprLeft(a) + ' · ' + apprTime(a.createdAt);
    row.appendChild(meta);

    if (a.args) {
      var det = document.createElement('details');
      det.className = 'appr-args';
      var sm = document.createElement('summary');
      sm.textContent = '参数快照（不可改）';
      var pre = document.createElement('pre');
      pre.textContent = JSON.stringify(a.args, null, 2);
      det.appendChild(sm);
      det.appendChild(pre);
      row.appendChild(det);
    }

    var actions = document.createElement('div');
    actions.className = 'row wrap';
    actions.appendChild(apprButton('通过', 'primary', function () { approvalAction(a.requestId, 'approve', actions); }));
    actions.appendChild(apprButton('拒绝', 'ghost', function () { approvalAction(a.requestId, 'reject', actions); }));
    row.appendChild(actions);
    box.appendChild(row);
  });

  var done = el('apprDone');
  if (done) {
    done.textContent = '';
    var past = items.filter(function (a) { return a.status !== 'pending'; }).slice(0, 12);
    if (!past.length) {
      var e2 = document.createElement('span');
      e2.className = 'muted';
      e2.textContent = '还没有处理记录。';
      done.appendChild(e2);
    }
    past.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'appr-row done';
      var head = document.createElement('div');
      head.className = 'appr-head';
      var t = document.createElement('span');
      t.textContent = (a.actionLabel || a.action) + ' · ' + apprWho(a);
      var st = document.createElement('b');
      st.className = 'appr-status ' + a.status;
      st.textContent = a.statusLabel || a.status;
      head.appendChild(t);
      head.appendChild(st);
      row.appendChild(head);
      var s = document.createElement('div');
      s.className = 'appr-summary';
      s.textContent = a.summary || '';
      row.appendChild(s);
      var m = document.createElement('div');
      m.className = 'appr-meta';
      m.textContent = apprTime(a.executedAt || a.approvedAt || a.createdAt) + (a.error ? ' · ' + a.error : '');
      row.appendChild(m);
      done.appendChild(row);
    });
  }
}

function loadApprovals() {
  return api('/api/approvals?limit=40').then(function (d) {
    renderApprovals(d);
    return d;
  }).catch(function (e) {
    if (el('apprMsg')) setMsg(el('apprMsg'), e.message || String(e), false);
  });
}

function approvalAction(id, action, actionsNode) {
  if (actionsNode) {
    Array.prototype.forEach.call(actionsNode.querySelectorAll('button'), function (b) { b.disabled = true; });
  }
  setMsg(el('apprMsg'), action === 'approve' ? '正在通过…' : '正在拒绝…', true);
  api('/api/approvals/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: id, action: action }),
    timeoutMs: 25000
  }).then(function (r) {
    setMsg(el('apprMsg'), r.message || '处理好了', true);
    return loadApprovals();
  }).catch(function (e) {
    setMsg(el('apprMsg'), e.message || String(e), false);
    if (actionsNode) {
      Array.prototype.forEach.call(actionsNode.querySelectorAll('button'), function (b) { b.disabled = false; });
    }
  });
}

if (el('apprRefresh')) el('apprRefresh').onclick = function () {
  setMsg(el('apprMsg'), '刷新中…', null);
  loadApprovals().then(function () { setMsg(el('apprMsg'), '', null); });
};
