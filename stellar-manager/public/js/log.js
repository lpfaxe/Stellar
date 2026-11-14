/* 日志面板（守护/桥接/面板） */
function loadLog() {
  var pre = el('logText');
  pre.textContent = '加载中…';
  api('/api/logs?name=' + encodeURIComponent(state.logName) + '&lines=200')
    .then(function (r) { pre.textContent = r.text || '(空)'; pre.scrollTop = pre.scrollHeight; })
    .catch(function (e) { pre.textContent = '读取失败：' + e.message; });
}
document.querySelectorAll('#logTabs button[data-log]').forEach(function (btn) {
  btn.onclick = function () {
    document.querySelectorAll('#logTabs button[data-log]').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    state.logName = btn.dataset.log;
    loadLog();
  };
});
el('logRefresh').onclick = loadLog;
