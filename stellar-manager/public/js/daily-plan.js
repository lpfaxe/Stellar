/* 她每天做什么：开关 + 数量（对应 GET/POST /api/daily-plan）。
 * 只渲染后端白名单里的字段，值回来是什么就画什么；保存时把所有改动一次提交。
 * 注意 api() 不会替你 JSON.stringify，body 必须自己转。 */
var PLAN = { data: null, dirty: {} };

function planEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function planMark(path, value) { PLAN.dirty[path] = value; }

function renderDailyPlan(data) {
  PLAN.data = data;
  var box = el('planList');
  if (!box) return;
  if (!data || !data.ok) { box.innerHTML = '<p class="muted">读不到配置：' + planEsc(data && data.message) + '</p>'; return; }
  if (el('planFile')) el('planFile').textContent = data.file || '—';
  if (el('planFileBridge')) el('planFileBridge').textContent = data.bridgeFile || '—';
  var html = '';
  data.tasks.forEach(function (t) {
    html += '<div class="plan-item' + (t.enabled ? '' : ' is-off') + '" data-key="' + planEsc(t.key) + '">';
    html += '<div class="plan-head">';
    if (t.togglable) {
      html += '<label class="plan-switch"><input type="checkbox" data-plan-bool="' + planEsc(t.enabledPath) + '"' + (t.enabled ? ' checked' : '') + '><span></span></label>';
    } else {
      html += '<span class="plan-switch is-static"></span>';
    }
    html += '<div class="plan-name"><b>' + planEsc(t.name) + '</b><span class="hint">' + planEsc(t.hint) + '</span></div>';
    html += '</div>';
    if (t.numbers.length || t.times.length) {
      html += '<div class="plan-fields">';
      t.numbers.forEach(function (n) {
        html += '<label class="plan-num">' + planEsc(n.label) +
          '<input type="number" min="' + n.min + '" max="' + n.max + '" step="1" value="' + planEsc(n.value) + '" data-plan-num="' + planEsc(n.path) + '">' +
          '<i class="plan-unit"></i></label>';
      });
      t.times.forEach(function (tm) {
        html += '<label class="plan-num">' + planEsc(tm.label) +
          '<input type="time" value="' + planEsc(tm.value) + '" data-plan-time="' + planEsc(tm.path) + '"></label>';
      });
      html += '</div>';
    }
    if (t.kinds && t.kinds.length) {
      html += '<div class="plan-kinds">';
      t.kinds.forEach(function (k) {
        html += '<label class="plan-kind"><input type="checkbox" data-plan-bool="' + planEsc(k.enabledPath) + '"' + (k.enabled ? ' checked' : '') + '><span>' + planEsc(k.name) + '</span></label>';
      });
      html += '</div>';
    }
    html += '</div>';
  });
  box.innerHTML = html;
  PLAN.dirty = {};
}

function loadDailyPlan() {
  return api('/api/daily-plan').then(function (data) {
    renderDailyPlan(data);
    var ro = el('planReadonly');
    if (ro) ro.textContent = data && data.ok ? '' : '当前是只读访问，改不了';
    return data;
  }).catch(function (e) {
    var box = el('planList');
    if (box) box.innerHTML = '<p class="muted">读不到：' + planEsc(e && e.message) + '</p>';
    return null;
  });
}

function planCollect() {
  var values = {};
  document.querySelectorAll('[data-plan-bool]').forEach(function (node) {
    values[node.getAttribute('data-plan-bool')] = node.checked;
  });
  document.querySelectorAll('[data-plan-num]').forEach(function (node) {
    values[node.getAttribute('data-plan-num')] = Number(node.value);
  });
  document.querySelectorAll('[data-plan-time]').forEach(function (node) {
    values[node.getAttribute('data-plan-time')] = node.value;
  });
  return values;
}

function saveDailyPlan() {
  var btn = el('planSave');
  var msg = el('planMsg');
  var values = planCollect();
  if (!Object.keys(values).length) { setMsg(msg, '没有可保存的字段', false); return Promise.resolve(null); }
  if (btn) btn.disabled = true;
  setMsg(msg, '保存中…', true);
  return api('/api/daily-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: values, __baseMtime: PLAN.data && PLAN.data.mtime || 0 }),
  }).then(function (data) {
    renderDailyPlan(data);
    var saved = data && data.saved || {};
    setMsg(msg, '已保存 ' + (saved.updated || 0) + ' 项（写进 ' + ((saved.wrote || []).join(' + ') || '无') + '），下一轮生效', true);
    if (window.loadDailyTasks) loadDailyTasks();
    return data;
  }).catch(function (e) {
    setMsg(msg, '保存失败：' + (e && e.message || e), false);
    return null;
  }).finally(function () {
    if (btn) btn.disabled = false;
  });
}

document.addEventListener('DOMContentLoaded', function () {
  var save = el('planSave');
  if (save) save.addEventListener('click', function () { saveDailyPlan(); });
  var refresh = el('planRefresh');
  if (refresh) refresh.addEventListener('click', function () {
    setMsg(el('planMsg'), '重新读取…', true);
    loadDailyPlan();
  });
  loadDailyPlan();
});