/* // 她的日报：日期左右翻页 + 正文 + 「让她现在写」（2026-11-11 从下拉改成翻页） */
var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function reportLabel(r, today) {
  var d = new Date(r.date + 'T00:00:00');
  var wd = isNaN(d.getTime()) ? '' : ' ' + WEEK[d.getDay()];
  return r.date.slice(5) + wd + (r.date === today ? ' · 今天' : '');
}
function renderReport() {
  var sel = el('reportDate');
  var label = el('reportDateLabel');
  var box = el('reportText');
  var today = state.status && state.status.report ? state.status.report.today : '';
  if (sel) sel.textContent = '';
  if (!state.reports.length) {
    if (sel) {
      var o = document.createElement('option');
      o.value = '';
      o.textContent = '还没有报告';
      sel.appendChild(o);
    }
    if (label) label.textContent = '还没有报告';
    if (box) box.textContent = '（她还没写过日报。到 23:30 会自动提醒；也可以点右边「让她现在写」。）';
    reportPagerBtn();
    return;
  }
  var pick = state.reports.some(function (r) { return r.date === state.reportDate; }) ? state.reportDate : state.reports[0].date;
  state.reportDate = pick;
  if (sel) {
    state.reports.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r.date;
      o.textContent = reportLabel(r, today);
      sel.appendChild(o);
    });
    sel.value = pick;
  }
  var idx = state.reports.findIndex(function (r) { return r.date === pick; });
  var cur = state.reports[idx];
  if (label) {
    var wd = reportLabel(cur || { date: pick }, today);
    label.textContent = wd + '（' + (idx + 1) + '/' + state.reports.length + '）';
  }
  reportPagerBtn();
  if (!cur) { if (box) box.textContent = '（读不到这一天）'; return; }
  var head = cur.title ? cur.title + '\n' : '';
  if (box) box.textContent = head + (cur.text || '（空）');
}

// 左右翻：reports 按日期倒序（新的在前），所以「‹」= 更早 = 下标 +1
function reportPagerBtn() {
  var idx = state.reports.findIndex(function (r) { return r.date === state.reportDate; });
  var prev = el('reportPrev'), next = el('reportNext');
  if (prev) prev.disabled = !state.reports.length || idx >= state.reports.length - 1;
  if (next) next.disabled = !state.reports.length || idx <= 0;
}

function reportStep(delta) {
  var idx = state.reports.findIndex(function (r) { return r.date === state.reportDate; });
  if (idx < 0) return;
  var n = state.reports[idx + delta];
  if (!n) return;
  state.reportDate = n.date;
  renderReport();
}
function loadReports() {
  return api('/api/reports?days=30').then(function (r) {
    state.reports = r.items || [];
    renderReport();
  }).catch(function (e) { console.error(e); });
}
if (el('reportDate')) el('reportDate').onchange = function () { state.reportDate = this.value; renderReport(); };
if (el('reportPrev')) el('reportPrev').onclick = function () { reportStep(1); };
if (el('reportNext')) el('reportNext').onclick = function () { reportStep(-1); };
el('reportRefresh').onclick = loadReports;
el('reportReq').onclick = function () {
  var btn = this;
  btn.disabled = true;
  setMsg(el('reportMsg'), '通知中…', null);
  api('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'report-request' }) })
    .then(function (r) {
      setMsg(el('reportMsg'), r.message, r.ok);
      setTimeout(loadReports, 20000);
      setTimeout(loadReports, 60000);
    })
    .catch(function (e) { setMsg(el('reportMsg'), '失败：' + e.message, false); })
    .then(function () { btn.disabled = false; });
};

