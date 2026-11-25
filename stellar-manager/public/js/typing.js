/* 「对方正在输入」观测（2026-11-25，主人要的：观测日志加到控制台，7 天滚动）。
 *
 * 这张卡只读：数据来自桥接写的 state/typing-log.jsonl（一行一个事件）。
 * 桥接每 6 小时裁一次文件，面板再按保留天数过滤一遍 —— 所以「她说今天等了几次」
 * 和这里看到的数字对得上。
 *
 * 全部用 createElement + textContent：日志里的 key 是外部数据（QQ 号），不拼 innerHTML。
 */
var TYPING = { data: null, loading: false };

function twFmtAgo(ms) {
  if (ms == null) return '—';
  var s = Math.round(Number(ms) / 1000);
  if (!isFinite(s) || s < 0) return '—';
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}

function twStateText(state) {
  if (Number(state) === 0) return '停手';
  if (Number(state) === 3) return '说话中';
  return '打字中';
}

function twRow(row) {
  var line = document.createElement('div');
  line.className = 'wi-log-row';

  var tag = document.createElement('span');
  tag.className = 'wi-log-tag' + (Number(row.state) === 0 ? '' : ' typ');
  tag.textContent = twStateText(row.state);
  line.appendChild(tag);

  var who = document.createElement('span');
  who.className = 'wi-log-name';
  who.textContent = (row.who || row.key || '未知') + (row.owner ? '（主人）' : '');
  line.appendChild(who);

  var at = document.createElement('span');
  at.className = 'wi-log-at';
  at.textContent = twFmtAgo(row.agoMs);
  line.appendChild(at);

  return line;
}

function twRenderDays(data) {
  var box = el('twDays');
  if (!box) return;
  box.textContent = '';
  var days = (data && data.days) || [];
  if (!days.length) return;
  days.forEach(function (d) {
    var chip = document.createElement('span');
    chip.className = 'pill small';
    chip.textContent = d.day.slice(5) + ' · ' + d.typing + ' 次';
    chip.title = d.total + ' 条事件（打字 ' + d.typing + ' / 停手 ' + d.stop + '）';
    box.appendChild(chip);
  });
}

function twRender(data) {
  if (data) TYPING.data = data;
  var d = TYPING.data || {};
  var sum = el('twSummary');
  if (sum) sum.textContent = d.headline || d.message || '读取中…';

  var list = el('twList');
  if (list) {
    list.textContent = '';
    var rows = d.rows || [];
    if (!d.ok) {
      var bad = document.createElement('p');
      bad.className = 'muted';
      bad.textContent = d.message || '读不到观测数据';
      list.appendChild(bad);
    } else if (!rows.length) {
      var empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = d.exists
        ? '日志是空的（最近 ' + (d.keepDays || 7) + ' 天没有「正在输入」事件）。'
        : '还没有日志文件：她这版还没重启，或者最近没人给她发过消息。';
      list.appendChild(empty);
    } else {
      rows.forEach(function (row) { list.appendChild(twRow(row)); });
    }
  }

  twRenderDays(d);

  var foot = el('twFoot');
  if (foot) {
    if (!d.exists) {
      foot.textContent = '';
    } else {
      var kb = Math.max(1, Math.round((Number(d.sizeBytes) || 0) / 1024));
      foot.textContent = '共 ' + kb + ' KB · 保留 ' + (d.keepDays || 7) + ' 天 · 文件 state/typing-log.jsonl';
    }
  }
}

function loadTypingWatch() {
  if (TYPING.loading) return Promise.resolve(null);
  TYPING.loading = true;
  return fetch('/api/typing-watch', { headers: { 'x-panel-request': 'panel' }, credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) { twRender(d); return d; })
    .catch(function (e) { twRender({ ok: false, message: '读取失败：' + (e && e.message ? e.message : e) }); })
    .then(function (d) { TYPING.loading = false; return d; });
}

window.loadTypingWatch = loadTypingWatch;

(function bindTypingCard() {
  var btn = el('twRefresh');
  if (btn) btn.addEventListener('click', function () { loadTypingWatch(); });
})();
