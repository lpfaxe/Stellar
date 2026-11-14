/* 今天刷的公开动态（好友爱看）：她看了哪几条、打了几分、赞了谁、评论了什么
 * 数据来自 qzone.mjs 写的账本 → /api/qzone-public
 */
var QZP_STATE = { data: null, page: 0, per: 8 };

function qzpEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function qzpTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function qzpScoreClass(n) {
  if (n == null) return 'qzp-score qzp-none';
  if (n >= 8) return 'qzp-score qzp-hi';
  if (n >= 5) return 'qzp-score qzp-mid';
  return 'qzp-score qzp-lo';
}

function qzpRings(c, lim) {
  var box = el('qzpRings');
  if (!box) return;
  var seen = Number(c.seen) || 0;
  var need = Number(lim.seenTarget) || 10;
  var parts = [];
  parts.push(ringStat({ have: seen, need: need, label: '看了几条', kind: seen >= need ? 'ok' : 'acc' }));
  parts.push(ringStat({ have: Number(c.scored) || 0, need: seen || need, label: '打了分', kind: (Number(c.scored) || 0) >= (seen || need) ? 'ok' : 'acc' }));
  parts.push(ringStat({ have: Number(c.liked) || 0, need: Number(lim.likeLimit) || 3, label: '点了赞', kind: (Number(c.liked) || 0) >= (Number(lim.likeLimit) || 3) ? 'ok' : 'warn' }));
  parts.push(ringStat({ have: Number(c.commented) || 0, need: Number(lim.commentLimit) || 3, label: '留了评论', kind: (Number(c.commented) || 0) >= (Number(lim.commentLimit) || 3) ? 'ok' : 'warn' }));
  box.innerHTML = parts.join('');
}

function renderQzonePublic(d) {
  if (d) QZP_STATE.data = d;
  var data = QZP_STATE.data || {};
  var c = data.counts || {};
  var lim = data.limits || {};
  var items = Array.isArray(data.items) ? data.items : [];

  var sum = el('qzpSummary');
  if (sum) {
    if (!items.length) sum.textContent = '今天还没刷（每日 ' + (lim.time || '20:30') + ' 自动跑一次）';
    else {
      sum.textContent = '看了 ' + (c.seen || items.length) + ' 条 · 打分 ' + (c.scored || 0)
        + ' · 赞 ' + (c.liked || 0) + '/' + (lim.likeLimit || 3)
        + ' · 评论 ' + (c.commented || 0) + '/' + (lim.commentLimit || 3)
        + (c.avgScore ? ' · 平均 ' + c.avgScore + ' 分' : '');
    }
  }

  qzpRings(c, lim);
  var box = el('qzpList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<p class="muted">今天还没刷公开动态。到点她会按配置翻；想提前看，就在 QQ 私聊跟她说一句「看看好友爱看」。</p>';
    qzpPager(0, 0);
    return;
  }
  var per = QZP_STATE.per;
  var pages = Math.max(1, Math.ceil(items.length / per));
  if (QZP_STATE.page > pages - 1) QZP_STATE.page = pages - 1;
  if (QZP_STATE.page < 0) QZP_STATE.page = 0;
  var start = QZP_STATE.page * per;
  var slice = items.slice(start, start + per);
  qzpPager(items.length, pages);
  box.innerHTML = slice.map(function (it) {
    var score = (it.score == null)
      ? '<span class="qzp-score qzp-none">未打分</span>'
      : '<span class="' + qzpScoreClass(Number(it.score)) + '">' + Number(it.score) + ' 分</span>';
    var marks = [];
    if (it.likeAt) marks.push('<span class="qzp-mark qzp-like">已赞' + (qzpTime(it.likeAt) ? ' ' + qzpTime(it.likeAt) : '') + '</span>');
    if (it.commentAt) marks.push('<span class="qzp-mark qzp-cmt">已评论</span>');
    if (it.note) marks.push('<span class="qzp-meta">她的话：' + qzpEsc(it.note) + '</span>');
    var meta = [];
    if (it.nick) meta.push(qzpEsc(it.nick));
    if (it.pictures) meta.push('图 ' + it.pictures);
    if (it.likes) meta.push('赞 ' + it.likes);
    if (it.comments) meta.push('评 ' + it.comments);
    var body = it.text ? qzpEsc(it.text) : '<span class="muted">（只留了开头）</span>';
    // 她当时看到的截图（每天清空；清掉之后这里自然就没有了，文字还在）
    var shots = Array.isArray(it.scanShots) ? it.scanShots : [];
    var shotHtml = shots.length
      ? '<div class="qzp-shots">' + shots.map(function (src, i) {
        return '<a class="qzp-shot" href="' + qzpEsc(src) + '" target="_blank" rel="noopener">'
          + '<img src="' + qzpEsc(src) + '" alt="截图 ' + (i + 1) + '" loading="lazy"></a>';
      }).join('') + '</div>'
      : '';
    var cmt = it.commentText
      ? '<div class="qzp-cmt-text">她的评论：' + qzpEsc(it.commentText) + '</div>'
      : '';
    // 公开流的 feed_id 拼不出能直接打开的 URL（要原样回传才能看），所以这里不给外链
    var link = '';
    return '<div class="qzp-item">'
      + '<div class="qzp-head">' + score + '<span class="qzp-order">#' + qzpEsc(it.order || '') + '</span>'
      + '<span class="qzp-meta">' + meta.join(' · ') + '</span>' + link + '</div>'
      + shotHtml
      + '<div class="qzp-body">' + body + '</div>'
      + (marks.length ? '<div class="qzp-marks">' + marks.join('') + '</div>' : '')
      + cmt
      + '</div>';
  }).join('');
}

/* 列表翻页：每天 10 条还好，30 条就太长了 —— 翻页比无限往下滚更好找 */
function qzpPager(total, pages) {
  var box = el('qzpPager');
  var label = el('qzpPageLabel');
  if (!box) return;
  if (pages <= 1) { box.classList.add('hide'); if (label) label.textContent = ''; return; }
  box.classList.remove('hide');
  if (label) label.textContent = '第 ' + (QZP_STATE.page + 1) + ' / ' + pages + ' 页（共 ' + total + ' 条）';
  var prev = el('qzpPrev'), next = el('qzpNext');
  if (prev) prev.disabled = QZP_STATE.page <= 0;
  if (next) next.disabled = QZP_STATE.page >= pages - 1;
}

async function loadQzonePublic() {
  var msg = el('qzpMsg');
  if (msg) msg.textContent = '';
  try {
    var d = await api('/api/qzone-public');
    renderQzonePublic(d);
  } catch (e) {
    var box = el('qzpList');
    if (box) box.innerHTML = '<p class="muted">读取失败：' + qzpEsc(e && e.message ? e.message : e) + '</p>';
    if (msg) msg.textContent = '读取失败';
  }
}

async function clearQzoneShots() {
  var msg = el('qzpMsg');
  if (!window.confirm('清空今天的所有截图？\n\n文字（看了哪条、几分、评论了什么）不会动。')) return;
  var btn = el('qzpShotsClear');
  if (btn) btn.disabled = true;
  try {
    var r = await api('/api/qzone-public/shots-clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (msg) msg.textContent = r && r.ok ? ('已清掉 ' + (r.removed || 0) + ' 张截图，文字还在') : '清空失败';
    await loadQzonePublic();
  } catch (e) {
    if (msg) msg.textContent = '清空失败：' + (e && e.message ? e.message : e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', function () {
  var b = el('qzpRefresh');
  if (b) b.addEventListener('click', loadQzonePublic);
  var c = el('qzpShotsClear');
  if (c) c.addEventListener('click', clearQzoneShots);
  var p = el('qzpPrev');
  if (p) p.addEventListener('click', function () { QZP_STATE.page -= 1; renderQzonePublic(); });
  var n = el('qzpNext');
  if (n) n.addEventListener('click', function () { QZP_STATE.page += 1; renderQzonePublic(); });
});
