/* // 通讯录：谁在跟她说话 · 备注 / 类型 / 关系，保存后桥接下一句话生效 */
var CT = { people: [], groups: [], allowPrivate: [], ownerQQ: null, canWrite: true, loaded: false };

function ctAvatar(src) {
  var img = document.createElement('img');
  img.className = 'ct-avatar';
  img.loading = 'lazy';
  img.src = src || '';
  img.alt = '';
  img.onerror = function () { img.style.visibility = 'hidden'; };
  return img;
}

function ctField(label, value, max, onInput, disabled, cls) {
  var wrap = document.createElement('label');
  wrap.className = 'ct-field' + (cls ? ' ' + cls : '');
  var span = document.createElement('span');
  span.textContent = label;
  var input = document.createElement('input');
  input.value = value || '';
  input.maxLength = max;
  input.disabled = !!disabled;
  input.oninput = function () { onInput(input.value); };
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}

function ctSelect(value, onChange, disabled) {
  var sel = document.createElement('select');
  sel.disabled = !!disabled;
  [['owner', '主人'], ['friend', '朋友'], ['stranger', '陌生人'], ['group', '群']].forEach(function (pair) {
    var o = document.createElement('option');
    o.value = pair[0];
    o.textContent = pair[1];
    if (pair[0] === value) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = function () { onChange(sel.value); };
  return sel;
}

function renderContacts() {
  var box = el('ctPeople');
  var gbox = el('ctGroups');
  if (!box) return;
  box.textContent = '';
  var people = CT.people.slice().sort(function (a, b) {
    var rank = { owner: 0, friend: 1, stranger: 2 };
    return (rank[a.type] || 9) - (rank[b.type] || 9) || String(a.uin).localeCompare(String(b.uin));
  });
  if (!people.length) {
    box.appendChild(document.createTextNode('还没有好友档案。点「从 QQ 同步」拉一次。'));
  }
  people.forEach(function (p) {
    var row = document.createElement('div');
    row.className = 'ct-row' + (p.type === 'owner' ? ' owner' : '');
    var head = document.createElement('div');
    head.className = 'ct-head';
    head.appendChild(ctAvatar(p.avatar));
    var who = document.createElement('div');
    who.className = 'ct-who';
    var nm = document.createElement('b');
    nm.textContent = p.remark || p.nickname || '未命名';
    var qq = document.createElement('span');
    qq.className = 'muted';
    qq.textContent = p.uin + (p.nickname && p.remark ? ' · ' + p.nickname : '');
    who.appendChild(nm); who.appendChild(qq);
    head.appendChild(who);
    if (p.type === 'owner') {
      var tag = document.createElement('span');
      tag.className = 'ct-tag';
      tag.textContent = '主人';
      head.appendChild(tag);
    }
    row.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'ct-grid';
    grid.appendChild(ctField('备注', p.remark, 40, function (v) { p.remark = v; }, !CT.canWrite));
    grid.appendChild(ctField('关系', p.relation, 40, function (v) { p.relation = v; }, !CT.canWrite));
    var typeWrap = document.createElement('label');
    typeWrap.className = 'ct-field';
    var tl = document.createElement('span');
    tl.textContent = '类型';
    typeWrap.appendChild(tl);
    typeWrap.appendChild(ctSelect(p.type, function (v) { p.type = v; renderContacts(); }, !CT.canWrite || p.type === 'owner'));
    grid.appendChild(typeWrap);
    row.appendChild(grid);
    row.appendChild(ctField('补充（她会在提示词里看到）', p.relationNote, 200, function (v) { p.relationNote = v; }, !CT.canWrite, 'wide'));
    // 2026-11-11 主人要求：私聊白名单别再手填 QQ 号，直接从通讯录点
    if (p.type !== 'owner') {
      var allowed = CT.allowPrivate.indexOf(String(p.uin)) >= 0;
      var bar = document.createElement('div');
      bar.className = 'ct-allow';
      var tag = document.createElement('span');
      tag.className = 'ct-allow-state' + (allowed ? ' on' : '');
      tag.textContent = allowed ? '可以私聊她' : '不在私聊白名单';
      bar.appendChild(tag);
      var btn = document.createElement('button');
      btn.className = allowed ? 'ghost' : 'primary';
      btn.textContent = allowed ? '移出私聊白名单' : '加进私聊白名单';
      btn.disabled = !CT.canWrite;
      btn.onclick = function () { ctToggleAllow(p, allowed ? false : true, btn); };
      bar.appendChild(btn);
      row.appendChild(bar);
    }
    box.appendChild(row);
  });

  if (gbox) {
    gbox.textContent = '';
    if (!CT.groups.length) gbox.appendChild(document.createTextNode('还没有群档案（群列表为空）。'));
    CT.groups.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'ct-row';
      var head = document.createElement('div');
      head.className = 'ct-head';
      head.appendChild(ctAvatar(g.avatar));
      var who = document.createElement('div');
      who.className = 'ct-who';
      var nm = document.createElement('b');
      nm.textContent = g.name || '未命名群';
      var qq = document.createElement('span');
      qq.className = 'muted';
      qq.textContent = g.groupId + (g.memberCount ? ' · ' + g.memberCount + ' 人' : '');
      who.appendChild(nm); who.appendChild(qq);
      head.appendChild(who);
      row.appendChild(head);
      var grid = document.createElement('div');
      grid.className = 'ct-grid';
      grid.appendChild(ctField('备注', g.remark, 40, function (v) { g.remark = v; }, !CT.canWrite));
      grid.appendChild(ctField('关系', g.relation, 40, function (v) { g.relation = v; }, !CT.canWrite));
      row.appendChild(grid);
      row.appendChild(ctField('补充', g.relationNote, 200, function (v) { g.relationNote = v; }, !CT.canWrite, 'wide'));
      gbox.appendChild(row);
    });
    var cnt = el('ctGroupCount');
    if (cnt) cnt.textContent = CT.groups.length ? CT.groups.length + ' 个' : '';
  }
}

function ctToggleAllow(p, allow, btn) {
  if (!CT.canWrite) return setMsg(el('ctMsg'), '公网只能查看，改不了', false);
  var who = p.remark || p.nickname || p.uin;
  if (!allow && !confirm('真要把 ' + who + '（' + p.uin + '）移出私聊白名单？移出后她私聊里就不理这个人了。')) return;
  if (allow && !confirm('把 ' + who + '（' + p.uin + '）加进私聊白名单？加进去她就会回这个人的私聊。')) return;
  btn.disabled = true;
  setMsg(el('ctMsg'), '正在' + (allow ? '加进' : '移出') + '私聊白名单…');
  api('/api/contacts/allow', { method: 'POST', body: JSON.stringify({ uin: p.uin, allow: allow }) }).then(function (d) {
    CT.allowPrivate = (d.allowPrivate || []).map(String);
    if (d.type) p.type = d.type;
    renderContacts();
    var warn = (d.bridgeWarnings || []).length ? '（桥接提示：' + d.bridgeWarnings.join('；') + '）' : '';
    setMsg(el('ctMsg'), (d.changed ? (allow ? '已加进私聊白名单：' : '已移出私聊白名单：') : '本来就是这么设的：') + p.uin + warn, true);
  }).catch(function (e) {
    btn.disabled = false;
    setMsg(el('ctMsg'), e.message, false);
  });
}

function loadContacts() {
  return api('/api/contacts').then(function (d) {
    CT.people = d.people || [];
    CT.groups = d.groups || [];
    CT.allowPrivate = (d.allowPrivate || []).map(String);
    CT.ownerQQ = d.ownerQQ || null;
    CT.canWrite = d.canWrite !== false;
    CT.loaded = true;
    if (el('ctScope')) el('ctScope').textContent = CT.canWrite ? '本机/局域网：可编辑' : '公网只读：只能看';
    var save = el('ctSave'); if (save) save.disabled = !CT.canWrite;
    if (typeof MEM_EDIT !== 'undefined') MEM_EDIT.canWrite = CT.canWrite;
    if (el('memAdd')) el('memAdd').disabled = !CT.canWrite;
    document.querySelectorAll('.mem-row button').forEach(function (b) { b.disabled = !CT.canWrite; });
    var sync = el('ctSync'); if (sync) sync.disabled = !CT.canWrite;
    renderContacts();
    if (el('ctMsg')) setMsg(el('ctMsg'), '已载入 ' + CT.people.length + ' 人 · ' + CT.groups.length + ' 群', true);
    return d;
  }).catch(function (e) {
    if (el('ctPeople')) el('ctPeople').textContent = '读取失败：' + e.message;
    if (el('ctMsg')) setMsg(el('ctMsg'), e.message, false);
  });
}

if (el('ctSync')) el('ctSync').onclick = function () {
  if (!CT.canWrite) return;
  setMsg(el('ctMsg'), '正在从 OneBot 拉好友/群…');
  api('/api/contacts/sync', { method: 'POST', body: '{}', timeoutMs: 30000 }).then(function (d) {
    CT.people = d.people || [];
    CT.groups = d.groups || [];
    if (d.allowPrivate) CT.allowPrivate = d.allowPrivate.map(String);
    renderContacts();
    setMsg(el('ctMsg'), '同步好了：' + CT.people.length + ' 人 · ' + CT.groups.length + ' 群', true);
  }).catch(function (e) { setMsg(el('ctMsg'), e.message, false); });
};

if (el('ctSave')) el('ctSave').onclick = function () {
  if (!CT.canWrite) return setMsg(el('ctMsg'), '公网只能查看，改不了', false);
  var people = CT.people.map(function (p) {
    return { uin: p.uin, remark: p.remark, relation: p.relation, relationNote: p.relationNote, type: p.type };
  });
  var groups = CT.groups.map(function (g) {
    return { groupId: g.groupId, remark: g.remark, relation: g.relation, relationNote: g.relationNote };
  });
  if (!confirm('确定保存通讯录改动？保存后她下一句话就会按新备注认人。')) return;
  setMsg(el('ctMsg'), '保存中…');
  api('/api/contacts', { method: 'POST', body: JSON.stringify({ people: people, groups: groups }) }).then(function (d) {
    setMsg(el('ctMsg'), '已保存' + (d.count ? '（' + d.count + ' 项改动）' : '（没有变化）'), true);
    return loadContacts();
  }).catch(function (e) { setMsg(el('ctMsg'), e.message, false); });
};