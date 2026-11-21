/* // 生物钟编辑 + 手动发说说 + 快捷操作按钮 */
// 并发保护：把页面上次读到的配置 mtime 带上，别处改过时面板会返回 409 让人刷新
function cfgBaseMtime() { return state.status && state.status.configMtime ? state.status.configMtime : 0; }

function collectWindows() {
  var rows = document.querySelectorAll('#windows .win');
  var out = [];
  rows.forEach(function (row) {
    var start = row.querySelector('.win-start').value.trim();
    var end = row.querySelector('.win-end').value.trim();
    var wakes = Number(row.querySelector('.win-wakes').value);
    if (!start || !end) return;
    out.push({ start: start, end: end, wakes: wakes });
  });
  return out;
}

el('saveClock').onclick = function () {
  var payload = {
    night: {
      windows: collectWindows(),
      videoTargetPerDay: Number(el('videoTarget').value),
      maxWakesPerDay: Number(el('maxWakes').value),
      skipChance: Number(el('skipChance').value),
      minGapMin: Number(el('minGap').value),
      frames: el('frames').value
    },
    __baseMtime: cfgBaseMtime()
  };
  setMsg(el('clockMsg'), '保存中…', null);
  api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then(function () { dirty.clock = false; setMsg(el('clockMsg'), '已保存，下一次排版生效', true); return loadStatus(); })
    .catch(function (e) { setMsg(el('clockMsg'), '保存失败：' + e.message, false); });
};

function sendQzone(go) {
  var text = el('qzoneText').value.trim();
  if (!text) { setMsg(el('qzoneMsg'), '先写点内容', false); return; }
  var payload = { action: 'qzone', text: text, image: el('qzoneImage').value.trim(), right: Number(el('qzoneRight').value), go: go };
  setMsg(el('qzoneMsg'), go ? '发布中…' : '演练中…', null);
  api('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 210000 })
    .then(function (r) { setMsg(el('qzoneMsg'), (r.ok ? (go ? '已发布' : '演练通过（未发布）') : '失败') + '：' + r.message, r.ok); })
    .catch(function (e) { setMsg(el('qzoneMsg'), e.message, false); });
}
el('qzoneDry').onclick = function () { sendQzone(false); };
el('qzoneGo').onclick = function () {
  if (!confirm('确认真的发到 QQ 空间？')) return;
  sendQzone(true);
};

function act(action, btn) {
  var out = el('actionOut');
  out.textContent = '执行中…';
  btn.disabled = true;
  var payload = { action: action };
  api('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 260000 })
    .then(function (r) { out.textContent = (r.ok ? '✓ ' : '✗ ') + (r.message || ''); return loadStatus(); })
    .catch(function (e) { out.textContent = '失败：' + e.message; })
    .then(function () { btn.disabled = false; });
}
el('actKeepalive').onclick = function () { act('keepalive', this); };
el('actSnow').onclick = function () { act('start-snowluma', this); };
el('actCleanSnow').onclick = function () { act('clean-snowluma', this); };
el('actBridge').onclick = function () { act('start-bridge', this); };
el('actReplan').onclick = function () { if (confirm('删掉今天的计划并重新排？')) act('replan', this); };
el('actStop').onclick = function () {
  if (!confirm('紧急停止？\n她会立刻停下：不再自动醒来、不发消息/说说/动态/评论，生图也停。\n停下后不会自动恢复，等你点「恢复运行」。')) return;
  act('stop', this);
};
el('actResume').onclick = function () {
  act('resume', this);
};
var passSave = el('passSave');
if (passSave) passSave.onclick = function () {
  var v = (el('passInput').value || '').trim();
  if (!v) { setMsg(el('passMsg'), '先输入新口令', false); return; }
  setMsg(el('passMsg'), '保存中…', null);
  passSave.disabled = true;
  api('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'set-passphrase', passphrase: v }) })
    .then(function (r) { setMsg(el('passMsg'), r.message || '已保存', !!r.ok); el('passInput').value = ''; return loadStatus(); })
    .catch(function (e) { setMsg(el('passMsg'), '保存失败：' + e.message, false); })
    .then(function () { passSave.disabled = false; });
};
el('actRestartDsh').onclick = function () {
  var t = state.status && state.status.turns;
  var warn = '';
  if (t && t.busy && t.top) {
    warn = '\n⚠ 她还在跑：' + t.top.label + ' · ' + t.top.action + '（已 ' + t.top.elapsedText + (t.top.etaText ? '，' + t.top.etaText : '') + '）'
      + (t.count > 1 ? '，另有 ' + (t.count - 1) + ' 个会话没收尾' : '') + '。\n现在重启会打断这一轮。';
  }
  if (!confirm('重启 DSH？正在进行的对话会中断，约 20–40 秒回来。\n面板、SnowLuma、桥接不受影响，手机上的这个页面也不会断。' + warn)) return;
  act('restart-dsh', this);
};
