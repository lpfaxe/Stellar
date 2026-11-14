/* // 运行数据：调度 / 记忆分层 / 词汇本 / 表情包 / 日志（只读分页） */

['windows', 'videoTarget', 'maxWakes', 'skipChance', 'minGap', 'frames'].forEach(function (id) {
  el(id).addEventListener('input', function () { dirty.clock = true; });
  el(id).addEventListener('change', function () { dirty.clock = true; });
});
['windows', 'videoTarget', 'maxWakes', 'skipChance', 'minGap', 'frames', 'weeklyMin', 'dailyLimit'].forEach(function (id) {
  var node = el(id);
  if (!node) return;
  node.addEventListener('change', function () { dirty.clock = true; });
  node.addEventListener('input', function () { dirty.clock = true; });
});

// ── 运行数据（P1）：调度 / 记忆分层 / 词汇本 / 表情包 / 日志 ───────────────
var OPS_LIMIT = { agent: 20, mem: 20, lex: 20, stk: 24, log: 50 };
var OPS_EMPTY = { agent: '还没有调度记录（桥接启动后会写 state/agent-state.json）', mem: '没有匹配的记忆', lex: '词汇本还是空的', stk: '表情包库还是空的', log: '没有匹配的日志' };

function opsRow(title, sub, badge, onClick) {
  var row = document.createElement('div');
  row.className = 'ops-item';
  if (badge) {
    var b = document.createElement('span');
    b.className = 'tier-badge tier-' + badge.toLowerCase();
    b.textContent = badge;
    row.appendChild(b);
  }
  var body = document.createElement('div');
  body.className = 'ops-body';
  var t = document.createElement('div');
  t.className = 'ops-title';
  t.textContent = title;
  body.appendChild(t);
  if (sub) {
    var s = document.createElement('div');
    s.className = 'ops-sub';
    s.textContent = sub;
    body.appendChild(s);
  }
  row.appendChild(body);
  if (onClick) {
    row.classList.add('clickable');
    row.onclick = onClick;
  }
  return row;
}

function opsListBox() { return el('opsList'); }

function renderOps(data) {
  var box = opsListBox();
  box.textContent = '';
  var tab = state.ops.tab;
  var items = (data && data.items) || [];
  if (tab === 'agent') {
    var head = document.createElement('div');
    head.className = 'ops-summary';
    var counts = (data && data.counts) || {};
    head.textContent = (data && data.ok ? '' : '还没有状态文件 · ') +
      ['LISTEN', 'ACTIVE', 'COOLDOWN', 'SLEEP'].map(function (k) { return k + ' ' + (counts[k] || 0); }).join(' · ') +
      ' · 幂等表 ' + ((data && data.seen) || 0) + ' 条';
    box.appendChild(head);
    if (!items.length) { box.appendChild(opsRow(OPS_EMPTY.agent, '')); return; }
    items.forEach(function (c) {
      var sub = '最后活动 ' + fmtTime(c.lastAt) + ' · 轮数 ' + c.turns + (c.reason ? ' · ' + c.reason : '');
      box.appendChild(opsRow(prettyKey(c.key) + ' · ' + stateLabel(c.state), sub, c.state === 'SLEEP' ? 'SLEEP' : c.state === 'ACTIVE' ? 'L1' : ''));
    });
    return;
  }
  if (!items.length) { box.appendChild(opsRow(OPS_EMPTY[tab] || '没有数据', '')); return; }
  items.forEach(function (item) {
    if (tab === 'mem') {
      var sub = '#' + item.id + ' · ' + (item.kind || 'memory') + ' · 重要度 ' + item.importance + ' · ' + String(item.createdAt || '').slice(0, 16).replace('T', ' ') + (item.sensitive ? ' · 敏感' : '');
      box.appendChild(opsRow(item.summary || '(无摘要)', sub, item.tier, function () { openMemoryItem(item.id); }));
      return;
    }
    if (tab === 'lex') {
      box.appendChild(opsRow(item.word, '= ' + (item.meaning || '（还没写释义）') + ' · ' + (item.status || item.source || '') + ' · 用过 ' + item.count + ' 次'));
      return;
    }
    if (tab === 'stk') {
      box.appendChild(opsRow('#' + item.no + ' ' + (item.desc || ''), (item.emotion || '') + ' · ' + (item.tags || []).join('/') + ' · 用了 ' + item.useCount + ' 次'));
      return;
    }
    box.appendChild(opsRow(String(item.at || '').slice(0, 19).replace('T', ' ') + '  ' + (item.kind || ''), item.text));
  });
}

function openMemoryItem(id) {
  var box = opsListBox();
  box.textContent = '加载中…';
  api('/api/memory/item?id=' + encodeURIComponent(id))
    .then(function (r) {
      box.textContent = '';
      var back = document.createElement('button');
      back.className = 'ghost';
      back.textContent = '← 返回列表';
      back.onclick = loadOps;
      box.appendChild(back);
      var pre = document.createElement('pre');
      pre.className = 'out';
      pre.textContent = JSON.stringify(r.item, null, 2);
      box.appendChild(pre);
      var del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '删除这条记忆';
      del.onclick = function () {
        if (!confirm('删除这条记忆？会先归档原文再移出记忆卡。')) return;
        if (!confirm('再确认一次：真的删？')) return;
        del.disabled = true;
        api('/api/memory/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, confirm: true }) })
          .then(function (res) { setMsg(el('opsMsg'), res.message || '已排队', true); return loadOps(); })
          .catch(function (e) { setMsg(el('opsMsg'), '删除失败：' + e.message, false); del.disabled = false; });
      };
      box.appendChild(del);
    })
    .catch(function (e) { box.textContent = '读取失败：' + e.message; });
}

function opsUrl() {
  var o = state.ops;
  var q = '&limit=' + OPS_LIMIT[o.tab] + '&offset=' + o.offset;
  if (o.q) q += '&q=' + encodeURIComponent(o.q);
  if (o.tab === 'agent') return '/api/agent';
  if (o.tab === 'mem') return '/api/memory/tiers?tier=' + encodeURIComponent(o.tier || '') + q;
  if (o.tab === 'lex') return '/api/lexicon?' + q.slice(1);
  if (o.tab === 'stk') return '/api/stickers?' + q.slice(1);
  return '/api/logs/jsonl?name=' + encodeURIComponent(o.logName) + q;
}

function loadOps() {
  var o = state.ops;
  setMsg(el('opsMsg'), '');
  api(opsUrl())
    .then(function (data) {
      o.total = o.tab === 'agent' ? ((data && data.conversations) || []).length : (Number(data && data.total) || 0);
      if (o.tab === 'agent') data.items = (data && data.conversations) || [];
      renderOps(data);
      var from = o.total ? o.offset + 1 : 0;
      var to = Math.min(o.offset + OPS_LIMIT[o.tab], o.total);
      el('opsPage').textContent = o.total ? (from + '–' + to + ' / 共 ' + o.total + ' 条') : '共 0 条';
      el('opsPrev').disabled = o.offset <= 0;
      el('opsNext').disabled = o.offset + OPS_LIMIT[o.tab] >= o.total;
    })
    .catch(function (e) { opsListBox().textContent = '读取失败：' + e.message; });
}

document.querySelectorAll('#opsTabs button[data-ops]').forEach(function (btn) {
  btn.onclick = function () {
    document.querySelectorAll('#opsTabs button[data-ops]').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    state.ops.tab = btn.dataset.ops;
    state.ops.offset = 0;
    el('opsLogName').classList.toggle('hide', state.ops.tab !== 'log');
    el('opsTier').classList.toggle('hide', state.ops.tab !== 'mem');
    loadOps();
  };
});
el('opsRefresh').onclick = loadOps;
el('opsPrev').onclick = function () { state.ops.offset = Math.max(0, state.ops.offset - OPS_LIMIT[state.ops.tab]); loadOps(); };
el('opsNext').onclick = function () { state.ops.offset += OPS_LIMIT[state.ops.tab]; loadOps(); };
el('opsSearch').addEventListener('input', function () { state.ops.q = this.value.trim(); state.ops.offset = 0; clearTimeout(state.ops.timer); state.ops.timer = setTimeout(loadOps, 300); });
el('opsLogName').onchange = function () { state.ops.logName = this.value; state.ops.offset = 0; loadOps(); };
el('opsTier').onchange = function () { state.ops.tier = this.value; state.ops.offset = 0; loadOps(); };
