/* 今天刷的 B站视频：她看了哪几条（观看历史）、封面长什么样（今日图片池）。
 * 文字一直留着；封面图每天清空 → 图没了显示占位，标题照旧。
 * 每条可单独删掉记录（会重写观看历史里当天的那些行，先备份 .bak）。
 */
var BV_STATE = { data: null, busy: false };

function bvEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function bvTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function bvDur(sec) {
  var n = Number(sec) || 0;
  if (!n) return '';
  var m = Math.floor(n / 60);
  var s = n % 60;
  return m + ':' + (s < 10 ? '0' + s : s);
}

function bvRings(items, c) {
  var box = el('bvRings');
  if (!box) return;
  var total = Number(c.total) || items.length;
  var target = Number(c.target) || 0;
  var parts = [];
  if (target > 0) {
    parts.push(ringStat({ have: total, need: target, label: '今天看了', kind: total >= target ? 'ok' : 'acc' }));
  } else {
    parts.push(ringStat({ have: total, need: total, label: '今天看了', kind: 'acc' }));
  }
  parts.push(ringStat({ have: Number(c.covers) || 0, need: total || 1, label: '留了封面', kind: 'acc' }));
  parts.push(ringStat({ have: Number(c.full) || 0, need: total || 1, label: '点进去看', kind: 'ok' }));
  box.innerHTML = parts.join('');
}

function renderBiliVideos(d) {
  if (d) BV_STATE.data = d;
  var data = BV_STATE.data || {};
  var c = data.counts || {};
  var items = Array.isArray(data.items) ? data.items : [];
  var sum = el('bvSummary');
  if (sum) {
    if (!items.length) sum.textContent = '今天还没刷 B站视频';
    else sum.textContent = '看了 ' + items.length + (c.target ? '/' + c.target : '') + ' 条 · 有封面 ' + (c.covers || 0) + ' 张' + (c.full ? ' · 点进去看 ' + c.full + ' 条' : '');
  }
  bvRings(items, c);
  var box = el('bvList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<p class="muted">今天还没有观看记录。她刷 B站时（在看/看视频）会自动记在这里。</p>';
    return;
  }
  box.innerHTML = items.map(function (it) {
    var cover = it.cover
      ? '<a class="bv-cover" href="' + bvEsc(it.cover) + '" target="_blank" rel="noopener"><img src="' + bvEsc(it.cover) + '" alt="封面" loading="lazy"></a>'
      : '<div class="bv-cover bv-nocover"><span>封面已清</span></div>';
    var meta = [];
    if (it.up) meta.push(bvEsc(it.up));
    if (it.duration) meta.push(bvDur(it.duration));
    if (it.modeLabel) meta.push(bvEsc(it.modeLabel));
    if (it.at) meta.push(bvTime(it.at));
    if (it.visits > 1) meta.push('看了 ' + it.visits + ' 次');
    var bvid = bvEsc(it.bvid);
    return '<div class="bv-item" data-bvid="' + bvid + '">'
      + cover
      + '<div class="bv-main">'
      + '<div class="bv-title">' + (it.title ? bvEsc(it.title) : bvEsc(it.bvid)) + '</div>'
      + '<div class="bv-meta">' + meta.join(' · ') + '</div>'
      + '</div>'
      + '<div class="bv-ops">'
      + '<button class="ghost bv-del" data-bvid="' + bvid + '">删掉</button>'
      + '</div>'
      + '</div>';
  }).join('');
  box.querySelectorAll('.bv-del').forEach(function (btn) {
    btn.addEventListener('click', function () { bvDelete(btn.getAttribute('data-bvid'), btn); });
  });
}

async function loadBiliVideos() {
  try {
    var d = await api('/api/bili-videos');
    renderBiliVideos(d);
  } catch (e) {
    var box = el('bvList');
    if (box) box.innerHTML = '<p class="muted">读取失败：' + bvEsc(e && e.message ? e.message : e) + '</p>';
  }
}

async function bvDelete(bvid, btn) {
  var msg = el('bvMsg');
  if (!bvid) return;
  if (!window.confirm('删掉这条观看记录？（只删今天的这一条，封面也会一起清掉）')) return;
  if (btn) btn.disabled = true;
  try {
    var r = await api('/api/bili-videos/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bvid: bvid }),
    });
    if (msg) msg.textContent = r && r.ok ? '已删掉 ' + (r.removed || 1) + ' 条' : '没删掉';
    await loadBiliVideos();
  } catch (e) {
    if (msg) msg.textContent = '删除失败：' + (e && e.message ? e.message : e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function bvClearCovers() {
  var msg = el('bvMsg');
  if (!window.confirm('清空今天的封面图？\n\n标题等文字不会动。')) return;
  var btn = el('bvCoversClear');
  if (btn) btn.disabled = true;
  try {
    var r = await api('/api/bili-videos/covers-clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (msg) msg.textContent = r && r.ok ? ('已清掉 ' + (r.removed || 0) + ' 张封面，文字还在') : '清空失败';
    await loadBiliVideos();
  } catch (e) {
    if (msg) msg.textContent = '清空失败：' + (e && e.message ? e.message : e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', function () {
  var r = el('bvRefresh');
  if (r) r.addEventListener('click', loadBiliVideos);
  var c = el('bvCoversClear');
  if (c) c.addEventListener('click', bvClearCovers);
  var p = el('bvPrev');
  if (p) p.addEventListener('click', function () { BV_STATE.page -= 1; renderBiliVideos(); });
  var n = el('bvNext');
  if (n) n.addEventListener('click', function () { BV_STATE.page += 1; renderBiliVideos(); });
});