/* // 她的发件箱：发给别人/群的消息 + 查岗审计 */
var OB = { target: '', items: [], total: 0, offset: 0, limit: 20, targets: [] };

function obWhen(v) {
  var ms = typeof v === 'number' ? v : Date.parse(v || '');
  if (!ms || isNaN(ms)) return '';
  return fmtTime(ms);
}

function obWho(e) {
  if (e.name) return e.name + (e.kind === 'group' ? '（群）' : '');
  return (e.kind === 'group' ? '群 ' : '私聊 ') + (e.target || '?');
}

function obLine(e) {
  var row = document.createElement('div');
  row.className = 'ob-item';
  var top = document.createElement('div');
  top.className = 'ob-top';
  var who = document.createElement('b');
  who.textContent = obWho(e);
  top.appendChild(who);
  if (e.name) {
    var tag = document.createElement('em');
    tag.className = 'ob-tag';
    tag.textContent = (e.kind === 'group' ? '群 ' : '') + (e.target || '');
    top.appendChild(tag);
  }
  var src = document.createElement('span');
  src.className = 'muted';
  src.textContent = obWhen(e.at) + (e.source ? ' · ' + e.source : '');
  top.appendChild(src);
  row.appendChild(top);
  var body = document.createElement('div');
  body.className = 'ob-text';
  body.textContent = e.text || (e.image ? '［图片］' : '（空消息）');
  if (e.image) {
    var img = document.createElement('div');
    img.className = 'muted ob-img';
    img.textContent = '图片：' + e.image;
    body.appendChild(img);
  }
  row.appendChild(body);
  return row;
}

function obTargetLabel(t) {
  return (t.name || t.target) + (t.kind === 'group' ? '（群 ' + t.target + '）' : ' · ' + t.target) + ' · ' + (t.count || 0) + ' 条';
}

function renderOutboxTargets() {
  var dl = el('obTargets');
  if (!dl) return;
  dl.textContent = '';
  OB.targets.forEach(function (t) {
    var op = document.createElement('option');
    op.value = t.target;
    op.label = obTargetLabel(t);
    dl.appendChild(op);
  });
}

function renderOutbox(d) {
  OB.items = d.items || [];
  OB.total = d.total || 0;
  if (Array.isArray(d.targets)) { OB.targets = d.targets; renderOutboxTargets(); }
  var box = el('obList');
  if (!box) return;
  box.textContent = '';
  if (!OB.items.length) {
    box.appendChild(document.createTextNode(OB.target ? ('没有发给 ' + OB.target + ' 的记录。') : '还没有发件记录。'));
  } else {
    OB.items.forEach(function (e) { box.appendChild(obLine(e)); });
  }
  var pages = Math.max(1, Math.ceil(OB.total / OB.limit));
  var page = Math.floor(OB.offset / OB.limit) + 1;
  if (el('obPage')) el('obPage').textContent = '第 ' + page + ' / ' + pages + ' 页 · 共 ' + OB.total + ' 条';
  if (el('obPrev')) el('obPrev').disabled = OB.offset <= 0;
  if (el('obNext')) el('obNext').disabled = OB.offset + OB.limit >= OB.total;

  var audit = el('obAudit');
  if (audit) {
    audit.textContent = '';
    var list = (d.audit || []).slice(0, 8);
    if (!list.length) audit.appendChild(document.createTextNode('还没有人在 QQ 里查过发件记录。'));
    list.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'ob-item ob-audit';
      var top = document.createElement('div');
      top.className = 'ob-top';
      var who = document.createElement('b');
      who.textContent = '查了 ' + (a.target || a.query || '全部');
      top.appendChild(who);
      var at = document.createElement('span');
      at.className = 'muted';
      at.textContent = (a.by || '') + ' · ' + obWhen(a.at);
      top.appendChild(at);
      row.appendChild(top);
      audit.appendChild(row);
    });
  }
}

function obResolveTarget(input) {
  var v = String(input || '').trim();
  if (!v) return '';
  if (/^\d{5,12}$/.test(v)) return v;
  var hit = OB.targets.filter(function (t) { return (t.name || '').indexOf(v) >= 0 || String(t.target).indexOf(v) === 0; })[0];
  return hit ? String(hit.target) : v;
}

function loadOutbox(reset) {
  if (reset) OB.offset = 0;
  var q = '?limit=' + OB.limit + '&offset=' + OB.offset;
  if (OB.target) q += '&target=' + encodeURIComponent(OB.target);
  return api('/api/outbox' + q).then(function (d) {
    renderOutbox(d);
    if (el('obMsg')) setMsg(el('obMsg'), '', true);
  }).catch(function (e) {
    if (el('obList')) el('obList').textContent = '读取失败：' + e.message;
    if (el('obMsg')) setMsg(el('obMsg'), e.message, false);
  });
}

if (el('obRefresh')) el('obRefresh').onclick = function () {
  OB.target = obResolveTarget(el('obTarget').value);
  loadOutbox(true);
};
if (el('obTarget')) el('obTarget').onkeydown = function (ev) {
  if (ev.key === 'Enter') { OB.target = obResolveTarget(this.value); loadOutbox(true); }
};
if (el('obPrev')) el('obPrev').onclick = function () {
  OB.offset = Math.max(0, OB.offset - OB.limit);
  loadOutbox();
};
if (el('obNext')) el('obNext').onclick = function () {
  if (OB.offset + OB.limit >= OB.total) return;
  OB.offset += OB.limit;
  loadOutbox();
};
if (el('obLimit')) el('obLimit').onchange = function () {
  OB.limit = Math.max(10, Math.min(200, Number(this.value) || 20));
  loadOutbox(true);
};
