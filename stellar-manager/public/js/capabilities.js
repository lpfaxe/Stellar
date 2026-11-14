/* // 她的能力：按组渲染真实开关，保存写 bili.config.json */
var CAP = { groups: [], mtime: 0, canWrite: true };

function capEl(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderCapabilities() {
  var box = el('capGroups');
  if (!box) return;
  box.textContent = '';
  if (!CAP.groups.length) {
    box.appendChild(capEl('span', 'muted', '还没有读到能力表，点「重新读取」试试。'));
    return;
  }
  CAP.groups.forEach(function (group) {
    var g = capEl('div', 'cap-group');
    g.appendChild(capEl('h3', 'cap-group-title', group.name));
    var list = capEl('div', 'switches');
    group.items.forEach(function (item) {
      var row = capEl('label', 'switch cap-row');
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = item.enabled !== false;
      input.setAttribute('data-cap', item.id);
      input.disabled = !CAP.canWrite;
      var body = capEl('span', 'cap-body');
      body.appendChild(capEl('b', 'cap-name', item.name));
      body.appendChild(capEl('small', 'cap-desc', item.desc || ''));
      if (item.effect) body.appendChild(capEl('small', 'cap-effect', item.effect));
      row.appendChild(input);
      row.appendChild(body);
      list.appendChild(row);
    });
    g.appendChild(list);
    box.appendChild(g);
  });
}

function loadCapabilities() {
  return api('/api/capabilities').then(function (r) {
    CAP.groups = r.groups || [];
    CAP.mtime = r.mtime || 0;
    CAP.canWrite = r.canWrite !== false;
    renderCapabilities();
    var ro = el('capReadonly');
    if (ro) ro.textContent = CAP.canWrite ? '' : '公网访问只能查看，改开关请在这台电脑或同一 WiFi 下操作。';
    return r;
  }).catch(function (e) {
    var box = el('capGroups');
    if (box) { box.textContent = ''; box.appendChild(capEl('span', 'msg bad', '读取失败：' + e.message)); }
    throw e;
  });
}

function saveCapabilities() {
  var updates = {};
  document.querySelectorAll('#capGroups input[data-cap]').forEach(function (input) {
    updates[input.getAttribute('data-cap')] = input.checked;
  });
  if (!Object.keys(updates).length) { setMsg(el('capMsg'), '没有读到开关，先刷新', false); return; }
  setMsg(el('capMsg'), '保存中…', null);
  var btn = el('capSave');
  if (btn) btn.disabled = true;
  api('/api/capabilities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ updates: updates, __baseMtime: CAP.mtime })
  }).then(function (r) {
    CAP.mtime = r.mtime || CAP.mtime;
    setMsg(el('capMsg'), '已保存，下一轮生效', true);
    return loadCapabilities();
  }).catch(function (e) {
    setMsg(el('capMsg'), '保存失败：' + e.message, false);
  }).then(function () { if (btn) btn.disabled = false; });
}

if (el('capSave')) el('capSave').onclick = saveCapabilities;
if (el('capRefresh')) el('capRefresh').onclick = function () {
  setMsg(el('capMsg'), '读取中…', null);
  loadCapabilities().then(function () { setMsg(el('capMsg'), '已刷新', true); })
    .catch(function (e) { setMsg(el('capMsg'), '读取失败：' + e.message, false); });
};
