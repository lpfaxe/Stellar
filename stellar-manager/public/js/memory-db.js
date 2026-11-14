/* 记忆库（新机制，owner 2026-11-13）：话题目录 / 零碎 / 人物侧写 / 参考库。
 * 后端 stellar-manager/lib/memory-db.js，库文件与桥接共用 characters/<角色>/memory/memory.db。
 * 只做显示与发请求；分层、忘记、侧写字数这些判定都在服务端。
 */
var MEMDB = { data: null, canWrite: true };
var TOPICS = { owner: '', tier: '', q: '', offset: 0, limit: 20, total: 0, items: [], currentId: '' };
var PROFILES = { items: [], people: [] };

function mdbEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function mdbSize(n) {
  var b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
function mdbClock(at) {
  if (!at) return '—';
  var d = new Date(Number(at));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function mdbMsg(id, text, ok) {
  var n = el(id);
  if (n) setMsg(n, text, ok);
}

// ── 概览 ────────────────────────────────────────────────────────────────────
function mdbRenderStats(d) {
  var box = el('mdbStats');
  if (!box) return;
  var s = d.stats || {};
  var cells = [
    ['缓存待切', s.cache || 0, '句'],
    ['话题', s.topics || 0, '段对话'],
    ['重要', s.important || 0, '不淘汰'],
    ['零碎', s.fragments || 0, '单边话'],
    ['侧写', s.profiles || 0, '每人一句'],
  ];
  box.innerHTML = cells.map(function (c) {
    return '<div class="memdb-cell"><span class="k">' + mdbEsc(c[0]) + '</span><b>' + mdbEsc(c[1]) + '</b><span class="hint">' + mdbEsc(c[2]) + '</span></div>';
  }).join('');
}

function mdbJobName(name) {
  if (name === 'window') return '窗口清理';
  if (name === 'review') return '复核';
  if (name === 'profile') return '侧写';
  return '切分';
}

function mdbRenderMeta(d) {
  var box = el('mdbMeta');
  if (!box) return;
  var info = d.info || {};
  if (!info.exists) {
    box.innerHTML = '<div class="muted small">还没建库：' + mdbEsc(info.file || '') + '</div>';
    return;
  }
  var jobs = (d.jobs || []).map(function (j) {
    return '<div class="memdb-job"><span class="pill">' + mdbEsc(mdbJobName(j.name)) + '</span>' +
      '<span class="muted small">' + mdbEsc(j.day || '') + ' · ' + mdbEsc(j.state || '') + ' · ' + mdbClock(j.lastRunAt) + '</span>' +
      (j.lastError ? '<span class="msg bad">' + mdbEsc(String(j.lastError).slice(0, 120)) + '</span>' : '') + '</div>';
  }).join('');
  var trash = (d.trash || []).slice(0, 6).map(function (t) {
    return '<div class="memdb-job"><span class="muted small">忘记的备份 · ' + mdbEsc(t.name) + ' · ' + mdbSize(t.bytes) + ' · ' + mdbClock(t.at) + '</span></div>';
  }).join('');
  var queued = (d.queued || []).map(function (q) {
    return '<div class="memdb-job"><span class="pill on">已排队</span><span class="muted small">' +
      mdbEsc(q.job === 'profile' ? '侧写生成' : '前天复核') + ' · ' + mdbClock(q.at) +
      ' · 她那边每 10 分钟检查一次</span></div>';
  }).join('');
  box.innerHTML =
    '<div class="memdb-meta-row"><span class="muted small">' + mdbEsc(info.name || info.role || '') + ' · ' + mdbEsc(info.file || '') + '</span>' +
    '<span class="muted small">' + mdbSize(info.bytes) + ' · 更新于 ' + mdbClock(info.mtime) + '</span></div>' +
    queued + (jobs || '<div class="muted small">后台作业还没跑过。</div>') + trash;
}

function loadMemoryDb() {
  return api('/api/memory-db').then(function (d) {
    MEMDB.data = d;
    MEMDB.canWrite = d.canWrite !== false;
    mdbRenderStats(d);
    mdbRenderMeta(d);
    mdbRenderZones(d);
    var b = el('mdbSplit');
    if (b) b.disabled = !MEMDB.canWrite;
    var b2 = el('mdbReview');
    if (b2) b2.disabled = !MEMDB.canWrite;
    var b3 = el('pfGenerate');
    if (b3) b3.disabled = !MEMDB.canWrite;
    var note = el('mdbNote');
    if (note && (d.stats || {}).cache) {
      note.textContent = '缓存里还有 ' + d.stats.cache + ' 句话没切。切分会把连续对话并成话题，单边的话降级成零碎。';
    }
    return d;
  }).catch(function (e) {
    mdbMsg('mdbMsg', '读记忆库失败：' + e.message, false);
  });
}

// ── 话题目录 ────────────────────────────────────────────────────────────────
function mdbRenderOwners() {
  var box = el('tpOwners');
  if (!box) return;
  var owners = (MEMDB.data && MEMDB.data.owners) || [];
  var html = '<button class="ghost small' + (TOPICS.owner ? '' : ' on') + '" data-owner="">全部</button>';
  html += owners.map(function (o) {
    return '<button class="ghost small' + (TOPICS.owner === o.ownerId ? ' on' : '') + '" data-owner="' + mdbEsc(o.ownerId) + '">' +
      mdbEsc(o.label || o.ownerId) + ' <span class="muted">' + (o.topics || 0) + '</span></button>';
  }).join('');
  box.innerHTML = html;
}

function mdbRenderTopics(d) {
  var box = el('tpList');
  if (!box) return;
  TOPICS.total = d.total || 0;
  TOPICS.items = d.items || [];
  if (!TOPICS.items.length) {
    box.innerHTML = '<div class="empty">还没有话题。有人跟她说过话、缓存攒够之后才会切出来。</div>';
  } else {
    box.innerHTML = TOPICS.items.map(function (t) {
      var tags = (t.facets || []).slice(0, 3).map(function (f) { return '<span class="pill">' + mdbEsc(f) + '</span>'; }).join('');
      return '<div class="memdb-topic" data-id="' + mdbEsc(t.id) + '">' +
        '<div class="memdb-topic-head"><b>' + mdbEsc(t.title || '（没标题）') + '</b>' +
        (t.tier === 'important' ? '<span class="pill on">重要</span>' : '') +
        '<span class="muted small">' + mdbEsc(t.ownerLabel || '') + (t.relation ? ' · ' + mdbEsc(t.relation) : '') + '</span></div>' +
        '<div class="memdb-topic-sum">' + mdbEsc(String(t.summary || '').slice(0, 160)) + '</div>' +
        '<div class="memdb-topic-meta"><span class="muted small">' + mdbEsc(t.day || '') + ' · ' + (t.msgCount || 0) + ' 句 · 重要度 ' + (t.importance || 0) + '</span>' + tags + '</div>' +
        '</div>';
    }).join('');
  }
  if (el('tpPage')) {
    var from = TOPICS.total ? TOPICS.offset + 1 : 0;
    var to = Math.min(TOPICS.offset + TOPICS.limit, TOPICS.total);
    el('tpPage').textContent = from + '–' + to + ' / 共 ' + TOPICS.total + ' 条';
  }
  if (el('tpPrev')) el('tpPrev').disabled = TOPICS.offset <= 0;
  if (el('tpNext')) el('tpNext').disabled = TOPICS.offset + TOPICS.limit >= TOPICS.total;
}

function loadTopics(offset) {
  if (typeof offset === 'number') TOPICS.offset = Math.max(0, offset);
  var qs = '?limit=' + TOPICS.limit + '&offset=' + TOPICS.offset;
  if (TOPICS.owner) qs += '&owner=' + encodeURIComponent(TOPICS.owner);
  if (TOPICS.tier) qs += '&tier=' + encodeURIComponent(TOPICS.tier);
  if (TOPICS.q) qs += '&q=' + encodeURIComponent(TOPICS.q);
  return api('/api/memory-db/topics' + qs).then(function (d) {
    if (!d.ok) throw new Error(d.message || '读话题失败');
    mdbRenderOwners();
    mdbRenderTopics(d);
    return d;
  }).catch(function (e) {
    var box = el('tpList');
    if (box) box.innerHTML = '<div class="empty">' + mdbEsc('读话题失败：' + e.message) + '</div>';
  });
}

// ── 话题详情（浮层） ────────────────────────────────────────────────────────
function mdbOpenTopic(id) {
  TOPICS.currentId = String(id || '');
  var mask = el('topicModal');
  if (!mask) return;
  if (el('tpModalBody')) el('tpModalBody').innerHTML = '<div class="muted small">读取中…</div>';
  mdbMsg('tpModalMsg', '');
  mask.hidden = false;
  document.body.classList.add('has-sheet');
  api('/api/memory-db/topic?id=' + encodeURIComponent(TOPICS.currentId)).then(function (d) {
    if (!d.ok) throw new Error(d.message || '读不到这个对话');
    var t = d.topic || {};
    if (el('tpModalTitle')) el('tpModalTitle').textContent = t.title || '（没标题）';
    if (el('tpModalMeta')) {
      el('tpModalMeta').textContent = (t.ownerLabel || '') + (t.relation ? ' · ' + t.relation : '') +
        ' · ' + (t.day || '') + ' · 重要度 ' + (t.importance || 0) + (t.tier === 'important' ? ' · 重要' : '');
    }
    var msgs = d.messages || [];
    el('tpModalBody').innerHTML = msgs.length ? msgs.map(function (m) {
      var mine = m.role === 'self';
      return '<div class="memdb-msg' + (mine ? ' self' : '') + '"><span class="who">' + mdbEsc(mine ? '她' : (m.name || '对方')) + '</span>' +
        '<span class="txt">' + mdbEsc(m.text) + '</span><span class="at">' + mdbClock(m.at) + '</span></div>';
    }).join('') : '<div class="empty">这个话题里没有正文（可能是被清理过）。</div>';
    var p = el('tpPromote');
    if (p) p.disabled = !MEMDB.canWrite || t.tier === 'important';
  }).catch(function (e) {
    if (el('tpModalBody')) el('tpModalBody').innerHTML = '<div class="empty">' + mdbEsc(e.message) + '</div>';
  });
}

function mdbCloseTopic() {
  var mask = el('topicModal');
  if (mask) mask.hidden = true;
  document.body.classList.remove('has-sheet');
}
function mdbPromote() {
  if (!TOPICS.currentId || !MEMDB.canWrite) return;
  api('/api/memory-db/tier', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'topic', id: TOPICS.currentId, tier: 'important' }),
  }).then(function () {
    mdbMsg('tpModalMsg', '已标为重要', true);
    var p = el('tpPromote');
    if (p) p.disabled = true;
    loadTopics();
    loadMemoryDb();
  }).catch(function (e) { mdbMsg('tpModalMsg', e.message, false); });
}
function mdbForgetTopic() {
  if (!TOPICS.currentId || !MEMDB.canWrite) return;
  if (!confirm('忘记这个话题？会先把原文导出到 memory-trash，再从库里删掉。')) return;
  api('/api/memory-db/forget', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'topic', id: TOPICS.currentId }),
  }).then(function (d) {
    mdbMsg('tpModalMsg', '已忘记，原文备份在 ' + (d.exported || ''), true);
    loadTopics();
    loadMemoryDb();
  }).catch(function (e) { mdbMsg('tpModalMsg', e.message, false); });
}

// ── 零碎记忆 ────────────────────────────────────────────────────────────────
function mdbRenderFragments(d) {
  var list = el('fgList');
  if (!list) return;
  if (el('fgSummary')) el('fgSummary').textContent = (d.total || 0) + ' 条 · 其中重要 ' + (d.important || 0);
  var items = d.items || [];
  if (!items.length) {
    list.innerHTML = '<div class="empty">没有零碎记忆。她自言自语、或者你发完她没回的那些话，攒久了会落到这里。</div>';
    return;
  }
  list.innerHTML = items.map(function (f) {
    return '<div class="memdb-frag">' +
      '<div class="memdb-topic-head"><b class="memdb-frag-text">' + mdbEsc(f.text) + '</b>' +
      (f.tier === 'important' ? '<span class="pill on">重要</span>' : '') + '</div>' +
      '<div class="memdb-topic-meta"><span class="muted small">' + mdbEsc(f.ownerLabel || '') + ' · ' + mdbEsc(f.facet || '未分类') + ' · ' + mdbClock(f.at) + '</span>' +
      (MEMDB.canWrite ? '<button class="ghost small danger" data-frag="' + mdbEsc(f.id) + '">忘记</button>' : '') + '</div>' +
      '</div>';
  }).join('');
}
function loadFragments() {
  return api('/api/memory-db/fragments?limit=60').then(function (d) {
    if (!d.ok) throw new Error(d.message || '读零碎失败');
    mdbRenderFragments(d);
    return d;
  }).catch(function (e) {
    var l = el('fgList');
    if (l) l.innerHTML = '<div class="empty">' + mdbEsc('读零碎失败：' + e.message) + '</div>';
  });
}

// ── 人物侧写 ────────────────────────────────────────────────────────────────
function loadProfiles() {
  return api('/api/profiles').then(function (d) {
    PROFILES.items = d.items || [];
    PROFILES.people = d.people || [];
    var box = el('pfList');
    if (!box) return d;
    var byId = {};
    PROFILES.items.forEach(function (p) { byId[p.ownerId] = p; });
    var rows = PROFILES.people.map(function (people) {
      var p = byId[people.ownerId] || null;
      var cur = p ? (p.persona || '') : '';
      return '<div class="memdb-profile" data-owner="' + mdbEsc(people.ownerId) + '">' +
        '<div class="memdb-topic-head"><b>' + mdbEsc(people.label || people.ownerId) + '</b>' +
        (people.relation ? '<span class="muted small">' + mdbEsc(people.relation) + '</span>' : '') +
        (p ? '<span class="pill">' + (p.editedBy === 'panel' ? '手改过' : '自动') + '</span>' : '<span class="pill off">还没写</span>') + '</div>' +
        '<div class="row wrap"><input class="grow pf-input" maxlength="50" placeholder="一句话记住这个人（≤50 字）" value="' + mdbEsc(cur) + '">' +
        (MEMDB.canWrite ? '<button class="ghost small pf-save">保存</button>' : '') + '</div>' +
        (p && p.updatedAt ? '<span class="muted small">上次更新 ' + mdbClock(p.updatedAt) + '</span>' : '') +
        '</div>';
    }).join('');
    box.innerHTML = rows || '<div class="empty">通讯录里还没有人。</div>';
    return d;
  }).catch(function (e) {
    var box = el('pfList');
    if (box) box.innerHTML = '<div class="empty">' + mdbEsc('读侧写失败：' + e.message) + '</div>';
  });
}
function mdbSaveProfile(ownerId, persona, btn) {
  if (!MEMDB.canWrite) return;
  if (btn) btn.disabled = true;
  api('/api/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerId: ownerId, persona: persona }),
  }).then(function (d) {
    if (!d.ok) throw new Error(d.message || '保存失败');
    if (btn) btn.textContent = '已保存';
    setTimeout(function () { if (btn) btn.textContent = '保存'; }, 1500);
    loadProfiles();
  }).catch(function (e) {
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
    var n = el('pfNote');
    if (n) setMsg(n, '保存失败：' + e.message, false);
  });
}

// ── 参考库 ──────────────────────────────────────────────────────────────────
function loadStyleRefs() {
  return api('/api/style-refs').then(function (d) {
    var box = el('srList');
    if (!box) return d;
    if (!d.ok) throw new Error(d.message || '读参考库失败');
    var sources = d.sources || [];
    if (!sources.length) {
      box.innerHTML = '<div class="empty">参考库还没导入切片。在仓库目录跑 <code>node scripts/index-style-refs.mjs</code> 导入，之后这里会按来源列出每一片。</div>';
      return d;
    }
    box.innerHTML = sources.map(function (s) {
      var slices = (s.slices || []).map(function (x) {
        return '<div class="memdb-slice"><div class="memdb-topic-head"><span class="muted small">' + mdbEsc((x.part || '') + (x.kind ? ' · ' + x.kind : '') || x.id || '') + '</span>' +
          '<span class="pill' + (x.enabled ? ' on' : ' off') + '">' + (x.enabled ? '开' : '关') + '</span>' +
          (MEMDB.canWrite ? '<button class="ghost sr-toggle" data-id="' + mdbEsc(x.id) + '" data-source="' + mdbEsc(s.source) + '" data-enabled="' + (x.enabled ? '1' : '0') + '">' + (x.enabled ? '关掉' : '打开') + '</button>' : '') +
          '</div>' +
          '<div class="memdb-topic-sum">' + mdbEsc(String(x.preview || x.text || '').slice(0, 140)) + '</div>' +
          '</div>';
      }).join('');
      return '<div class="memdb-source"><div class="memdb-topic-head"><b>' + mdbEsc(s.source) + '</b><span class="muted small">' + (s.enabled || 0) + '/' + (s.total || 0) + ' 片开着</span></div>' + slices + '</div>';
    }).join('');
    return d;
  }).catch(function (e) {
    var box = el('srList');
    if (box) box.innerHTML = '<div class="empty">' + mdbEsc('读参考库失败：' + e.message) + '</div>';
  });
}

// ── 事件绑定 ────────────────────────────────────────────────────────────────
window.loadMemoryDb = loadMemoryDb;
window.loadTopics = loadTopics;
window.loadFragments = loadFragments;
window.loadProfiles = loadProfiles;
window.loadStyleRefs = loadStyleRefs;

if (el('mdbRefresh')) el('mdbRefresh').onclick = function () { loadMemoryDb(); loadTopics(); loadFragments(); };
if (el('mdbSplit')) el('mdbSplit').onclick = function () {
  var b = el('mdbSplit');
  b.disabled = true;
  mdbMsg('mdbMsg', '切分中…');
  api('/api/memory-db/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job: 'split' }), timeoutMs: 60000 })
    .then(function (d) {
      var r = (d && d.result) || {};
      mdbMsg('mdbMsg', '切分完成：新建 ' + ((r.topics || []).length) + ' 个话题，保留 ' + (r.held || 0) + ' 句待续，降级零碎 ' + (r.fragments || 0), true);
      loadMemoryDb(); loadTopics(); loadFragments();
    })
    .catch(function (e) { mdbMsg('mdbMsg', '切分失败：' + e.message, false); })
    .finally(function () { b.disabled = !MEMDB.canWrite; });
};
if (el('mdbReview')) el('mdbReview').onclick = function () {
  var b = el('mdbReview');
  b.disabled = true;
  mdbMsg('mdbMsg', '排队中…');
  api('/api/memory-db/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job: 'review' }) })
    .then(function (d) {
      if (!d.ok) throw new Error(d.message || '排队失败');
      mdbMsg('mdbMsg', '已排队：她那边每 10 分钟检查一次，跑完这一行会显示上次结果', true);
      loadMemoryDb();
    })
    .catch(function (e) { mdbMsg('mdbMsg', '排队失败：' + e.message, false); })
    .finally(function () { b.disabled = !MEMDB.canWrite; });
};
if (el('tpRefresh')) el('tpRefresh').onclick = function () { loadTopics(0); };
if (el('tpSearchBtn')) el('tpSearchBtn').onclick = function () { TOPICS.q = el('tpSearch') ? el('tpSearch').value.trim() : ''; loadTopics(0); };
if (el('tpSearch')) el('tpSearch').onkeydown = function (ev) { if (ev.key === 'Enter') { TOPICS.q = ev.target.value.trim(); loadTopics(0); } };
if (el('tpTier')) el('tpTier').onchange = function (ev) { TOPICS.tier = ev.target.value; loadTopics(0); };
if (el('tpPrev')) el('tpPrev').onclick = function () { loadTopics(Math.max(0, TOPICS.offset - TOPICS.limit)); };
if (el('tpNext')) el('tpNext').onclick = function () { loadTopics(TOPICS.offset + TOPICS.limit); };
if (el('tpOwners')) el('tpOwners').addEventListener('click', function (ev) {
  var btn = ev.target.closest('button[data-owner]');
  if (!btn) return;
  TOPICS.owner = btn.getAttribute('data-owner') || '';
  loadTopics(0);
});
if (el('tpList')) el('tpList').addEventListener('click', function (ev) {
  var row = ev.target.closest('.memdb-topic[data-id]');
  if (row) mdbOpenTopic(row.getAttribute('data-id'));
});
if (el('tpClose')) el('tpClose').onclick = mdbCloseTopic;
if (el('tpPromote')) el('tpPromote').onclick = mdbPromote;
if (el('tpForget')) el('tpForget').onclick = mdbForgetTopic;
if (el('topicModal')) el('topicModal').addEventListener('click', function (ev) { if (ev.target === el('topicModal')) mdbCloseTopic(); });
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape' && el('topicModal') && !el('topicModal').hidden) mdbCloseTopic();
});
if (el('fgRefresh')) el('fgRefresh').onclick = function () { loadFragments(); };
if (el('fgList')) el('fgList').addEventListener('click', function (ev) {
  var btn = ev.target.closest('button[data-frag]');
  if (!btn || !MEMDB.canWrite) return;
  if (!confirm('忘记这条零碎？会先导出原文再删。')) return;
  api('/api/memory-db/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fragment', id: Number(btn.getAttribute('data-frag')) }) })
    .then(function () { mdbMsg('fgMsg', '已忘记（原文已导出）', true); loadFragments(); loadMemoryDb(); })
    .catch(function (e) { mdbMsg('fgMsg', e.message, false); });
});
if (el('pfList')) el('pfList').addEventListener('click', function (ev) {
  var btn = ev.target.closest('.pf-save');
  if (!btn) return;
  var row = btn.closest('.memdb-profile');
  var input = row ? row.querySelector('.pf-input') : null;
  if (!row || !input) return;
  mdbSaveProfile(row.getAttribute('data-owner'), input.value.trim(), btn);
});
if (el('pfGenerate')) el('pfGenerate').onclick = function () {
  var b = el('pfGenerate');
  b.disabled = true;
  mdbMsg('pfMsg', '排队中…');
  api('/api/profiles/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    .then(function (d) {
      if (!d.ok) throw new Error(d.message || '排队失败');
      mdbMsg('pfMsg', '已排队，跑完这份列表会自动刷新', true);
      loadMemoryDb();
    })
    .catch(function (e) { mdbMsg('pfMsg', '排队失败：' + e.message, false); })
    .finally(function () { b.disabled = !MEMDB.canWrite; });
};
if (el('srList')) el('srList').addEventListener('click', function (ev) {
  var btn = ev.target.closest('.sr-toggle');
  if (!btn || !MEMDB.canWrite) return;
  var next = btn.getAttribute('data-enabled') === '1' ? false : true;
  btn.disabled = true;
  api('/api/style-refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: Number(btn.getAttribute('data-id')), source: btn.getAttribute('data-source'), enabled: next }),
  }).then(function () { loadStyleRefs(); }).catch(function (e) { btn.disabled = false; });
});

// ── 见闻区：B站 / 好友爱看（owner 2026-11-13）────────────────────────────────
// 这两区不按话题分类，是她自己写完总结后调 stellar_memory_zone 写进去的；
// 面板只负责看和删（删除会先导出到 memory-trash，后面能找回）。
var ZONES = { bili: { loaded: false }, qzone: { loaded: false } };

function zoneEls(zone) {
  return zone === 'qzone'
    ? { list: 'zqList', summary: 'zqSummary', msg: 'zqMsg', refresh: 'zqRefresh', clear: 'zqClear' }
    : { list: 'zbList', summary: 'zbSummary', msg: 'zbMsg', refresh: 'zbRefresh', clear: 'zbClear' };
}

function mdbRenderZones(d) {
  var z = (d && d.zones) || {};
  var map = [['bili', 'zbSummary'], ['qzone', 'zqSummary']];
  map.forEach(function (pair) {
    var node = el(pair[1]);
    if (!node) return;
    var s = z[pair[0]] || {};
    var total = Number(s.total) || 0;
    var today = Number(s.today) || 0;
    node.textContent = total + ' 条 · 今天 ' + today + (s.lastAt ? ' · 最近 ' + mdbClock(s.lastAt) : '');
  });
}

function loadZoneNotes(zone) {
  var ids = zoneEls(zone);
  var box = el(ids.list);
  if (box) box.innerHTML = '<span class="muted">读取中…</span>';
  return api('/api/memory-db/zones?zone=' + encodeURIComponent(zone) + '&limit=8')
    .then(function (d) {
      ZONES[zone].loaded = true;
      if (!box) return d;
      var rows = d.rows || [];
      if (!rows.length) {
        box.innerHTML = '<span class="muted">' + (d.missing ? '这个区还没建（等下一次写入时自动建表）' : '还没有记录 —— 她下次看完会写一条。') + '</span>';
        return d;
      }
      box.innerHTML = rows.map(function (r) {
        var items = (r.items || []).length ? '<span class="muted small">' + mdbEsc((r.items || []).join(' · ').slice(0, 120)) + '</span>' : '';
        return '<div class="memdb-topic" data-zone="' + mdbEsc(r.zone) + '" data-id="' + mdbEsc(r.id) + '">' +
          '<div class="memdb-topic-head"><b>' + mdbEsc(String(r.text || '').slice(0, 120)) + '</b></div>' +
          '<div class="memdb-topic-meta"><span class="muted small">#' + mdbEsc(r.id) + ' · ' + mdbEsc(r.day || '') + ' · ' + mdbClock(r.at) + '</span>' + items +
          (MEMDB.canWrite ? '<button class="ghost small zone-del" data-id="' + mdbEsc(r.id) + '">删除</button>' : '') + '</div>' +
        '</div>';
      }).join('');
      return d;
    })
    .catch(function (e) {
      if (box) box.innerHTML = '<span class="msg bad">' + mdbEsc('读失败：' + e.message) + '</span>';
    });
}

function loadZones() {
  loadZoneNotes('bili');
  loadZoneNotes('qzone');
}

if (el('zbRefresh')) el('zbRefresh').onclick = function () { loadZoneNotes('bili'); };
if (el('zqRefresh')) el('zqRefresh').onclick = function () { loadZoneNotes('qzone'); };
['bili', 'qzone'].forEach(function (zone) {
  var ids = zoneEls(zone);
  var list = el(ids.list);
  if (list) list.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.zone-del');
    if (!btn || !MEMDB.canWrite) return;
    if (!confirm('删掉这条见闻？会先导出原文到 memory-trash。')) return;
    btn.disabled = true;
    api('/api/memory-db/zone-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: Number(btn.getAttribute('data-id')) }),
    }).then(function () { mdbMsg(ids.msg, '已删（原文已导出）', true); loadZoneNotes(zone); loadMemoryDb(); })
      .catch(function (e) { btn.disabled = false; mdbMsg(ids.msg, '删失败：' + e.message, false); });
  });
  var clear = el(ids.clear);
  if (clear) clear.onclick = function () {
    if (!MEMDB.canWrite) return;
    if (!confirm('把「' + (zone === 'bili' ? 'B站' : '好友爱看') + '」区整个清空？会先整区导出。')) return;
    clear.disabled = true;
    api('/api/memory-db/zone-clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zone: zone }),
    }).then(function (d) { mdbMsg(ids.msg, '清掉 ' + (d.deleted || 0) + ' 条（已导出）', true); loadZoneNotes(zone); loadMemoryDb(); })
      .catch(function (e) { mdbMsg(ids.msg, '清空失败：' + e.message, false); })
      .finally(function () { clear.disabled = !MEMDB.canWrite; });
  };
});

// 记忆库总览一刷新就把两个区的计数带上；见闻列表首次进页面时拉一次。
if (el('mdbRefresh')) el('mdbRefresh').addEventListener('click', function () { loadZones(); });
loadZones();

// ── 重要事实（主人 2026-11-13）：生日 / 忌口 / 联系方式按人对号存 ─────────────
// 表 fact 由 stellar/src/memory-db.js 建；她那边按「正在跟谁说话」挑隐私级注入，
// 面板这边是主人的手写入口（这是「注入记忆」的地方）。删除前会导出到 memory-trash。
var FACT = { owner: '', rows: [], people: [], groups: [], editing: 0, stats: {} };
var FACT_KINDS = [
  ['birthday', '生日'], ['anniversary', '纪念日'], ['like', '喜欢'], ['dislike', '不喜欢'],
  ['allergy', '忌口/过敏'], ['contact', '联系方式'], ['address', '地址'], ['nickname', '称呼'],
  ['promise', '约定'], ['identity', '身份'], ['note', '其他'],
];
var FACT_PRIVACY = [['normal', '公开 · 群里也能提'], ['private', '私密 · 只在本人面前提'], ['secret', '机密 · 只本人私聊与面板']];

function factKindLabel(kind) {
  for (var i = 0; i < FACT_KINDS.length; i++) if (FACT_KINDS[i][0] === kind) return FACT_KINDS[i][1];
  return '其他';
}
function mdbRenderFactStats() {
  var box = el('ftSummary');
  if (!box) return;
  var s = FACT.stats || {};
  box.textContent = (s.total || 0) + ' 条 · 机密 ' + (s.secret || 0) + ' · 今天 ' + (s.today || 0) + ' · 覆盖 ' + (s.owners || 0) + ' 人';
}

function factOwnerOptions() {
  var out = FACT.people.map(function (p) { return [String(p.uin), (p.name || p.nickname || p.uin) + ' · ' + (p.relation || p.type || '')]; });
  FACT.groups.forEach(function (g) { out.push(['group:' + String(g.gid), (g.name || g.gid) + ' · 群']); });
  return out;
}

function mdbFillFactSelects() {
  var opts = factOwnerOptions();
  var filter = el('ftOwnerFilter');
  if (filter) {
    filter.innerHTML = '<option value="">全部人</option>' + opts.map(function (o) {
      return '<option value="' + mdbEsc(o[0]) + '"' + (FACT.owner === o[0] ? ' selected' : '') + '>' + mdbEsc(o[1]) + '</option>';
    }).join('');
  }
  var owner = el('ftOwner');
  if (owner) {
    owner.innerHTML = opts.map(function (o) { return '<option value="' + mdbEsc(o[0]) + '">' + mdbEsc(o[1]) + '</option>'; }).join('');
  }
  var kind = el('ftKind');
  if (kind) kind.innerHTML = FACT_KINDS.map(function (k) { return '<option value="' + k[0] + '">' + k[1] + '</option>'; }).join('');
  var privacy = el('ftPrivacy');
  if (privacy) privacy.innerHTML = FACT_PRIVACY.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('');
}

function loadFactPeople() {
  if (FACT.people.length || FACT.groups.length) return Promise.resolve();
  return api('/api/contacts').then(function (d) {
    FACT.people = (d.people || []).slice();
    FACT.groups = (d.groups || []).slice();
    mdbFillFactSelects();
  }).catch(function () {});
}

function mdbRenderFacts(d) {
  var box = el('ftList');
  FACT.stats = (d && d.stats) || {};
  mdbRenderFactStats();
  if (!box) return;
  var rows = (d && d.rows) || [];
  FACT.rows = rows;
  if (!rows.length) {
    box.innerHTML = '<div class="empty">' + (d && d.missing ? '库还没有 fact 表：重启一次桥接就会建好。' : '还没有重要事实。她聊天里听到生日/忌口会自动记；你也可以点「注入一条」手写。') + '</div>';
    return;
  }
  box.innerHTML = rows.map(function (r) {
    var tone = r.privacy === 'secret' ? ' on' : '';
    return '<div class="memdb-topic" data-id="' + mdbEsc(r.id) + '">' +
      '<div class="memdb-topic-head"><b>' + mdbEsc(r.label || factKindLabel(r.kind)) + '</b>' +
      '<span class="pill' + tone + '">' + mdbEsc(r.privacyLabel || r.privacy) + '</span>' +
      '<span class="muted small">' + mdbEsc(r.ownerLabel || r.ownerId) + (r.relation ? ' · ' + mdbEsc(r.relation) : '') + ' · 权重 ' + mdbEsc(r.weight) + '</span></div>' +
      '<div class="memdb-topic-sum">' + mdbEsc(String(r.text || '')) + '</div>' +
      '<div class="memdb-topic-meta"><span class="muted small">#' + mdbEsc(r.id) + ' · ' + mdbEsc(r.kindLabel || r.kind) + ' · ' + mdbEsc(r.source === 'auto' ? '她记的' : '手写') + ' · ' + mdbClock(r.updatedAt || r.at) + '</span>' +
      (MEMDB.canWrite ? '<button class="ghost small fact-edit" data-id="' + mdbEsc(r.id) + '">编辑</button><button class="ghost small fact-del" data-id="' + mdbEsc(r.id) + '">删除</button>' : '') +
      '</div></div>';
  }).join('');
}

function loadFacts() {
  var box = el('ftList');
  if (box && !FACT.rows.length) box.innerHTML = '<span class="muted">读取中…</span>';
  return loadFactPeople().then(function () {
    return api('/api/memory-db/facts?limit=60' + (FACT.owner ? '&owner=' + encodeURIComponent(FACT.owner) : ''));
  }).then(function (d) {
    mdbRenderFacts(d);
    return d;
  }).catch(function (e) {
    if (box) box.innerHTML = '<span class="msg bad">' + mdbEsc('读事实失败：' + e.message) + '</span>';
  });
}

function factFormOpen(row) {
  var form = el('ftForm');
  if (!form) return;
  FACT.editing = row ? Number(row.id) || 0 : 0;
  form.hidden = false;
  var title = el('ftFormTitle');
  if (title) title.textContent = FACT.editing ? ('改这一条（#' + FACT.editing + '）') : '注入一条新事实';
  if (row) {
    if (el('ftOwner')) el('ftOwner').value = String(row.ownerId || '');
    if (el('ftKind')) el('ftKind').value = String(row.kind || 'note');
    if (el('ftLabel')) el('ftLabel').value = String(row.label || '');
    if (el('ftText')) el('ftText').value = String(row.text || '');
    if (el('ftPrivacy')) el('ftPrivacy').value = String(row.privacy || 'private');
    if (el('ftWeight')) el('ftWeight').value = String(row.weight || 3);
  } else {
    if (el('ftKind')) el('ftKind').value = 'birthday';
    if (el('ftLabel')) el('ftLabel').value = '';
    if (el('ftText')) el('ftText').value = '';
    if (el('ftPrivacy')) el('ftPrivacy').value = 'private';
    if (el('ftWeight')) el('ftWeight').value = '5';
    if (el('ftOwner') && FACT.owner) el('ftOwner').value = FACT.owner;
  }
  if (el('ftOwner')) el('ftOwner').disabled = !!FACT.editing;
  if (el('ftText')) el('ftText').focus();
}
function factFormClose() {
  var form = el('ftForm');
  if (form) form.hidden = true;
  FACT.editing = 0;
  mdbMsg('ftFormMsg', '', true);
}

if (el('ftToggle')) el('ftToggle').onclick = function () {
  var form = el('ftForm');
  if (form && !form.hidden && !FACT.editing) factFormClose();
  else factFormOpen(null);
};
if (el('ftCancel')) el('ftCancel').onclick = factFormClose;
if (el('ftRefresh')) el('ftRefresh').onclick = function () { loadFacts(); };
if (el('ftOwnerFilter')) el('ftOwnerFilter').onchange = function (ev) {
  FACT.owner = ev.target.value || '';
  loadFacts();
};
if (el('ftSave')) el('ftSave').onclick = function () {
  var btn = el('ftSave');
  var body = {
    id: FACT.editing || 0,
    ownerId: el('ftOwner') ? el('ftOwner').value : '',
    kind: el('ftKind') ? el('ftKind').value : 'note',
    label: el('ftLabel') ? String(el('ftLabel').value || '').trim() : '',
    text: el('ftText') ? String(el('ftText').value || '').trim() : '',
    privacy: el('ftPrivacy') ? el('ftPrivacy').value : 'private',
    weight: el('ftWeight') ? Number(el('ftWeight').value) : 3,
  };
  if (!body.text) { mdbMsg('ftFormMsg', '内容不能空着', false); return; }
  if (!body.ownerId) { mdbMsg('ftFormMsg', '得选一个人', false); return; }
  btn.disabled = true;
  api('/api/memory-db/fact-save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (d) {
    mdbMsg('ftMsg', d.merged ? '已合并到同一条（同人同标题）' : (d.created ? '已注入' : '已更新'), true);
    factFormClose();
    loadFacts();
  }).catch(function (e) {
    mdbMsg('ftFormMsg', '存不下：' + e.message, false);
  }).finally(function () { btn.disabled = !MEMDB.canWrite; });
};
if (el('ftList')) el('ftList').addEventListener('click', function (ev) {
  var edit = ev.target.closest('.fact-edit');
  if (edit) {
    var id = Number(edit.getAttribute('data-id'));
    var row = null;
    FACT.rows.forEach(function (r) { if (Number(r.id) === id) row = r; });
    if (row) factFormOpen(row);
    return;
  }
  var del = ev.target.closest('.fact-del');
  if (!del || !MEMDB.canWrite) return;
  if (!confirm('删掉这条事实？会先导出原文到 memory-trash。')) return;
  del.disabled = true;
  api('/api/memory-db/fact-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: Number(del.getAttribute('data-id')) }),
  }).then(function () { mdbMsg('ftMsg', '已删（原文已导出）', true); loadFacts(); loadMemoryDb(); })
    .catch(function (e) { del.disabled = false; mdbMsg('ftMsg', '删失败：' + e.message, false); });
});

if (el('mdbRefresh')) el('mdbRefresh').addEventListener('click', function () { loadFacts(); });
loadFacts();
