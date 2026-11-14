/* // 她的状态卡（renderHer）：从旧的 memory.js 抽出来独立成文件。
   status.js 的 renderActivity() 会调用 renderHer(s)，所以它不能跟旧记忆卡一起删。
   依赖 core.js 的 el / fmtAgo / fmtTime / prettyKey / stateLabel（全局函数，本文件不再定义）。 */
// ── 她的状态（在线 / 休眠 · 情绪 · 在做什么） ───────────────────────────────
function renderHer(s) {
  var h = (s && s.her) || {};
  var cls = h.state || 'unknown';
  ['herDot', 'herDot2'].forEach(function (id) {
    var d = el(id);
    if (d) d.className = 'her-dot ' + cls;
  });
  var label = h.label || (h.ok ? '—' : '读不到状态');
  if (el('herLabel')) el('herLabel').textContent = label;
  if (el('herSub')) el('herSub').textContent = h.key ? h.key.replace('private:', '私聊 ') : (h.lastActive ? '最近活跃 ' + fmtAgo(h.lastActive) : '还没有消息');

  var emo = h.emotion || {};
  var emoText = emo.label || emo.text || '';
  if (el('herEmotion')) el('herEmotion').textContent = emoText ? '情绪 · ' + emoText : '';

  if (el('herState')) el('herState').textContent = label;
  if (el('herSince')) {
    var bits = [];
    if (h.since) bits.push('这一轮自 ' + fmtTime(h.since));
    if (h.lastActive) bits.push('最近说话 ' + fmtAgo(h.lastActive));
    if (h.turns) bits.push('累计 ' + h.turns + ' 轮');
    el('herSince').textContent = bits.length ? bits.join(' · ') : '还没有状态记录';
  }
  if (el('herMood')) {
    el('herMood').textContent = emoText
      ? ('最近情绪：' + emoText + (emo.at ? '（' + fmtAgo(emo.at) + '）' : ''))
      : (h.ok ? '还没有情绪记录' : '—');
  }

  var pur = h.purpose || {};
  if (el('herPurpose')) el('herPurpose').textContent = pur.text ? String(pur.text).slice(0, 90) : '暂时没有在想什么';
  if (el('herPurposeAt')) el('herPurposeAt').textContent = pur.at ? fmtAgo(pur.at) : '';

  var whale = (s && s.whale) || {};
  var allSlots = Array.isArray(whale.slots) ? whale.slots : [];
  var wakeSlots = allSlots.filter(function (x) { return x.action === 'wake'; });
  var doneWakes = wakeSlots.filter(function (x) { return x.status === 'fired'; }).length;
  var perWake = Number(whale.maxVideos || 0);
  if (el('herWakes')) {
    el('herWakes').textContent = wakeSlots.length ? (doneWakes + ' / ' + wakeSlots.length + ' 次') : (whale.wakes ? whale.wakes + ' 次' : '—');
  }
  if (el('herWakesHint')) {
    el('herWakesHint').textContent = wakeSlots.length
      ? ('每次约 ' + (perWake || '?') + ' 条 · 今天计划 ' + (wakeSlots.length * (perWake || 0) || '?') + ' 条')
      : '今天还没排计划';
  }

  var pend = pur.pending || [];
  if (el('herPending')) el('herPending').textContent = pend.length ? (pend.length + ' 件 · ' + String(pend[0].text || pend[0].title || '').slice(0, 40)) : '没有惦记的事';

  var c = h.counts || {};
  if (el('herCounts')) el('herCounts').textContent = '活跃 ' + (c.ACTIVE || 0) + ' · 冷却 ' + (c.COOLDOWN || 0) + ' · 待机 ' + (c.LISTEN || 0) + ' · 休眠 ' + (c.SLEEP || 0);

  if (el('herNote')) {
    var convs = h.conversations || [];
    el('herNote').textContent = convs.length
      ? convs.slice(0, 3).map(function (x) { return prettyKey(x.key) + ' · ' + stateLabel(x.state) + ' · 最近 ' + fmtAgo(x.lastActive) + ' · ' + (x.turns || 0) + ' 轮'; }).join(' ｜ ')
      : '还没收到过消息，等她醒来说第一句话。';
  }
  if (el('herMsg')) { el('herMsg').textContent = ''; el('herMsg').className = 'msg'; }
}
if (el('herRefresh')) el('herRefresh').onclick = function () { loadStatus(); };
