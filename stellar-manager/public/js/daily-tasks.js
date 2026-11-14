/* 她今天的任务清单：看视频 / 刷动态 / 说说 / 三连 / 日报 / 搭话 / 记忆……
 * 数据来自 /api/daily-tasks（只读汇总，后端 lib/daily-tasks.js 从各状态文件现算）。
 */
var DL_STATE = { data: null };

function dlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function dlTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dlStateLabel(state) {
  if (state === 'done') return '做完了';
  if (state === 'partial') return '做了一半';
  if (state === 'off') return '今天不做';
  return '还没动';
}

function dlBar(it) {
  var p = it.progress;
  if (!p || !p.need) return '';
  var pct = Math.max(0, Math.min(100, Math.round((Number(p.have) || 0) / Number(p.need) * 100)));
  return '<div class="dl-progress"><i style="width:' + pct + '%"></i></div>';
}

function dlRings(items, data) {
  var box = el('dlRings');
  if (!box) return;
  var counts = (data && data.counts) || {};
  var done = Number(counts.done) || 0;
  var total = (Number(counts.done) || 0) + (Number(counts.partial) || 0) + (Number(counts.pending) || 0);
  if (!total) total = items.filter(function (it) { return it.state !== 'off'; }).length;
  var parts = [];
  parts.push(ringStat({ have: done, need: total, label: '做完', kind: done >= total ? 'ok' : 'acc', size: 56 }));
  // 逐个有进度的任务给个小环（最多 5 个，免得一圈挤成一团）
  items.filter(function (it) {
    return it.state !== 'off' && it.progress && Number(it.progress.need) > 0;
  }).slice(0, 5).forEach(function (it) {
    var have = Number(it.progress.have) || 0, need = Number(it.progress.need) || 0;
    var pct = need ? Math.round(have / need * 100) : 0;
    parts.push(ringStat({ have: have, need: need, label: it.label, kind: pct >= 100 ? 'ok' : pct > 0 ? 'acc' : 'off', size: 44 }));
  });
  box.innerHTML = parts.join('');
}

function renderDailyTasks(d) {
  if (d) DL_STATE.data = d;
  var data = DL_STATE.data || {};
  var items = Array.isArray(data.items) ? data.items : [];
  var sum = el('dlSummary');
  if (sum) {
    if (data.ok === false) sum.textContent = '读取失败：' + (data.message || '未知原因');
    else sum.textContent = (data.day || '') + ' · ' + (data.headline || ('共 ' + items.length + ' 件'));
  }
  dlRings(items, data);
  var box = el('dlList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<p class="muted">今天还没有可统计的任务。</p>';
    return;
  }
  box.innerHTML = items.map(function (it) {
    var state = String(it.state || 'pending');
    var prog = '';
    if (it.progress && it.progress.need) {
      prog = '<span class="dl-count" title="已完成 / 目标">' + (Number(it.progress.have) || 0) + ' / ' + (Number(it.progress.need) || 0) + (it.progress.unit || '') + '</span>';
    }
    var when = dlTime(it.at);
    return '<div class="dl-item is-' + dlEsc(state) + '">'
      + '<span class="dl-badge is-' + dlEsc(state) + '">' + dlStateLabel(state) + '</span>'
      + '<div class="dl-main">'
      + '<div class="dl-title">' + dlEsc(it.label) + prog + (when ? '<span class="dl-when">' + when + '</span>' : '') + '</div>'
      + (it.detail ? '<div class="dl-detail">' + dlEsc(it.detail) + '</div>' : '')
      + (it.hint && it.detail === '' ? '<div class="dl-detail muted">' + dlEsc(it.hint) + '</div>' : '')
      + dlBar(it)
      + '</div></div>';
  }).join('');
}

async function loadDailyTasks() {
  var msg = el('dlMsg');
  if (msg) msg.textContent = '';
  try {
    var d = await api('/api/daily-tasks');
    renderDailyTasks(d);
  } catch (e) {
    var box = el('dlList');
    if (box) box.innerHTML = '<p class="muted">读取失败：' + dlEsc(e && e.message ? e.message : e) + '</p>';
    if (msg) msg.textContent = '读取失败';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  var b = el('dlRefresh');
  if (b) b.addEventListener('click', loadDailyTasks);
});