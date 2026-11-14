/* 她自己找的图（owner 2026-11-11 22:25 要的）：
 * 独立目录 ~/.dsh/stellar/web-images/<日期>/，每天清空、最多 30 张；
 * 控制台能看原图、删单张、全删；她删的图也会带 by=her 记进删除记录。
 */
var WEBIMGS = { data: null, canWrite: true };

function wiEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function wiSize(n) {
  var b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}
function wiTime(at) {
  if (!at) return '';
  var d = new Date(Number(at));
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function wiRenderLog(data) {
  var box = el('wiLog');
  if (!box) return;
  var rows = [];
  (data.deletes || []).forEach(function (d) {
    rows.push('<div class="wi-log-row"><span class="wi-log-tag del">删</span><span class="wi-log-name">' + wiEsc(d.name) + '</span>' +
      '<span class="wi-log-by">' + (d.by === 'her' ? '她自己删的' : wiEsc(d.by || '主人')) + '</span>' +
      '<span class="wi-log-at">' + wiTime(d.at) + '</span></div>');
  });
  (data.clears || []).forEach(function (c) {
    rows.push('<div class="wi-log-row"><span class="wi-log-tag clear">清空</span><span class="wi-log-name">一次清了 ' + (c.removed || 0) + ' 张</span>' +
      '<span class="wi-log-by">' + wiEsc(c.by || '') + '</span><span class="wi-log-at">' + wiTime(c.at) + '</span></div>');
  });
  box.innerHTML = rows.length ? rows.join('') : '<div class="muted small">今天还没删过图。</div>';
}

function wiRender(data) {
  if (data) WEBIMGS.data = data;
  var d = WEBIMGS.data || {};
  WEBIMGS.canWrite = d.canWrite !== false;
  var grid = el('wiGrid');
  if (!grid) return;
  var items = d.items || [];
  if (el('wiSummary')) {
    el('wiSummary').textContent = (d.day || '—') + ' · ' + (d.count || 0) + '/' + (d.max || 30) + ' 张 · 共 ' + wiSize(d.bytes || 0);
  }
  var rings = el('wiRings');
  if (rings) {
    rings.innerHTML = window.ringStat
      ? ringStat({ have: d.count || 0, need: d.max || 30, label: '今天找的图', kind: 'ok', size: 52 })
      : '';
  }
  if (!items.length) {
    grid.innerHTML = '<div class="empty">今天她还没在网上找图。她清醒时可能自己搜（一天最多 30 张，第二天自动清空）。</div>';
  } else {
    grid.innerHTML = items.map(function (it) {
      return '<figure class="wi-item" data-name="' + wiEsc(it.name) + '">' +
        '<a href="' + wiEsc(it.src) + '" target="_blank" rel="noreferrer"><img loading="lazy" src="' + wiEsc(it.src) + '" alt="' + wiEsc(it.title || it.query || it.name) + '"></a>' +
        (WEBIMGS.canWrite ? '<button class="wi-del" title="删掉这张">✕</button>' : '') +
        '<figcaption><span class="wi-title">' + wiEsc(it.title || it.query || '（没写关键词）') + '</span>' +
        '<span class="wi-meta">' + wiSize(it.bytes) + ' · ' + wiTime(it.at) + '</span></figcaption>' +
        '</figure>';
    }).join('');
  }
  wiRenderLog(d);
  var clearBtn = el('wiClear');
  if (clearBtn) clearBtn.disabled = !WEBIMGS.canWrite || !items.length;
}

function loadWebImages() {
  return api('/api/web-images').then(function (d) { wiRender(d); return d; })
    .catch(function (e) {
      var msg = el('wiMsg');
      if (msg) { msg.textContent = '读取失败：' + e.message; msg.className = 'msg bad'; }
    });
}

function wiDelete(name) {
  if (!WEBIMGS.canWrite) return;
  if (!confirm('删掉这张图？\n\n' + name + '\n\n删了会在「删除记录」里留一条。')) return;
  setMsg(el('wiMsg'), '删除中…');
  api('/api/web-images/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) })
    .then(function (r) { setMsg(el('wiMsg'), '已删 ' + (r.name || name), true); return loadWebImages(); })
    .catch(function (e) { setMsg(el('wiMsg'), e.message, false); });
}

(function bindWebImages() {
  var grid = el('wiGrid');
  if (grid) {
    grid.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.wi-del');
      if (!btn) return;
      ev.preventDefault();
      var fig = btn.closest('.wi-item');
      wiDelete(fig ? fig.getAttribute('data-name') : '');
    });
  }
  if (el('wiRefresh')) el('wiRefresh').onclick = function () { loadWebImages(); };
  if (el('wiClear')) el('wiClear').onclick = function () {
    if (!WEBIMGS.canWrite) return;
    var n = (WEBIMGS.data && WEBIMGS.data.count) || 0;
    if (!n) return;
    if (!confirm('把她今天找的 ' + n + ' 张图全删掉？\n\n文字记录会留一条「一次清了 N 张」。')) return;
    setMsg(el('wiMsg'), '清空中…');
    api('/api/web-images/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { setMsg(el('wiMsg'), '已清空 ' + (r.removed || 0) + ' 张', true); return loadWebImages(); })
      .catch(function (e) { setMsg(el('wiMsg'), e.message, false); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadWebImages);
  else loadWebImages();
})();