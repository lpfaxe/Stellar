/* 待发布的视频：她做完一条，主人在这一键通过或驳回；驳回的进「待她重做」区 */
(function () {
  const el = (id) => document.getElementById(id);
  const V = { data: null, open: '', msgTimer: 0, showHistory: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function say(text, bad) {
    const box = el('vlogMsg');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'msg' + (bad ? ' fail' : '');
    clearTimeout(V.msgTimer);
    if (text) V.msgTimer = setTimeout(() => { box.textContent = ''; }, 9000);
  }
  function mmss(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function ago(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }
  const STATUS = { pending: '等你过目', published: '已发布', rejected: '已驳回', failed: '发布失败', dry: '演练过' };

  function renderCost(d) {
    const box = el('vlogCost');
    if (!box) return;
    const c = d.cost || {};
    const pct = c.limitCNY > 0 ? Math.min(100, (Number(c.todayCNY) / Number(c.limitCNY)) * 100) : 0;
    box.innerHTML = [
      '<div class="vlog-meter"><i style="width:' + pct.toFixed(1) + '%"></i></div>',
      '<span class="vlog-cost-text">今天生成 ¥' + Number(c.todayCNY || 0).toFixed(2) + ' / ¥' + Number(c.limitCNY || 0).toFixed(2) + ' · 还剩 ¥' + Number(c.leftCNY || 0).toFixed(2) + '</span>',
      '<span class="vlog-cost-hint">谷期 ' + esc(d.window || '') + ' 自己做 · ' + (d.enabled === false ? '已关掉自动生成' : '自动生成开着') + (d.autoPublish ? ' · 自动发布开着' : ' · 发布要你点头') + '</span>',
    ].join('');
  }

  function thumb(it) {
    return it.cover ? '<img class="vlog-thumb" src="' + esc(it.cover) + '&t=' + encodeURIComponent(it.createdAt || '') + '" alt="">' : '<div class="vlog-thumb empty">无封面</div>';
  }

  function head(it) {
    const st = STATUS[it.status] || it.status;
    const rev = Number(it.revision || 1);
    return [
      '<div class="vlog-head">',
      thumb(it),
      '<div class="vlog-meta">',
      '<div class="vlog-title">' + esc(it.title || '(没写标题)') + ' <span class="vlog-badge ' + esc(it.status) + '">' + esc(st) + '</span>' + (rev > 1 ? ' <span class="vlog-badge rev">第 ' + rev + ' 版</span>' : '') + '</div>',
      '<div class="vlog-sub">' + mmss(it.seconds) + ' · ' + it.scenes + ' 个场景 · ¥' + Number(it.costCNY || 0).toFixed(3) + ' · ' + esc(ago(it.createdAt)) + (it.bvid ? ' · BV' + esc(it.bvid) : '') + '</div>',
      (it.status === 'failed' && it.error) ? '<div class="vlog-err">' + esc(String(it.error).slice(0, 240)) + '</div>' : '',
      it.rejectReason ? '<div class="vlog-rej"><b>你的驳回原因</b>' + esc(it.rejectReason) + '</div>' : '',
      '</div>',
      '</div>',
    ].join('');
  }

  function fallbackHtml(it) {
    return [
      '<div class="vlog-fallback">',
      '<p class="vlog-cost-hint">脚本直传被 B站 挡下了（upos 返回 400，跟文案无关）。成片和文案都还在：</p>',
      '<div class="row wrap">',
      it.video ? '<a class="ghost" href="' + esc(it.video) + '" download>下载成片</a>' : '',
      it.cover ? '<a class="ghost" href="' + esc(it.cover) + '" download>下载封面</a>' : '',
      '<button class="ghost" data-vlog="copy" data-id="' + esc(it.id) + '">复制标题+简介+标签</button>',
      '<a class="ghost" href="' + esc(it.creative) + '" target="_blank" rel="noopener">打开创作中心</a>',
      '</div>',
      '<p class="vlog-cost-hint">传完之后把 BV 号填回来，第二天的复盘和收益统计才对得上。</p>',
      '<div class="row"><input id="vlogBv-' + esc(it.id) + '" placeholder="BV1xx411c7mD" maxlength="12">',
      '<button class="ghost" data-vlog="manual" data-id="' + esc(it.id) + '">我手动传好了</button></div>',
      '</div>',
    ].join('');
  }

  function openHtml(it) {
    return [
      '<div class="vlog-open">',
      it.video ? '<video class="vlog-video" controls preload="metadata" src="' + esc(it.video) + '"></video>' : '<p class="muted">找不到成片文件（可能被清理了）</p>',
      '<label>标题<input id="vlogTitle-' + esc(it.id) + '" value="' + esc(it.title) + '" maxlength="80"></label>',
      '<label>简介<textarea id="vlogDesc-' + esc(it.id) + '" rows="3">' + esc(it.desc) + '</textarea></label>',
      '<label>标签<input id="vlogTags-' + esc(it.id) + '" value="' + esc((it.tags || []).join(',')) + '" placeholder="用逗号分开"></label>',
      '<div class="row wrap"><button class="ghost" data-vlog="save" data-id="' + esc(it.id) + '">保存文案</button>',
      '<a class="ghost" href="' + esc(it.creative) + '" target="_blank" rel="noopener">去创作中心</a></div>',
      it.reflect ? '<pre class="vlog-reflect">' + esc(JSON.stringify(it.reflect, null, 2)) + '</pre>' : '',
      '</div>',
    ].join('');
  }

  // 待审核：她做好还没发（pending），或者上次发布失败了（failed，得再试或驳回）
  function pendingActions(it) {
    const failed = it.status === 'failed';
    return '<div class="row wrap vlog-acts">' +
      '<button class="primary" data-vlog="publish" data-id="' + esc(it.id) + '">' + (failed ? '再试一次' : '通过并发布') + '</button>' +
      '<button class="ghost" data-vlog="dry" data-id="' + esc(it.id) + '">先演练</button>' +
      '<button class="ghost" data-vlog="toggle" data-id="' + esc(it.id) + '">' + (V.open === it.id ? '收起' : '预览 / 改文案') + '</button>' +
      '<button class="ghost danger" data-vlog="reject" data-id="' + esc(it.id) + '">驳回</button>' +
      '</div>';
  }

  // 驳回区：她得按原因重做；或者主人直接说不用了
  function rejectActions(it) {
    return '<div class="row wrap vlog-acts">' +
      '<button class="primary" data-vlog="fix" data-id="' + esc(it.id) + '">让她现在处理</button>' +
      '<button class="ghost" data-vlog="toggle" data-id="' + esc(it.id) + '">' + (V.open === it.id ? '收起' : '看成片 / 改文案') + '</button>' +
      '<button class="ghost" data-vlog="drop" data-id="' + esc(it.id) + '">不用重做了</button>' +
      '</div>';
  }

  function publishedActions(it) {
    return '<div class="row wrap vlog-acts">' +
      (it.bvid ? '<a class="ghost" href="https://www.bilibili.com/video/BV' + esc(it.bvid) + '" target="_blank" rel="noopener">去 B站看</a>' : '') +
      '<button class="ghost" data-vlog="toggle" data-id="' + esc(it.id) + '">' + (V.open === it.id ? '收起' : '看数据') + '</button>' +
      '</div>';
  }

  function itemHtml(it, zone) {
    const open = V.open === it.id;
    const body = open ? openHtml(it) : '';
    const fb = it.status === 'failed' && !open ? fallbackHtml(it) : (open && it.status === 'failed' ? fallbackHtml(it) : '');
    const acts = zone === 'reject' ? rejectActions(it) : (zone === 'pending' ? pendingActions(it) : publishedActions(it));
    return '<div class="vlog-item ' + esc(it.status) + (zone === 'reject' ? ' rework' : '') + '">' + head(it) + body + fb + acts + '</div>';
  }

  function zone(title, hint, items, kind, extraHead) {
    const head2 = items.length
      ? '<h3 class="vlog-zone">' + esc(title) + '<span class="vlog-zone-n">' + items.length + '</span>' + (hint ? '<span class="vlog-zone-hint">' + esc(hint) + '</span>' : '') + (extraHead || '') + '</h3>'
      : '<h3 class="vlog-zone empty">' + esc(title) + '<span class="vlog-zone-hint">' + (hint ? esc(hint) + ' · ' : '') + '现在没有</span>' + (extraHead || '') + '</h3>';
    const body = items.length ? items.map((it) => itemHtml(it, kind)).join('') : '';
    return '<section class="vlog-section">' + head2 + body + '</section>';
  }

  function render() {
    const d = V.data;
    if (!d) return;
    const c = d.counts || {};
    const sum = el('vlogSummary');
    if (sum) {
      const bits = [];
      if (c.pending) bits.push(c.pending + ' 条等你过目');
      if (c.pendingTodo) bits.push(c.pendingTodo + ' 条被驳回待重做');
      if (c.failed) bits.push(c.failed + ' 条发布失败');
      if (!bits.length) bits.push(c.total ? ('没有待处理的（已发布 ' + (c.published || 0) + ' 条）') : '还没做过视频');
      sum.textContent = bits.join(' · ');
    }
    renderCost(d);
    const list = el('vlogList');
    if (!list) return;
    const items = d.items || [];
    const pending = items.filter((x) => x.status === 'pending' || x.status === 'failed');
    const rework = items.filter((x) => x.status === 'rejected' && x.fixState !== 'done');
    const history = items.filter((x) => x.status === 'published' || x.status === 'dry' || (x.status === 'rejected' && x.fixState === 'done'));
    // 只有一条时用条目里的按钮，多条才在区头放一个「一起处理」
    const fixBtn = rework.length > 1
      ? '<button class="ghost vlog-zone-btn" data-vlog="fix" data-id="">让她一起处理</button>'
      : '';
    const html = [
      zone('待审核', '她做好了，等你点头', pending, 'pending'),
      zone('驳回 · 待她重做', rework.length ? '她按你的原因改完会回到上面的待审核' : '被你驳回的都在这，等她重做', rework, 'reject', fixBtn),
    ];
    if (history.length) {
      html.push('<section class="vlog-section">' +
        '<h3 class="vlog-zone"><button class="vlog-toggle-hist" data-vlog="history">' + (V.showHistory ? '▾' : '▸') + ' 历史（已发布 / 演练 / 已重做）' + '</button><span class="vlog-zone-n">' + history.length + '</span></h3>' +
        (V.showHistory ? history.map((it) => itemHtml(it, 'history')).join('') : '') +
        '</section>');
    }
    list.innerHTML = (pending.length || rework.length || history.length)
      ? html.join('')
      : '<p class="muted">今天还没做。到谷期（' + esc(d.window || '') + '）她自己做一条，做好就出现在这里。</p>';
  }

  async function load() {
    try {
      const r = await fetch('/api/vlog?limit=30', { headers: { 'x-panel-request': 'panel' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      V.data = await r.json();
      render();
    } catch (e) {
      const list = el('vlogList');
      if (list) list.innerHTML = '<p class="muted">读取失败：' + esc(String(e.message || e)) + '</p>';
    }
  }

  async function act(action, id, extra) {
    const body = Object.assign({ action, id: id || '' }, extra || {});
    const r = await fetch('/api/vlog/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-panel-request': 'panel' },
      body: JSON.stringify(body),
    });
    return await r.json().catch(() => ({ ok: false, message: 'HTTP ' + r.status }));
  }

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-vlog]');
    if (!btn) return;
    const op = btn.dataset.vlog;
    const id = btn.dataset.id;
    const it = (V.data?.items || []).find((x) => x.id === id);

    if (op === 'history') { V.showHistory = !V.showHistory; render(); return; }
    if (op === 'toggle') { V.open = V.open === id ? '' : id; render(); return; }

    if (op === 'reject') {
      const reason = prompt('驳回原因（她会看到这句，照着改）', '这条先不发');
      if (reason === null) return;
      btn.disabled = true;
      const j = await act('reject', id, { reason });
      btn.disabled = false;
      say(j.ok ? '已驳回，挪到「驳回 · 待她重做」了' : (j.message || '驳回失败'), !j.ok);
      V.open = '';
      load();
      return;
    }

    if (op === 'fix') {
      btn.disabled = true;
      const j = await act('fix-request', id, { fixId: id || '' });
      btn.disabled = false;
      say(j.message || (j.ok ? '已叫她处理' : '没成功'), !j.ok);
      if (j.ok) setTimeout(load, 90_000);
      return;
    }

    if (op === 'drop') {
      if (!confirm('标记「不用重做了」？\n\n这条会从驳回区收进历史，她不会再按它重做。')) return;
      btn.disabled = true;
      const j = await act('rework-done', id, { note: '主人在控制台标记不用重做' });
      btn.disabled = false;
      say(j.message || (j.ok ? '已标记完成' : '没成功'), !j.ok);
      load();
      return;
    }

    if (op === 'save') {
      const title = el('vlogTitle-' + id)?.value || '';
      const desc = el('vlogDesc-' + id)?.value || '';
      const tags = (el('vlogTags-' + id)?.value || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      btn.disabled = true;
      const j = await act('save', id, { title, desc, tags });
      btn.disabled = false;
      say(j.ok ? '文案已保存' : (j.message || '保存失败'), !j.ok);
      load();
      return;
    }

    if (op === 'copy') {
      const text = ['标题：' + (it?.title || ''), '', '简介：', it?.desc || '', '', '标签：' + ((it?.tags || []).join(' ') || '')].join('\n');
      try { await navigator.clipboard.writeText(text); say('已复制，粘贴到投稿页就行'); }
      catch (e) { prompt('复制下面这些（Ctrl+C / 长按复制）', text); }
      return;
    }

    if (op === 'manual') {
      const bvid = (el('vlogBv-' + id)?.value || '').trim();
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) { say('BV 号看起来不对（形如 BV1xx411c7mD）', true); return; }
      if (!confirm('登记为已发布：' + bvid + '？\n\n只登记，不会替你投稿。')) return;
      btn.disabled = true;
      const j = await act('manual', id, { bvid });
      btn.disabled = false;
      say(j.message || (j.ok ? '已登记' : '登记失败'), !j.ok);
      load();
      return;
    }

    if (op === 'dry' || op === 'publish') {
      const label = op === 'dry' ? '演练（上传但不在 B站 公开）' : '正式发布';
      if (!confirm('确认「' + label + '」？\n\n标题：' + (it?.title || '') + '\n时长：' + mmss(it?.seconds) + '\n\n发布后 B站 那边就撤不回来了。')) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = op === 'dry' ? '演练中…' : '发布中…';
      const j = await act('publish', id, { confirm: true, dry: op === 'dry' });
      btn.disabled = false;
      btn.textContent = old;
      say(j.message || (j.ok ? '完成' : '失败'), !j.ok);
      load();
    }
  });

  const refresh = el('vlogRefresh');
  if (refresh) refresh.addEventListener('click', load);
  window.loadVlog = load;
  load();
})();
