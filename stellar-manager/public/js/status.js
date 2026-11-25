/* // 概览与运行：生物钟窗口、今日计划、说说与开关回填、页脚路径、/api/status 汇总 */
function winRow(w, idx) {
  var row = document.createElement('div');
  row.className = 'win';
  var n = document.createElement('span');
  n.textContent = 'W' + (idx + 1);
  row.appendChild(n);
  ['start', 'end'].forEach(function (key) {
    var inp = document.createElement('input');
    inp.value = w[key] || '';
    inp.placeholder = key === 'start' ? '06:00' : '10:00';
    inp.dataset.key = key;
    inp.className = 'win-' + key;
    row.appendChild(inp);
  });
  var wakes = document.createElement('input');
  wakes.type = 'number'; wakes.min = '0'; wakes.max = '4';
  wakes.value = w.wakes === undefined ? 1 : w.wakes;
  wakes.className = 'win-wakes';
  row.appendChild(wakes);
  var del = document.createElement('button');
  del.textContent = '×';
  del.title = '删除该窗口';
  del.onclick = function () { row.remove(); };
  row.appendChild(del);
  return row;
}

function renderWindows(night) {
  var box = el('windows');
  box.textContent = '';
  var wins = Array.isArray(night.windows) ? night.windows : [];
  wins.forEach(function (w, i) { box.appendChild(winRow(w, i)); });
  var add = document.createElement('button');
  add.textContent = '+ 增加窗口';
  add.onclick = function () { box.insertBefore(winRow({ start: '20:00', end: '23:00', wakes: 1 }, box.querySelectorAll('.win').length), box.lastChild); };
  box.appendChild(add);
  el('videoTarget').value = night.videoTargetPerDay === undefined ? 40 : night.videoTargetPerDay;
  el('maxWakes').value = night.maxWakesPerDay === undefined ? 6 : night.maxWakesPerDay;
  el('skipChance').value = night.skipChance === undefined ? 0.05 : night.skipChance;
  el('minGap').value = night.minGapMin === undefined ? 30 : night.minGapMin;
  el('frames').value = night.frames === 'auto' ? 'auto' : 'none';
}

function renderPricing(s) {
  var b = el('clockTier');
  if (!b) return;
  var p = s.pricing || {};
  b.textContent = p.label || '';
  b.className = 'tier ' + (p.peak ? 'peak' : 'off');
  b.title = p.peak ? '现在是峰时：DSH 那边不会叫醒她' : '现在是谷期：叫醒最便宜';
}

function renderSlots(whale) {
  var box = el('slots');
  box.textContent = '';
  if (!whale.slots.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '今天还没有排计划（到窗口内会自动生成，也可以点下面"重排今日计划"）。';
    box.appendChild(p);
    return;
  }
  var sum = document.createElement('p');
  sum.className = 'muted';
  sum.textContent = '今天计划醒 ' + whale.wakeSlots + ' 次，每次约 ' + whale.perWake + ' 条，合计约 ' + (whale.wakeSlots * whale.perWake) + ' 条 · 已完成 ' + whale.doneWakes + ' 次';
  box.appendChild(sum);
  whale.slots.forEach(function (s) {
    var row = document.createElement('div');
    row.className = 'slot ' + (s.status === 'done' ? 'done' : '') + (s.action === 'wake' ? ' wake' : '');
    var a = document.createElement('span'); a.textContent = s.atText || '';
    var b = document.createElement('span'); b.className = 's-action'; b.textContent = (s.action === 'wake' ? '醒来看 ' + whale.maxVideos + ' 条' : s.action === 'skip' ? '跳过（加餐）' : '计划');
    var c = document.createElement('span'); c.className = 'status'; c.textContent = s.status === 'done' ? '已完成' : s.status === 'pending' ? '等待' : (s.status || '');
    var d = document.createElement('span'); d.className = 'status'; d.textContent = s.window || '';
    row.appendChild(a); row.appendChild(b); row.appendChild(c); row.appendChild(d);
    if (s.peak) {
      row.classList.add('peak');
      var t = document.createElement('span'); t.className = 'status peak-tag'; t.textContent = '峰时';
      t.title = '这一趟排在峰时（单价 ×2），DSH 会等到谷期才叫醒（或直接跳过）';
      row.appendChild(t);
    }
    box.appendChild(row);
  });
}

function renderQzone(s) {
  var q = s.config.qzone || {};
  // 回退值必须跟 bili.config.json 的默认（qzone.weekly.min = 7）一致，否则配置缺字段时又显示成旧数字
  var min = q.weekly && q.weekly.min ? q.weekly.min : 7;
  var count = s.qzone.weekCount;
  el('weekBar').style.width = Math.min(100, Math.round(count / min * 100)) + '%';
  el('weekText').textContent = '本周 ' + count + ' / ' + min + ' 条（本周目标）· 今天 ' + s.qzone.todayCount + ' 条（每日上限 ' + (q.dailyLimit || 2) + '）';
  // 标题上的提示原来写死「每周至少 3 条」，配置改成 5 之后就对不上了
  if (el('weekHint')) el('weekHint').textContent = '每周至少 ' + min + ' 条';
  var last = s.qzone.last;
  el('lastPost').textContent = last ? ('最近：' + (last.text || '(无正文)') + ' · ' + new Date(last.at).toLocaleString()) : '还没有发过说说';
  el('weeklyMin').value = min;
  el('dailyLimit').value = q.dailyLimit || 2;
}

function renderPaths(s) {
  el('paths').textContent = '配置 ' + s.paths.config + ' · 插件 ' + s.paths.repo + ' · 面板端口 ' + (s.panelPort || location.port || '3300');
}

var PENDING_PHASES = { requested: '等待重启脚本接手…', stopping: '正在关闭 DSH…', stopped: '等新进程启动…', launched: '等界面端口响应…' };
var restartPollTimer = null;

function fmtClock(ts) {
  try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { return ''; }
}

function scheduleRestartPoll(pending) {
  if (restartPollTimer) { clearTimeout(restartPollTimer); restartPollTimer = null; }
  if (!pending) return;
  restartPollTimer = setTimeout(function () { restartPollTimer = null; loadStatus(); }, 2000);
}

function renderDshRestart(s) {
  var box = document.getElementById('dshMsg');
  if (!box) return;
  var r = s.dsh && s.dsh.restart;
  var running = s.dshRunning;
  box.className = 'msg restart-box';
  if (!r || r.phase === 'idle') {
    box.textContent = running ? '' : 'DSH 当前没在运行。';
    scheduleRestartPoll(false);
    return;
  }
  var pending = !!PENDING_PHASES[r.phase];
  var at = fmtClock(r.at);
  var head, cls, hint = '';
  if (pending) {
    cls = 'busy';
    head = '<span class="rdot busy"></span><b>重启进行中</b><span class="rw">' + at + ' 点的 · 已等 ' + Math.round(r.ageMs / 1000) + ' 秒</span>';
    hint = '面板、SnowLuma、桥接不受影响，手机上这个页面不会断；每 2 秒自动刷新一次进度。';
  } else if (r.phase === 'unknown') {
    cls = 'busy';
    head = '<span class="rdot busy"></span><b>上次重启结果没记录到</b><span class="rw">' + at + ' 点的 · 旧版本没留步骤</span>';
    hint = '控制台正在按现在的进程补全记录，几秒后刷新；现在 DSH ' + (running ? '在运行' : '没在运行') + '。想要完整过程就再点一次「重启 DSH」。';
  } else if (r.phase === 'ok') {
    cls = 'ok';
    var secs = Math.round((r.durationMs || 0) / 1000);
    var took = r.legacy ? ' · 旧版本补全的记录' : (r.reconciled ? ' · 当时没跟完，复查补记' : ' · 用时 ' + secs + ' 秒');
    head = '<span class="rdot ok"></span><b>重启成功</b><span class="rw">' + at + ' 点的' + took + ' · 界面进程 pid ' + (r.pid || '?') + '</span>';
    hint = (r.note ? '<span class="rnote-inline">' + r.note + '</span><br>' : '') + '新界面：' + (r.url ? '<a href="' + r.url + '" target="_blank" rel="noopener">' + r.url + '</a>' : '（端口未知）') + '。窗口没弹出来就双击桌面的 DeepSeek Harness；页面地址变了是正常的，每次重启都会换端口。';
  } else {
    cls = 'fail';
    head = '<span class="rdot fail"></span><b>这次重启没成功</b><span class="rw">' + at + ' 点的</span>';
    hint = (r.reason || '原因不明') + '　当前 DSH ' + (running ? '还在运行' : '没在运行') + '。可以再点一次「重启 DSH」；还不行就看 日志 → 守护。';
  }
  var html = '<div class="rhead ' + cls + '">' + head + '</div>';
  var steps = Array.isArray(r.steps) ? r.steps : [];
  if (r.phase === 'ok') steps = steps.filter(function (st) { return st.key !== 'fail'; });
  if (steps.length) {
    html += '<ol class="rsteps">';
    steps.forEach(function (st) {
      var k = st.key === 'fail' ? 'bad' : 'ok';
      html += '<li class="' + k + '"><time>' + fmtClock(st.t) + '</time>' + String(st.text || '') + '</li>';
    });
    if (pending) {
      html += '<li class="wait"><time>…</time>' + (PENDING_PHASES[r.phase] || '进行中…') + '</li>';
    }
    html += '</ol>';
  }
  if (r.problems && r.problems.length) {
    html += '<div class="rnote">脚本拉起方式有告警：' + r.problems.join('；') + '</div>';
  }
  html += '<div class="rhint">' + hint + '</div>';
  box.innerHTML = html;
  scheduleRestartPoll(pending || r.phase === 'unknown');
}

/* 重启时机：现在合不合适、大概多少钱、什么时候最划算（后端 lib/restart-advice.js） */
function renderRestartAdvice(s) {
  var box = el('restartAdvice');
  if (!box) return;
  var a = s.restartAdvice;
  if (!a || a.ok === false) { box.style.display = 'none'; return; }
  box.style.display = '';
  var level = a.level || 'ok';
  box.className = 'rada ' + level;
  var dot = level === 'ok' ? 'ok' : level === 'busy' ? 'fail' : level === 'off' ? '' : 'busy';
  box.textContent = '';
  var head = document.createElement('div');
  head.className = 'rada-head';
  var d = document.createElement('span');
  d.className = 'rdot ' + dot;
  head.appendChild(d);
  var b = document.createElement('b');
  b.textContent = a.headline || '';
  head.appendChild(b);
  var w = document.createElement('span');
  w.className = 'rw';
  w.textContent = a.bestText || '';
  head.appendChild(w);
  box.appendChild(head);
  var body = document.createElement('div');
  body.className = 'rada-body';
  body.textContent = a.detail || '';
  box.appendChild(body);
  var btn = el('actRestartDsh');
  if (btn) btn.title = (a.headline || '') + ' · ' + (a.bestText || '') + ' · 预计 ' + (a.costYuan != null ? '¥' + a.costYuan : '—');
  var list = Array.isArray(a.reasons) ? a.reasons : [];
  if (list.length) {
    var ul = document.createElement('ul');
    ul.className = 'rada-list';
    list.forEach(function (r) {
      var li = document.createElement('li');
      li.textContent = String(r);
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
}

// 紧急停止横幅：手动停，**不再自动恢复**（owner 2026-11-11 22:25 废掉 24 小时自动恢复；
// 三档运行模式是在这条停止之上叠加的调节，不会替你解除停止）
function renderStop(s) {
  var box = el('stopBanner');
  if (!box) return;
  var st = s.stop || {};
  document.body.classList.toggle('is-stopped', !!st.active);
  var onBtn = el('actStop');
  var offBtn = el('actResume');
  if (st.active) {
    box.hidden = false;
    box.className = 'stop-banner on';
    box.textContent = '已紧急停止：她不再自动醒来，也不再发任何消息、说说、动态、评论。点「恢复运行」才会解除。'
      + (st.reason ? ' 原因：' + st.reason : '');
    if (onBtn) onBtn.disabled = true;
    if (offBtn) offBtn.disabled = false;
  } else {
    box.hidden = true;
    box.textContent = '';
    if (onBtn) onBtn.disabled = false;
    if (offBtn) offBtn.disabled = true;
    var m = el('stopMsg');
    if (m && st.clearedAt) m.textContent = '上次停止于 ' + new Date(st.clearedAt).toLocaleString('zh-CN', { hour12: false }) + ' 恢复';
  }
}

// 生图额度（3 张 / 10 分钟，超出要主人批）
function renderImageBudget(s) {
  var m = el('stopMsg');
  if (!m) return;
  var b = s.imageBudget || {};
  if (!b.limit) return;
  var text = '生图额度：最近 10 分钟 ' + (b.used || 0) + '/' + b.limit + ' 张'
    + (b.approved ? ' · 有 ' + b.approved + ' 次已批待用' : '')
    + (b.pending ? ' · 有 ' + b.pending + ' 条等她请示主人' : '');
  var st = s.stop || {};
  if (!st.active) m.textContent = text;
  else m.textContent = text + '（停止状态下不生图）';
}

var NOW_ICON = { chat: '聊', wait: '等', bili: 'B', qzone: '空', dynamic: '动', image: '画', report: '报', read: '读', search: '查', memory: '忆', audit: '查', sleep: '眠', idle: '闲', wake: '醒', town: '镇', other: '忙' };

function renderActivity(s) {
  var a = (s && s.activity) || {};
  var label = a.label || '待机';
  var detail = a.detail || '';
  if (el('herNow')) {
    // 侧栏顶部已经有一行状态（herLabel），这里只在「跟她状态不一样」时才补一句，
    // 否则两行都写「休眠中」，读起来像卡住了。没有 detail 就留空、靠 CSS 收成 0 高。
    var same = false;
    if (el('herLabel')) same = (el('herLabel').textContent || '').trim() === label;
    var extra = a.targetName && a.kind !== 'bili' && a.kind !== 'sleep' ? ' · ' + a.targetName : '';
    var line = same ? (detail ? String(detail).slice(0, 46) : '') : (label + extra);
    el('herNow').textContent = line;
    el('herNow').className = 'her-now' + (a.active ? ' active' : '');
  }
  if (!el('nowLabel')) return;
  el('nowLabel').textContent = label;
  el('nowDetail').textContent = detail || '没什么动静';
  // 回合还没收尾时，「最近动作 X 分钟前」是废话——要给的是「已经在里面多久 + 大概什么时候出来」，
  // 主人就是靠这一行决定什么时候能安全重启 DSH。
  el('nowAgo').textContent = a.turn
    ? ('已跑 ' + (a.turn.elapsedText || '—') + (a.turn.etaText ? ' · ' + a.turn.etaText : ''))
    : (a.ago ? ('最近动作 ' + a.ago) : '');
  el('nowIcon').textContent = NOW_ICON[a.kind] || '忙';
  el('nowIcon').className = 'now-icon kind-' + (a.kind || 'idle');
  var n = a.next;
  el('nowNext').textContent = n ? (n.atText || n.label) : '今天没有排计划';
  el('nowNextHint').textContent = n
    ? ((n.inMin > 0 ? (n.inMin + ' 分钟后') : '已过点，等补跑') + (n.maxVideos ? ' · 约 ' + n.maxVideos + ' 条' : ''))
    : '';
  var box = el('nowRecent');
  box.textContent = '';
  var recent = a.recent || [];
  if (!recent.length) { box.appendChild(document.createTextNode('还没有动作记录。')); }
  recent.forEach(function (r) {
    var row = document.createElement('span');
    row.className = 'now-chip';
    row.textContent = r.label + (r.targetName ? ' · ' + r.targetName : '') + ' · ' + r.ago;
    box.appendChild(row);
  });
  if (el('nowMsg')) { el('nowMsg').textContent = ''; el('nowMsg').className = 'msg'; }
}
if (el('nowRefresh')) el('nowRefresh').onclick = function () { loadStatus(); };


// DSH 桌面端 Cookie 守卫（431 坑）：只在 DSH 退出时清理，这里是它最近一次的结果。
function renderCookieGuard(api) {
  const el = document.getElementById('cookieGuardLine')
  if (!el) return
  const g = api && api.cookieGuard
  if (!g || !g.at) {
    el.textContent = 'Cookie 守卫：还没有运行记录（DSH 退出时守护会自动清一次）'
    return
  }
  const when = new Date(g.at)
  const stamp = Number.isNaN(when.getTime()) ? g.at : when.toLocaleString('zh-CN', { hour12: false })
  const size = g.after && g.after.bytes !== undefined ? g.after.bytes : g.before && g.before.bytes !== undefined ? g.before.bytes : g.info && g.info.bytes
  const tail = size !== undefined ? ' · 现在约 ' + Math.round(size / 1024 * 10) / 10 + ' KB 请求头' : ''
  let text
  if (g.action === 'prune' && g.deleted !== undefined) text = 'Cookie 守卫：' + stamp + ' 清掉 ' + g.deleted + ' 条旧登录 Cookie' + tail
  else if (g.skipped === 'locked') text = 'Cookie 守卫：' + stamp + ' 想清但 DSH 正开着（库被独占），等下次退出再清'
  else if (g.skipped === 'below-threshold') text = 'Cookie 守卫：' + stamp + ' 检查过，还没到阈值，不用清' + tail
  else if (g.action === 'restore') text = 'Cookie 守卫：' + stamp + ' 从备份还原过'
  else text = 'Cookie 守卫：' + stamp + ' ' + (g.skipped || g.action || '')
  el.textContent = text
}

// 公网来源能做什么：别的快捷操作都会 403，只有「重启 DSH」是故意放行的。
// 这一句就是那件事的说明书，顺便把按钮的可点状态跟它对齐（别让人点了才发现被拒）。
function renderScopeNote(s) {
  var box = el('actScopeNote');
  if (!box) return;
  var scope = (s.access && s.access.scope) || 'local';
  var btn = el('actRestartDsh');
  if (scope !== 'public') {
    box.textContent = '';
    if (btn) btn.title = '';
    return;
  }
  var canRestart = !s.access || s.access.canRestartDsh !== false;
  var stop = s.stop && s.stop.active;
  box.textContent = '你正从公网访问：除了「重启 DSH」，其他快捷操作在这里都会被拒（只读）。'
    + (canRestart ? '' : '这个版本的控制台还没允许公网重启，需要在电脑上更新面板。')
    + (stop ? '注意：现在处于紧急停止状态，重启不会解除它。' : '')
    + ' 重启不会中断手机上的这个页面，进度会实时显示。'
  if (btn) btn.title = canRestart ? '公网也允许：60 秒内只能重启一次' : '当前面板版本不允许公网重启';
}

function loadStatus() {
  return api('/api/status').then(function (s) {
    state.status = s;
    renderPills(s);
    renderHer(s);
    renderActivity(s);
    renderStop(s)
  renderCookieGuard(s);
    renderImageBudget(s);
    if (!dirty.clock) renderWindows(s.config.night || {});
    renderPricing(s);
  renderSlots(s.whale);
    if (!dirty.clock) renderQzone(s);
    renderPaths(s);
    renderAccess(s.access);
    renderScopeNote(s);
    renderDshRestart(s);
    renderRestartAdvice(s);
  }).catch(function (e) { console.error(e); });
}
