/* // 夜间电源：睡眠 / 唤醒计划（面板 → 计划任务） */
var POWER = { plan: null, capabilities: null, tasks: null, canWrite: true, loaded: false };

function powerModeLabel(mode) {
  return mode === 'hibernate' ? '休眠' : '睡眠';
}

function renderPower(data) {
  POWER.plan = data.plan || {};
  POWER.capabilities = data.capabilities || {};
  POWER.tasks = data.tasks || {};
  POWER.canWrite = data.canWrite !== false;
  POWER.loaded = true;
  var p = POWER.plan;
  var caps = POWER.capabilities;
  var stateText = p.enabled
    ? ('已启用 · 每天 ' + p.sleepAt + ' ' + powerModeLabel(p.mode) + ' → ' + p.wakeAt + ' 唤醒')
    : '未启用（现在不会自动睡）';
  if (el('powerState')) el('powerState').textContent = stateText;
  if (el('powerEnabled')) el('powerEnabled').checked = p.enabled === true;
  if (el('powerSleepAt')) el('powerSleepAt').value = p.sleepAt || '23:50';
  if (el('powerWakeAt')) el('powerWakeAt').value = p.wakeAt || '06:05';
  var opt = el('powerMode') && el('powerMode').querySelector('option[value="hibernate"]');
  if (opt) {
    opt.disabled = caps.hibernate !== true;
    opt.textContent = caps.hibernate === true ? '休眠（更省电）' : '休眠（这台电脑没启用）';
  }
  if (el('powerMode')) el('powerMode').value = p.mode === 'hibernate' ? 'hibernate' : 'sleep';
  var sleepTask = POWER.tasks.sleep && POWER.tasks.sleep.registered;
  var wakeTask = POWER.tasks.wake && POWER.tasks.wake.registered;
  var hint = [];
  if (p.enabled) hint.push('任务：睡眠' + (sleepTask ? '已注册' : '未注册') + ' · 唤醒' + (wakeTask ? '已注册' : '未注册'));
  else if (sleepTask || wakeTask) hint.push('检测到残留计划任务（' + (sleepTask ? '睡眠' : '') + (sleepTask && wakeTask ? ' / ' : '') + (wakeTask ? '唤醒' : '') + '），保存一次或手动删除。');
  if (caps.hibernate !== true) hint.push('休眠在这台电脑上没启用（HibernateEnabled=0），只能用睡眠。');
  else hint.push('休眠比睡眠更省电，但唤醒和恢复会慢一些。');
  if (data.dryRun) hint.push('当前是演练模式（STELLAR_POWER_DRY=1），不会真的睡眠。');
  hint.push('保存后立刻写计划任务；到点整台电脑睡眠，断网、远程连接会中断。');
  if (el('powerHint')) el('powerHint').textContent = hint.join(' ');
  ['powerEnabled', 'powerSleepAt', 'powerWakeAt', 'powerMode', 'powerSave'].forEach(function (id) {
    var n = el(id);
    if (n) n.disabled = !POWER.canWrite;
  });
  if (el('powerNow')) {
    el('powerNow').disabled = !POWER.canWrite;
    el('powerNow').textContent = '现在' + powerModeLabel((el('powerMode') && el('powerMode').value) || p.mode);
  }
  if (el('powerMsg') && !POWER.canWrite) el('powerMsg').textContent = '公网只读：只能看，不能改电源计划';
}

function loadPower() {
  return api('/api/power').then(function (d) { renderPower(d); return d; })
    .catch(function (e) {
      if (el('powerState')) el('powerState').textContent = '读取失败';
      if (el('powerHint')) el('powerHint').textContent = e.message;
    });
}

function powerPayload() {
  return {
    enabled: !!(el('powerEnabled') && el('powerEnabled').checked),
    sleepAt: String((el('powerSleepAt') && el('powerSleepAt').value) || ''),
    wakeAt: String((el('powerWakeAt') && el('powerWakeAt').value) || ''),
    mode: String((el('powerMode') && el('powerMode').value) || 'sleep')
  };
}

function savePower() {
  if (!POWER.canWrite) return setMsg(el('powerMsg'), '公网只能看，不能改', false);
  var body = powerPayload();
  if (!body.enabled && POWER.plan && POWER.plan.enabled) {
    if (!confirm('关掉夜间电源会删除「睡眠」和「唤醒」两个计划任务。确定？')) return;
  }
  if (body.mode === 'hibernate' && POWER.capabilities && !POWER.capabilities.hibernate) {
    return setMsg(el('powerMsg'), '这台电脑的休眠没启用，先选「睡眠」', false);
  }
  setMsg(el('powerMsg'), '保存中…');
  api('/api/power', { method: 'POST', body: JSON.stringify(body), timeoutMs: 45000 }).then(function (d) {
    renderPower(d);
    setMsg(el('powerMsg'), body.enabled
      ? ('已启用：每天 ' + body.sleepAt + ' ' + powerModeLabel(body.mode) + '，' + body.wakeAt + ' 唤醒')
      : '已关闭夜间电源', true);
  }).catch(function (e) { setMsg(el('powerMsg'), e.message, false); });
}

function powerNow() {
  if (!POWER.canWrite) return setMsg(el('powerMsg'), '公网只能看，不能操作', false);
  var mode = String((el('powerMode') && el('powerMode').value) || 'sleep');
  if (mode === 'hibernate' && POWER.capabilities && !POWER.capabilities.hibernate) {
    return setMsg(el('powerMsg'), '这台电脑的休眠没启用，先选「睡眠」', false);
  }
  if (!confirm('电脑会在 3 秒后进入' + powerModeLabel(mode) + '，网络和远程连接会立刻断开。\n\n确定现在' + powerModeLabel(mode) + '？')) return;
  setMsg(el('powerMsg'), '安排中…');
  api('/api/power/now', { method: 'POST', body: JSON.stringify({ mode: mode }), timeoutMs: 30000 }).then(function (d) {
    setMsg(el('powerMsg'), d.message || ('3 秒后进入' + powerModeLabel(mode)), true);
  }).catch(function (e) { setMsg(el('powerMsg'), e.message, false); });
}

if (el('powerSave')) el('powerSave').onclick = savePower;
if (el('powerNow')) el('powerNow').onclick = powerNow;
if (el('powerMode')) el('powerMode').onchange = function () {
  if (el('powerNow')) el('powerNow').textContent = '现在' + powerModeLabel(el('powerMode').value);
};
