/* 运行模式：正常 / 摸鱼 / 最低限度（owner 2026-11-11 22:25）
 * 三档都建立在「强制休眠」之上：休眠是总闸，模式只决定醒着的时候干什么。
 * 判定在服务端（lib/run-mode.js），这里只负责点亮当前那一档、按键时写回去。
 */
var RUNMODE = { data: null, canWrite: true };

function modeLabel(mode) {
  return ({ normal: '正常模式', idle: '摸鱼模式', minimal: '最低限度运行模式' })[mode] || mode;
}

function renderRunMode(d) {
  if (d) RUNMODE.data = d;
  var data = RUNMODE.data || {};
  var row = el('modeRow');
  if (!row) return;
  RUNMODE.canWrite = data.canWrite !== false;
  Array.prototype.forEach.call(row.querySelectorAll('.mode'), function (btn) {
    var on = btn.getAttribute('data-mode') === data.mode;
    btn.classList.toggle('active', on);
    btn.disabled = !RUNMODE.canWrite;
    btn.title = on ? '当前生效' : '点一下切过去';
  });
  var msg = el('modeMsg');
  if (msg && !msg.textContent) {
    var why = data.source === 'weekend' ? '（周末默认摸鱼）' : (data.source === 'manual' ? '（你今天手动切的）' : (data.source === 'config' ? '（配置里写死的）' : ''));
    msg.textContent = '现在：' + modeLabel(data.mode) + why;
    msg.className = 'msg';
  }
}

function loadRunMode() {
  return api('/api/run-mode').then(function (d) { renderRunMode(d); return d; })
    .catch(function (e) {
      var msg = el('modeMsg');
      if (msg) { msg.textContent = '读取失败：' + e.message; msg.className = 'msg bad'; }
    });
}

function setRunMode(mode) {
  if (!RUNMODE.canWrite) return;
  var hint = mode === 'minimal'
    ? '最低限度：她不再自己醒，也不刷视频/动态，只有 QQ 有人说话才醒，醒 2 分钟没人理就睡回去。确定？'
    : (mode === 'idle' ? '摸鱼模式：每日任务只留写日志；视频和好友爱看按平常量，醒得更勤，多待在小镇，也更主动找人聊。确定？' : '正常模式：照常做全部每日任务。确定？');
  if (!confirm(hint)) return;
  var msg = el('modeMsg');
  if (msg) { msg.textContent = '切换中…'; msg.className = 'msg'; }
  api('/api/run-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: mode }) })
    .then(function (r) {
      renderRunMode(r);
      if (el('modeMsg')) { el('modeMsg').textContent = '已切到 ' + modeLabel(r.mode) + '（下一次 tick 生效）'; el('modeMsg').className = 'msg ok'; }
      if (window.loadDailyTasks) loadDailyTasks();
    })
    .catch(function (e) { if (el('modeMsg')) { el('modeMsg').textContent = e.message; el('modeMsg').className = 'msg bad'; } });
}

(function bindRunMode() {
  var row = el('modeRow');
  if (row) {
    row.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.mode');
      if (!btn) return;
      setRunMode(btn.getAttribute('data-mode'));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadRunMode);
  else loadRunMode();
})();