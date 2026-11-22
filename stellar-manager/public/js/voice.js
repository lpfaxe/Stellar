/* // 说话方式（鱼八股）：编辑她每轮唤醒都会看到的「原则 + 词条」。
 * 数据走 /api/voice-style（后端 stellar-manager/lib/voice-style.js），落 <DSH_HOME>/stellar/state/voice-style.json。
 * 预览那段由后端用仓库里 src/voice-style.js 渲染 —— 前端不自己拼，否则「面板显示 A、她看到 B」。
 * 用户输入一律 input.value / textContent，不拼 innerHTML（词条里放 <img onerror> 一样能打）。
 */
var VOICE = { style: null, stats: null, rendered: null, limits: { maxChars: 600 }, dirty: false };

function voiceMsg(text, ok) {
  var n = el('voiceMsg');
  if (n) setMsg(n, text, ok);
}

// 后端失败时带 errors[]（逐行说哪一条不对）或 message；两种都要原样给主人看，不能吞。
function voiceErrText(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.errors && data.errors.length) return data.errors.join('；');
  return String(data.message || data.error || '');
}

function voiceFetch(path, opts) {
  var o = opts || {};
  var init = { method: o.method || 'GET', credentials: 'same-origin', headers: o.headers || {} };
  if (o.body != null) init.body = o.body;
  return fetch(path, init).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.status === 401) {
        // 会话过期：跟 core.js 的 api() 一样重新走一遍 gate，别把「需要口令」当普通报错挂在卡片上
        if (!window.__panelRelogin) { window.__panelRelogin = true; location.reload(); }
        throw new Error('需要口令，正在重新打开登录页');
      }
      if (!res.ok) {
        var e = new Error(voiceErrText(data) || ('HTTP ' + res.status));
        e.payload = data;
        throw e;
      }
      return data;
    });
  });
}

function voicePost(path, payload) {
  return voiceFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-request': 'panel' },
    body: JSON.stringify(payload || {}),
  });
}

function voiceStyle() {
  return VOICE.style || { enabled: true, stats: true, maxChars: 600, principles: [], entries: [] };
}

function voiceSetChecked(id, on) {
  var n = el(id);
  if (n) n.checked = !!on;
}

function voiceApply(payload) {
  VOICE.style = payload.style || null;
  VOICE.rendered = payload.rendered || null;
  VOICE.stats = payload.stats || null;
  VOICE.limits = payload.limits || VOICE.limits;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
function voiceMakeInput(kind, maxLen, placeholder, value) {
  var input = document.createElement('input');
  input.className = 'voice-in';
  input.setAttribute('data-kind', kind);
  input.setAttribute('maxlength', String(maxLen));
  input.type = 'text';
  if (placeholder) input.setAttribute('placeholder', placeholder);
  input.value = value == null ? '' : String(value);
  return input;
}

function voiceDelButton(kind, index) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost small';
  b.setAttribute('data-del', kind);
  b.setAttribute('data-i', String(index));
  b.textContent = '删';
  return b;
}

function voiceAppendPrinciple(value) {
  var box = el('voicePrinciples');
  if (!box) return null;
  var row = document.createElement('div');
  row.className = 'voice-row';
  var input = voiceMakeInput('principle', 120, '一句原则（最多 120 字）', value);
  row.appendChild(input);
  row.appendChild(voiceDelButton('principle', box.children.length));
  box.appendChild(row);
  return input;
}

function voiceAppendEntry(entry) {
  var box = el('voiceEntries');
  if (!box) return null;
  var row = document.createElement('div');
  row.className = 'voice-row';
  var from = voiceMakeInput('from', 40, '她常说的（原句）', entry && entry.from);
  var arrow = document.createElement('span');
  arrow.className = 'voice-arrow';
  arrow.textContent = '→';
  var to = voiceMakeInput('to', 160, '换成（多个用 / 隔开）', entry && entry.to ? entry.to.join(' / ') : '');
  row.appendChild(from);
  row.appendChild(arrow);
  row.appendChild(to);
  row.appendChild(voiceDelButton('entry', box.children.length));
  box.appendChild(row);
  return from;
}

function voiceRenderStats() {
  var box = el('voiceStatsRow');
  if (!box) return;
  var st = VOICE.stats || {};
  var span = document.createElement('span');
  span.className = 'muted small';
  if (voiceStyle().stats === false) {
    span.textContent = '统计已关';
  } else {
    span.textContent = '今天：发 ' + (Number(st.messages) || 0) + ' 条 · 破折号 ' + (Number(st.emDash) || 0) +
      ' · 三点列举 ' + (Number(st.enum3) || 0) + ' · 客服腔 ' + (Number(st.serviceWord) || 0) +
      ' · 撞上原句 ' + (Number(st.entryHit) || 0) + ' · 用上改法 ' + (Number(st.entryFollow) || 0);
  }
  box.textContent = '';
  box.appendChild(span);
}

function voiceRenderMeter() {
  var style = voiceStyle();
  var maxChars = Number(style.maxChars) || Number(VOICE.limits.maxChars) || 600;
  var used = Number(VOICE.rendered && VOICE.rendered.chars) || 0;
  var over = used > maxChars;
  var meter = document.querySelector('.voice-meter');
  if (meter) meter.classList.toggle('over', over);
  var bar = el('voiceMeterBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, maxChars ? (used / maxChars) * 100 : 0)) + '%';
  var label = el('voiceChars');
  if (!label) return;
  if (VOICE.dirty) { label.textContent = '改了未保存'; return; }
  var text = used + ' / ' + maxChars + ' 字';
  if (over) text += '，超了 ' + (used - maxChars) + ' 字，超出部分她看不到';
  else if (VOICE.rendered && VOICE.rendered.truncated) text += '（有 ' + (Number(VOICE.rendered.droppedLines) || 0) + ' 行放不下，她看不到）';
  label.textContent = text;
}

function renderVoice() {
  var style = voiceStyle();
  VOICE.dirty = false;
  voiceSetChecked('voiceEnabled', style.enabled !== false);
  voiceSetChecked('voiceStats', style.stats !== false);

  voiceRenderStats();

  var pbox = el('voicePrinciples');
  if (pbox) {
    pbox.textContent = '';
    var principles = style.principles || [];
    for (var i = 0; i < principles.length; i++) voiceAppendPrinciple(principles[i]);
  }
  var ebox = el('voiceEntries');
  if (ebox) {
    ebox.textContent = '';
    var entries = style.entries || [];
    for (var j = 0; j < entries.length; j++) voiceAppendEntry(entries[j]);
  }

  voiceRenderMeter();
  var preview = el('voicePreview');
  if (preview) preview.textContent = (VOICE.rendered && VOICE.rendered.text) || '';
}

function voiceMarkDirty() {
  VOICE.dirty = true;
  voiceRenderMeter();
}

// ── 读回 DOM（编辑结果）────────────────────────────────────────────────────
function voiceCollect() {
  var principles = [];
  var pbox = el('voicePrinciples');
  if (pbox) {
    var pins = pbox.querySelectorAll('input[data-kind="principle"]');
    for (var i = 0; i < pins.length; i++) {
      var line = String(pins[i].value || '').trim();
      if (line) principles.push(line);
    }
  }
  var entries = [];
  var ebox = el('voiceEntries');
  if (ebox) {
    var rows = ebox.querySelectorAll('.voice-row');
    for (var j = 0; j < rows.length; j++) {
      var fromNode = rows[j].querySelector('input[data-kind="from"]');
      var toNode = rows[j].querySelector('input[data-kind="to"]');
      var from = fromNode ? String(fromNode.value || '').trim() : '';
      if (!from) continue;
      var to = [];
      if (toNode) {
        var parts = String(toNode.value || '').split('/');
        for (var k = 0; k < parts.length; k++) {
          var one = String(parts[k] || '').trim();
          if (one && to.indexOf(one) < 0) to.push(one);
        }
      }
      entries.push({ from: from, to: to });
    }
  }
  return {
    enabled: el('voiceEnabled') ? !!el('voiceEnabled').checked : true,
    stats: el('voiceStats') ? !!el('voiceStats').checked : true,
    maxChars: Number(voiceStyle().maxChars) || Number(VOICE.limits.maxChars) || 600,
    principles: principles,
    entries: entries,
  };
}

// ── 接口 ────────────────────────────────────────────────────────────────────
function loadVoiceCard() {
  return voiceFetch('/api/voice-style').then(function (r) {
    if (!r || r.ok !== true) {
      voiceMsg(String((r && r.message) || '读不到说话方式'), false);
      return r;
    }
    voiceApply(r);
    renderVoice();
    // hint 是「还没有文件」这类中性提示，不当失败
    voiceMsg(String(r.hint || ''), null);
    return r;
  }).catch(function (e) {
    voiceMsg('读不到说话方式：' + String((e && e.message) || e), false);
    return null;
  });
}

function saveVoice() {
  var body = voiceCollect();
  voiceMsg('保存中…');
  return voicePost('/api/voice-style', body).then(function (r) {
    if (!r || r.ok !== true) {
      var e = new Error(voiceErrText(r) || '没保存上');
      e.payload = r;
      throw e;
    }
    voiceApply(r);
    renderVoice();
    voiceMsg('已保存，她下一轮就用新的', true);
    return r;
  }).catch(function (e) {
    // 校验没过时后端会把「哪一条不对」放在 errors[] 里，逐条摊开，别只说「保存失败」
    var text = voiceErrText(e && e.payload) || String((e && e.message) || e);
    voiceMsg('没保存上：' + text, false);
    return null;
  });
}

function restoreVoice() {
  if (!window.confirm('回滚到上一版？现在这份会被记成一次备份')) return null;
  voiceMsg('回滚中…');
  return voicePost('/api/voice-style/restore', {}).then(function (r) {
    if (!r || r.ok !== true) {
      var e = new Error(voiceErrText(r) || '没回滚上');
      e.payload = r;
      throw e;
    }
    voiceApply(r);
    renderVoice();
    voiceMsg('已回滚到 ' + String(r.restored || '上一版'), true);
    return r;
  }).catch(function (e) {
    voiceMsg('没回滚上：' + (voiceErrText(e && e.payload) || String((e && e.message) || e)), false);
    return null;
  });
}

// ── 绑定 ────────────────────────────────────────────────────────────────────
function voiceDelegatedClick(ev) {
  var t = ev.target;
  if (!t || !t.getAttribute) return;
  if (!t.getAttribute('data-del')) return;
  var row = t.parentNode;
  if (!row || String(row.className || '').indexOf('voice-row') < 0) return;
  if (row.parentNode) row.parentNode.removeChild(row);
  voiceMarkDirty();
}

function voiceBind() {
  if (el('voiceSave')) el('voiceSave').onclick = function () { saveVoice(); };
  if (el('voiceRestore')) el('voiceRestore').onclick = function () { restoreVoice(); };
  if (el('voiceRefresh')) el('voiceRefresh').onclick = function () { voiceMsg('刷新中…'); loadVoiceCard(); };

  if (el('voiceAddPrinciple')) el('voiceAddPrinciple').onclick = function () {
    var input = voiceAppendPrinciple('');
    voiceMarkDirty();
    if (input) input.focus();
  };
  if (el('voiceAddEntry')) el('voiceAddEntry').onclick = function () {
    var input = voiceAppendEntry(null);
    voiceMarkDirty();
    if (input) input.focus();
  };

  var pbox = el('voicePrinciples');
  if (pbox) {
    pbox.addEventListener('click', voiceDelegatedClick);
    pbox.addEventListener('input', voiceMarkDirty);
  }
  var ebox = el('voiceEntries');
  if (ebox) {
    ebox.addEventListener('click', voiceDelegatedClick);
    ebox.addEventListener('input', voiceMarkDirty);
  }
  if (el('voiceEnabled')) el('voiceEnabled').addEventListener('change', voiceMarkDirty);
  if (el('voiceStats')) el('voiceStats').addEventListener('change', voiceMarkDirty);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', voiceBind);
else voiceBind();

window.loadVoiceCard = loadVoiceCard;
