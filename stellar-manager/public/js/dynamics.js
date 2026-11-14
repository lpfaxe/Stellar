/* 她的 B 站动态：只读展示 daily-dynamic.json（发出去的是她自己的号） */
var DYN_STATE = { items: [] };

function dynEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function dynWhen(at, atText) {
  if (!at) return atText || '';
  var d = new Date(at);
  if (isNaN(d.getTime())) return atText || '';
  var now = new Date();
  var time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return '今天 ' + time;
  var y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天 ' + time;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time;
}

function dynAgo(at) {
  if (!at) return '';
  var t = new Date(at).getTime();
  if (!isFinite(t)) return '';
  var min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  var h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

function renderDynamics(d) {
  DYN_STATE = d || DYN_STATE;
  var items = Array.isArray(d && d.items) ? d.items : [];
  var sum = el('dynSummary');
  if (sum) {
    if (!items.length) sum.textContent = '还没有发过动态';
    else {
      var today = Number(d && d.todayCount) || 0;
      sum.textContent = '共 ' + (Number(d.total) || items.length) + ' 条 · 今天 ' + today + ' 条 · 最近 ' + dynAgo(items[0].at);
    }
  }
  var box = el('dynList');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<p class="muted">她还没发过 B 站动态。</p>'; return; }
  box.innerHTML = items.map(function (it) {
    var body = it.text ? dynEsc(it.text) : (it.excerpt ? dynEsc(it.excerpt) + '…' : '<span class="muted">（这条只留了开头，正文没存）</span>');
    var meta = [];
    meta.push(dynWhen(it.at, it.atText));
    if (it.bvid) meta.push(it.bvid);
    if (it.chars) meta.push(it.chars + ' 字');
    if (it.card) meta.push('带卡片');
    var link = it.url ? '<a class="dyn-link" href="' + dynEsc(it.url) + '" target="_blank" rel="noopener">打开</a>' : '';
    return '<div class="dyn-item">'
      + '<div class="dyn-head"><span class="dyn-kind">' + dynEsc(it.kindLabel || '动态') + '</span>'
      + '<span class="dyn-meta">' + dynEsc(meta.join(' · ')) + '</span>' + link + '</div>'
      + '<div class="dyn-body">' + body + '</div>'
      + '</div>';
  }).join('');
}

async function loadDynamics() {
  var msg = el('dynMsg');
  if (msg) msg.textContent = '';
  try {
    var d = await api('/api/dynamics?limit=12');
    renderDynamics(d);
  } catch (e) {
    var box = el('dynList');
    if (box) box.innerHTML = '<p class="muted">读取失败：' + dynEsc(e && e.message ? e.message : e) + '</p>';
    if (msg) msg.textContent = '读取失败';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  var b = el('dynRefresh');
  if (b) b.addEventListener('click', loadDynamics);
});
