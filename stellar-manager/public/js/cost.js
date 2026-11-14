/* // 今天的花费：金额、分类、分时柱状图 */
// ── 今天的花费 ──────────────────────────────────────────────────────────────
function fmtMoney(v, symbol) {
  var n = Number(v) || 0;
  var s = symbol || '¥';
  if (n >= 1) return s + n.toFixed(2);
  if (n >= 0.01) return s + n.toFixed(3);
  return s + n.toFixed(4);
}
function fmtTokens(n) {
  var v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}
function fmtPct(v) { return (Number(v) * 100).toFixed(1) + '%'; }
function fmtTime(ms) {
  if (!ms) return '';
  var d = new Date(Number(ms));
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function costBar(width, color) {
  var bar = document.createElement('div');
  bar.className = 'c-bar';
  var i = document.createElement('i');
  i.style.width = Math.max(1, Math.min(100, Math.round((Number(width) || 0) * 100))) + '%';
  if (color) i.style.background = color;
  bar.appendChild(i);
  return bar;
}
function costRow(name, hint, barWidth, color, main, sub) {
  var row = document.createElement('div');
  row.className = 'cost-row';
  var n = document.createElement('div');
  n.className = 'c-name';
  n.textContent = name;
  if (hint) { var em = document.createElement('em'); em.textContent = hint; n.appendChild(em); }
  row.appendChild(n);
  row.appendChild(costBar(barWidth, color));
  var v = document.createElement('div');
  v.className = 'c-val';
  var b = document.createElement('b');
  b.textContent = main;
  v.appendChild(b);
  if (sub) v.appendChild(document.createTextNode(' ' + sub));
  row.appendChild(v);
  return row;
}

function renderCost(c) {
  var sym = (c.prices && c.prices.symbol) || '¥';
  el('costTotal').textContent = fmtMoney(c.totals.cost, sym);
  el('costTokens').textContent = fmtTokens(c.totals.tokens) + ' tokens' + (c.perf && c.perf.turns ? ' · ' + c.perf.turns + ' 轮 / ' + c.perf.steps + ' 次调用' : '');

  var budget = c.budget || {};
  if (budget.limitCny) {
    var pct = Math.round((budget.share || 0) * 100);
    el('costBar').style.width = Math.min(100, pct) + '%';
    el('costBar').style.background = (budget.share || 0) > 0.8 ? 'linear-gradient(90deg,#f0b24a,#f06a6a)' : 'linear-gradient(90deg,#48d18a,#7aa2ff)';
    el('costBudgetText').textContent = '今日预算 ' + fmtMoney(budget.limitCny, sym) + ' · 已用 ' + fmtPct(budget.share || 0) + (budget.remaining === null ? '' : ' · 还剩 ' + fmtMoney(budget.remaining, sym)) + (budget.gateBlocked ? ' · 已触发预算闸，她不再自动醒来' : '');
  } else {
    el('costBar').style.width = '0%';
    el('costBudgetText').textContent = '没设每日预算（token-budget.json 的 limits.total.cny 为空）';
  }

  var COLORS = {
    qq: 'linear-gradient(90deg,#7aa2ff,#4f7cff)',
    bili: 'linear-gradient(90deg,#48d18a,#2fae74)',
    other: 'linear-gradient(90deg,#8b93a5,#6c7489)'
  };
  var catBox = el('costCats');
  catBox.textContent = '';
  (c.categories || []).forEach(function (cat) {
    catBox.appendChild(costRow(cat.label, cat.hint, cat.share, COLORS[cat.key], fmtMoney(cat.cost, sym), '· ' + fmtPct(cat.share) + ' · ' + fmtTokens(cat.tokens) + ' tokens'));
  });

  var peerBox = el('costPeers');
  peerBox.textContent = '';
  var peers = c.peers || [];
  var peerTotal = c.peerTotal || {};
  if (!peers.length) {
    var pn = document.createElement('p');
    pn.className = 'muted';
    pn.textContent = '今天还没有跟谁聊过。';
    peerBox.appendChild(pn);
  } else {
    peers.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'peer';
      var av = document.createElement('span');
      av.className = 'peer-avatar';
      av.textContent = (p.name || '?').slice(0, 1);
      if (p.avatar) { av.style.backgroundImage = 'url(' + p.avatar + ')'; av.textContent = ''; }
      row.appendChild(av);
      var main = document.createElement('div');
      main.className = 'peer-main';
      var top = document.createElement('div');
      top.className = 'peer-top';
      var nm = document.createElement('b');
      nm.textContent = p.name || p.key;
      top.appendChild(nm);
      if (p.relation) { var rel = document.createElement('em'); rel.textContent = p.relation; top.appendChild(rel); }
      var money = document.createElement('span');
      money.className = 'peer-money';
      money.textContent = fmtMoney(p.cost, sym);
      top.appendChild(money);
      main.appendChild(top);
      main.appendChild(costBar(p.share, 'linear-gradient(90deg,#7aa2ff,#4f7cff)'));
      var sub = document.createElement('small');
      sub.className = 'peer-sub';
      sub.textContent = fmtTokens(p.tokens) + ' tokens · ' + (p.turns || 0) + ' 轮 · ' + fmtPct(p.share) + ' 的 QQ 花费' + (p.lastAt ? ' · 最后 ' + fmtTime(p.lastAt) : '');
      main.appendChild(sub);
      row.appendChild(main);
      peerBox.appendChild(row);
    });
  }
  if (el('costPeerHint')) {
    el('costPeerHint').textContent = peerTotal.count
      ? (peerTotal.count + ' 个人 · QQ 共 ' + fmtMoney(peerTotal.cost, sym))
      : '按人汇总 QQ 花费';
  }

  var sesBox = el('costSessions');
  sesBox.textContent = '';
  if (!(c.sessions || []).length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '今天还没有调用记录。';
    sesBox.appendChild(p);
  }
  (c.sessions || []).forEach(function (s) {
    var sub = '· ' + fmtPct(s.cacheHitRate) + ' 命中';
    if (s.turns) sub = '· ' + s.turns + ' 轮 · ' + fmtPct(s.cacheHitRate) + ' 命中';
    if (s.lastAt) sub += ' · 最后 ' + fmtTime(s.lastAt);
    sesBox.appendChild(costRow(s.label, s.hint, s.share, COLORS[s.kind] || COLORS.other, fmtMoney(s.cost, sym), sub));
  });

  var bucketColors = {
    cacheHit: 'linear-gradient(90deg,#48d18a,#2fae74)',
    cacheMiss: 'linear-gradient(90deg,#7aa2ff,#4f7cff)',
    cacheWrite: 'linear-gradient(90deg,#8b93a5,#6c7489)',
    output: 'linear-gradient(90deg,#f0b24a,#e0952f)'
  };
  var bBox = el('costBuckets');
  bBox.textContent = '';
  (c.buckets || []).forEach(function (b) {
    bBox.appendChild(costRow(b.label, '', b.share, bucketColors[b.key], fmtMoney(b.cost, sym), '· ' + fmtPct(b.share) + ' · ' + fmtTokens(b.tokens) + ' tokens'));
  });

  var cache = c.cache || {};
  el('costCache').textContent = cache.hitTokens
    ? '缓存命中率 ' + fmtPct(cache.hitRate) + '：' + fmtTokens(cache.hitTokens) + ' tokens 只花了 ' + fmtMoney(cache.actualCost, sym) + '；这些量如果全按未命中价（每百万 ¥1）要 ' + fmtMoney(cache.missCost, sym) + '，等于省下 ' + fmtMoney(cache.saved, sym) + '。'
    : '今天还没有缓存命中记录。';

  var chart = el('costChart');
  chart.textContent = '';
  var hourly = c.hourly || [];
  var max = hourly.reduce(function (m, h) { return Math.max(m, h.cost || 0); }, 0);
  hourly.forEach(function (h) {
    var col = document.createElement('div');
    col.className = 'c-col';
    var bar = document.createElement('i');
    var pctH = max > 0 ? Math.round((h.cost / max) * 100) : 0;
    bar.style.height = Math.max(h.cost > 0 ? 4 : 1, pctH) + '%';
    bar.style.opacity = h.cost > 0 ? '1' : '0.25';
    bar.title = ('0' + h.h).slice(-2) + ':00 · ' + fmtMoney(h.cost, sym) + ' · ' + fmtTokens(h.tokens) + ' tokens';
    col.appendChild(bar);
    var lab = document.createElement('span');
    lab.textContent = h.h % 4 === 0 ? ('0' + h.h).slice(-2) : '';
    col.appendChild(lab);
    chart.appendChild(col);
  });
  var seriesHint = el('costSeriesHint');
  seriesHint.textContent = 'QQ 聊天分时（桥接账本，30 分钟一格）；B站花费没有分时明细';
  var note = '账本 ' + (c.ledger && c.ledger.at ? fmtTime(c.ledger.at) : '未更新') + ' 更新 · 价目表 ' + ((c.prices && c.prices.version) || '—') + ' · 现在' + ((c.prices && c.prices.tierLabel) || '空闲时段') + '（高峰周一至周五 9:00–12:00 / 14:00–18:00 单价 ×2）';
  if (c.busiest) note += ' · 最贵的一小时 ' + ('0' + c.busiest.h).slice(-2) + ':00，' + fmtMoney(c.busiest.cost, sym);
  el('costNote').textContent = note;

  setMsg(el('costMsg'), (c.errors || []).join('；'), (c.errors || []).length ? false : null);
}

function loadCost() {
  return api('/api/cost').then(renderCost).catch(function (e) {
    setMsg(el('costMsg'), '读取失败：' + e.message, false);
  });
}
el('costRefresh').onclick = loadCost;
