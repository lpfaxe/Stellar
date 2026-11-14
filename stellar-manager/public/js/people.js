/* 谁能跟她说上话：白名单 / 黑名单编辑 + 最近拦截审计 */
var acState = { ownerQQ: null };

function acParse(text) {
  return String(text || '').split(/[\s,，、;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function acFill(node, list) {
  if (!node) return;
  node.value = (list || []).join('\n');
}

function acTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

var AC_REASON = {
  'deny.users': '拒绝名单（人）',
  'deny.private': '私聊黑名单',
  'deny.groups': '群黑名单',
  'not-allowlisted': '不在白名单'
};

function renderBlocked(list) {
  var box = el('acBlocked');
  if (!box) return;
  box.textContent = '';
  if (!list || !list.length) {
    var empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = '最近没有拦截记录。';
    box.appendChild(empty);
    return;
  }
  list.forEach(function (b) {
    var row = document.createElement('div');
    row.className = 'blocked-row';
    var when = document.createElement('span');
    when.className = 'blocked-when';
    when.textContent = acTime(b.at);
    var who = document.createElement('span');
    who.className = 'blocked-who';
    who.textContent = (b.userId ? 'QQ ' + b.userId : '未知发送者') + (b.key ? ' · ' + b.key : '');
    var why = document.createElement('span');
    why.className = 'blocked-why';
    why.textContent = AC_REASON[b.reason] || b.reason;
    row.appendChild(when);
    row.appendChild(who);
    row.appendChild(why);
    box.appendChild(row);
  });
}

function renderAccessForm(a) {
  acState.ownerQQ = a.ownerQQ || null;
  if (el('acOwner')) el('acOwner').textContent = a.ownerQQ || '未设置';
  acFill(el('acAllowPrivate'), a.allow && a.allow.private);
  acFill(el('acAllowGroups'), a.allow && a.allow.groups);
  acFill(el('acDenyUsers'), a.deny && a.deny.users);
  acFill(el('acDenyPrivate'), a.deny && a.deny.private);
  acFill(el('acDenyGroups'), a.deny && a.deny.groups);
  if (el('acBridge')) {
    el('acBridge').textContent = a.bridgeOnline === false ? '桥接没在跑，保存会失败' : '桥接在线，保存即生效';
  }
  renderBlocked(a.blocked);
}

function loadAccess() {
  return api('/api/access').then(function (a) {
    if (a && a.ok !== false) renderAccessForm(a);
  }).catch(function (e) {
    setMsg(el('acMsg'), '读取失败：' + e.message, false);
  });
}

if (el('acReload')) el('acReload').onclick = function () { setMsg(el('acMsg'), ''); loadAccess(); };

if (el('acSave')) el('acSave').onclick = function () {
  var btn = this;
  var payload = {
    ownerQQ: acState.ownerQQ,
    allow: { private: acParse(el('acAllowPrivate').value), groups: acParse(el('acAllowGroups').value) },
    deny: { users: acParse(el('acDenyUsers').value), private: acParse(el('acDenyPrivate').value), groups: acParse(el('acDenyGroups').value) }
  };
  btn.disabled = true;
  setMsg(el('acMsg'), '保存中…');
  api('/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 25000 })
    .then(function (r) {
      setMsg(el('acMsg'), '已保存（桥接已热更新）' + (r.warnings && r.warnings.length ? '：' + r.warnings.join('；') : ''), true);
      if (r && r.allow) renderAccessForm(r);
      if (r && r.ownerQQ) acState.ownerQQ = r.ownerQQ;
    })
    .catch(function (e) { setMsg(el('acMsg'), '没保存：' + e.message, false); })
    .finally(function () { btn.disabled = false; });
};

loadAccess();
