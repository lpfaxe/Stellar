/* // 启动：恢复标签、首轮加载、定时刷新（页面不可见时暂停轮询） */

switchTab(state.tab);
loadStatus().then(loadCapabilities).then(loadLog).then(loadReports).then(loadTodos).then(loadDynamics)
  .then(function () { return window.loadQzonePublic ? loadQzonePublic() : null; })
  .then(function () { return window.loadBiliVideos ? loadBiliVideos() : null; })
  .then(function () { return window.loadWebImages ? loadWebImages() : null; })
  .then(function () { return window.loadFiles ? loadFiles() : null; })
  .then(function () { return window.loadDailyTasks ? loadDailyTasks() : null; })
  .then(loadCost)
  .then(function () { return window.loadMemoryDb ? loadMemoryDb() : null; })
  .then(function () { return window.loadProfiles ? loadProfiles() : null; })
  .then(function () { return window.loadStyleRefs ? loadStyleRefs() : null; })
  .then(function () { return window.loadTopics ? loadTopics(0) : null; })
  .then(function () { return window.loadFragments ? loadFragments() : null; })
  .then(loadContacts).then(loadOutbox).then(loadTask)
  .then(loadOps).then(loadApprovals);

// 页面切到后台（锁屏、切 App、标签页藏起来）就别再打接口：手机省电、隧道省流量、
// 面板也不用反复跑 PowerShell。回到前台时，超过一个周期没刷的立刻补一次。
var pollers = [];
function every(ms, fn) {
  var p = { ms: ms, fn: fn, last: Date.now() };
  pollers.push(p);
  setInterval(function () {
    if (document.hidden) return;
    p.last = Date.now();
    fn();
  }, ms);
  return p;
}

every(15000, loadApprovals);
every(60000, loadCost);
every(15000, function () { loadStatus(); });
every(60000, loadReports);
every(30000, loadTodos);
every(60000, loadDynamics);
every(60000, function () { if (window.loadQzonePublic) loadQzonePublic(); });
every(60000, function () { if (window.loadBiliVideos) loadBiliVideos(); });
every(60000, function () { if (window.loadWebImages) loadWebImages(); });
every(60000, function () { if (window.loadFiles) loadFiles(); });
every(60000, function () { if (window.loadDailyTasks) loadDailyTasks(); });
every(20000, function () { if (window.loadMemoryDb) loadMemoryDb(); });
every(20000, loadLog);
every(30000, function () { if (state.ops.tab === 'agent') loadOps(); });
every(120000, loadContacts);
every(30000, loadOutbox);
every(20000, loadTask);
every(60000, function () { if (window.loadProfiles) loadProfiles(); });

document.addEventListener('visibilitychange', function () {
  if (document.hidden) return;
  var now = Date.now();
  pollers.forEach(function (p) {
    if (now - p.last >= p.ms) { p.last = now; p.fn(); }
  });
});
