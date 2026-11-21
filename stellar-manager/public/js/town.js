/* // 鱼缸小镇：她自己在那儿过日子，这个页面只读她的日子。
 * 数据来自 /api/town（后端 stellar-manager/lib/town.js）：一份 status.json 快照 +
 * town.db 里的 town_note（3 天）/ town_impression（30 天）/ town_day（长期）。
 * 唯一的写操作是「进小镇」开关 —— 它其实就是能力 town.enabled，落盘仍走 /api/capabilities。
 */
var TOWN = { data: null, cap: { enabled: false, mtime: 0 } };

function townEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function townClock(ms) {
  var d = new Date(Number(ms) || 0);
  if (!ms || isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function townYuan(v) {
  var n = Number(v);
  return isFinite(n) ? '¥' + n.toFixed(2) : '—';
}
function townMsg(text, ok) {
  var n = el('townMsg');
  if (n) setMsg(n, text, ok);
}

var TOWN_KIND = {
  visit: '来客',
  receipt: '开销',
  bond: '关系',
  play: '牌局',
  goto: '出门',
  turn: '有人搭话',
  activity: '动静',
};

function townRenderStats(d) {
  var box = el('townStats');
  if (!box) return;
  var snap = d.snapshot || {};
  var st = snap.status || {};
  var cells = [
    ['三天里的事', (d.counts && d.counts.notes) || 0, '件，过期自动删'],
    ['印象', (d.counts && d.counts.impressions) || 0, '个人，30 天'],
    ['每天一句', (d.counts && d.counts.days) || 0, '句，长期'],
    ['今天动过', (snap.actions && snap.actions.today) || 0, '次（上限 3）'],
    ['今天花费', townYuan(snap.budget && snap.budget.spent), '上限 ' + townYuan(snap.budget && snap.budget.cap)],
  ];
  box.innerHTML = cells.map(function (c) {
    return '<div class="memdb-cell"><span class="k">' + townEsc(c[0]) + '</span><b>' + townEsc(c[1]) + '</b><span class="hint">' + townEsc(c[2]) + '</span></div>';
  }).join('') + '<div class="muted small town-cost-note">这里的钱只算我们这一侧记的账；官方插件自己那半（它开的会话）在额度页的「小镇」里。</div>';
}

function townRenderMeta(d) {
  var box = el('townMeta');
  if (box) {
    var snap = d.snapshot || {};
    var pump = snap.pump || null;
    var bits = [];
    bits.push(d.hasDb ? '记忆库在 ' + d.dir : '还没有 town.db' + (d.notesReason ? '：' + d.notesReason : ''));
    bits.push(d.hasSnapshot ? '快照 ' + townClock(snap.at) : '还没有状态快照（调度器采集过才会有）');
    var plug = d.plugin || snap.plugin || null;
    if (pump) bits.push('进镇通道：' + (pump.connected ? '连着' : '没连上') + (pump.lastOkAt ? ' · 上次成功 ' + townClock(pump.lastOkAt) : ''));
    else if (plug && plug.installed && plug.takesTurns) bits.push('进镇通道：官方插件在挂着');
    if (plug && plug.installed) {
      bits.push('答题：官方插件' + (plug.version ? ' ' + plug.version : '') + (plug.takesTurns ? '（它挂着长轮询）' : '（这条鱼没接上）'));
      if (plug.hasFish && !plug.personaChars) bits.push('人设还没同步：镇上那个她只是分身，跑一次 scripts/town-plugin-sync.mjs');
    } else {
      bits.push('答题：我们自己（没装官方插件）');
    }
    box.innerHTML = '<div class="memdb-meta-row"><span class="muted small">' + bits.map(townEsc).join(' · ') + '</span></div>';
  }
  var at = el('townAt');
  if (at) at.textContent = d.snapshot ? '快照 ' + townClock(d.snapshot.at) : '';
}

function townRenderState(d) {
  var box = el('townState');
  if (!box) return;
  var snap = d.snapshot;
  var st = (snap && snap.status) || {};
  if (!snap) {
    box.innerHTML = '<div class="muted small">她还没进过镇，或者小镇关着 —— 开关打开后，第一次采集（约 1 分钟）就会有快照。</div>';
    return;
  }
  var online = st.online === true;
  var outside = String(st.outsideState || '');
  var outsideText = outside === 'in_town' ? '在镇里' : outside === 'not_connected' ? '没连上（长轮询没挂住）' : (outside || '—');
  var rows = [
    ['在线', online ? '在线' : '不在线'],
    ['位置', outsideText],
    ['名字', (st.name || '—') + (st.badge ? ' · ' + st.badge : '')],
    ['钱包', townYuan(st.piggyYuan)],
    ['喜欢玩', (st.games || []).slice(0, 8).join(' / ') || '—'],
  ];
  if (snap.errors && snap.errors.length) rows.push(['这次没读到', snap.errors.slice(0, 3).join('；')]);
  box.innerHTML = rows.map(function (r) {
    return '<div class="memdb-meta-row"><span class="muted small">' + townEsc(r[0]) + '</span><span class="small">' + townEsc(r[1]) + '</span></div>';
  }).join('');
}

function townRenderBonds(d) {
  var box = el('townBonds');
  if (!box) return;
  var b = (d.snapshot && d.snapshot.bonds) || {};
  var friends = b.friends || [];
  var bits = [];
  if (friends.length) {
    bits.push('<div class="memdb-meta-row"><span class="muted small">朋友</span><span class="small">' +
      friends.slice(0, 12).map(function (f) { if (typeof f === 'string') return townEsc(f); return townEsc(f.name || f.fish_id || '') + (f.warmth != null ? '（' + townEsc(f.warmth) + '）' : ''); }).join('、') +
      '</span></div>');
  }
  if (b.couple) bits.push('<div class="memdb-meta-row"><span class="muted small">心上鱼</span><span class="small">' + townEsc(typeof b.couple === 'string' ? b.couple : (b.couple.name || b.couple.fish_id || '')) + '</span></div>');
  if (b.crush) bits.push('<div class="memdb-meta-row"><span class="muted small">有点喜欢</span><span class="small">' + townEsc(typeof b.crush === 'string' ? b.crush : (b.crush.name || b.crush.fish_id || '')) + '</span></div>');
  if ((b.rivals || []).length) bits.push('<div class="memdb-meta-row"><span class="muted small">较劲的</span><span class="small">' + (b.rivals || []).map(function (r) { return townEsc(typeof r === 'string' ? r : (r.name || r.fish_id || '')); }).join('、') + '</span></div>');
  box.innerHTML = bits.join('') || '<span class="muted small">还没有记下谁。</span>';
}

function townRenderNotes(d) {
  var box = el('townNotes');
  if (!box) return;
  var notes = d.notes || [];
  if (!notes.length) {
    box.innerHTML = '<span class="muted small">' + townEsc(d.notesReason || '这三天镇上没发生什么。') + '</span>';
    return;
  }
  box.innerHTML = notes.map(function (n) {
    var kind = TOWN_KIND[n.kind] || n.kind || '事';
    return '<div class="memdb-job"><span class="pill">' + townEsc(kind) + '</span>' +
      '<span class="muted small">' + townEsc(n.day || '') + ' · ' + townEsc(n.who || '') + ' · ' + townClock(n.at) + '</span>' +
      '<span class="small">' + townEsc(n.text || '') + (n.quoted ? ' <span class="muted small">（别人说的话，只转述）</span>' : '') + '</span></div>';
  }).join('');
}

function townRenderDays(d) {
  var box = el('townDays');
  if (box) {
    var days = d.days || [];
    box.innerHTML = days.length ? days.map(function (x) {
      return '<div class="memdb-job"><span class="muted small">' + townEsc(x.day || '') + '</span><span class="small">' + townEsc(x.line || '') + '</span></div>';
    }).join('') : '<span class="muted small">她还没给自己留过话。</span>';
  }
  var im = el('townImpressions');
  if (im) {
    var list = d.impressions || [];
    im.innerHTML = list.length ? list.map(function (p) {
      return '<div class="memdb-job"><b class="small">' + townEsc(p.name || p.fishId || '') + '</b>' +
        '<span class="muted small">' + townClock(p.updatedAt) + '</span><span class="small">' + townEsc(p.line || '') + '</span></div>';
    }).join('') : '<span class="muted small">还没有记住谁（同一个人见过两次才会记）。</span>';
  }
}

function townRenderAll() {
  var d = TOWN.data;
  if (!d) return;
  var input = el('townEnabled');
  if (input) input.checked = TOWN.cap.enabled === true;
  if (input) input.disabled = d.canWrite === false;
  townRenderMeta(d);
  townRenderStats(d);
  townRenderState(d);
  townRenderBonds(d);
  townRenderNotes(d);
  townRenderDays(d);
}

function loadTown() {
  return api('/api/town').then(function (r) {
    TOWN.data = r;
    TOWN.cap = { enabled: !!(r.cap && r.cap.enabled), mtime: Number(r.cap && r.cap.mtime) || 0 };
    townRenderAll();
    return r;
  }).catch(function (e) {
    var box = el('townNotes');
    if (box) box.innerHTML = '<span class="msg bad">读不到：' + townEsc(e && e.message || e) + '</span>';
    return null;
  });
}

function townSaveEnabled(on) {
  townMsg('保存中…');
  return api('/api/capabilities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ updates: { town: !!on }, __baseMtime: TOWN.cap.mtime }),
  }).then(function (r) {
    TOWN.cap = { enabled: !!on, mtime: Number(r && r.mtime) || 0 };
    // 能力开关同时被别处改过：这里不覆盖，让用户看一眼再决定
    townMsg(on ? '已打开：她下一轮就会挂上长轮询' : '已关掉：她不再进镇，记忆留着', true);
    return loadTown();
  }).catch(function (e) {
    // api() 只把后端的 message 带出来（409 时就是「配置刚被别处改过…」），照原样显示
    townMsg('没保存上：' + String(e && e.message || e), false);
    var input = el('townEnabled');
    if (input) input.checked = TOWN.cap.enabled === true;
    return null;
  });
}

// 脚本在 body 末尾加载，元素都已经在了，直接绑（不等 DOMContentLoaded，免得错过事件）
if (el('townEnabled')) el('townEnabled').onchange = function () { townSaveEnabled(el('townEnabled').checked); };
if (el('townRefresh')) el('townRefresh').onclick = function () { townMsg(''); loadTown(); };
