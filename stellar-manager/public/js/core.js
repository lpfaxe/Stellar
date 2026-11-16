/* // 页面骨架：全局 state / dirty、标签切换、fetch 封装、状态灯（必须最先加载） */
var state = { status: null, tab: 'overview', logName: 'keepalive', reports: [], reportDate: '', ops: { tab: 'agent', offset: 0, limit: 20, q: '', logName: 'toolcalls', tier: '', total: 0 } };
var dirty = { clock: false, toggles: false };

function el(id) { return document.getElementById(id); }

// ── 底部标签栏：手机上一次只显示一组卡片 ────────────────────────────────────
var TABS = ['overview', 'her', 'people', 'memory', 'ops', 'settings'];
function switchTab(name) {
  if (TABS.indexOf(name) < 0) name = 'overview';
  state.tab = name;
  try { localStorage.setItem('stellar-tab', name); } catch (e) {}
  document.querySelectorAll('main > section.card').forEach(function (card) {
    card.classList.toggle('active', card.dataset.tab === name);
  });
  document.querySelectorAll('#tabbar button').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  /* 换页后重算小条：整页都是小条的页（如「运行日志」）会被整体展开，见 layout.js layoutTabAllMini */
  if (typeof layoutApply === 'function') layoutApply();
  window.scrollTo(0, 0);
}
document.querySelectorAll('#tabbar button').forEach(function (b) {
  b.onclick = function () { switchTab(b.dataset.tab); };
});
// 旧键 surfcore-tab 只读一次做迁移（历史上这个面板叫 surfcore-manager），之后只写 stellar-tab
try {
  state.tab = localStorage.getItem('stellar-tab') || localStorage.getItem('surfcore-tab') || 'overview';
  if (localStorage.getItem('surfcore-tab')) localStorage.removeItem('surfcore-tab');
} catch (e) {}
try {
  var qTab = new URLSearchParams(location.search).get('tab');
  if (qTab) state.tab = qTab;
} catch (e) {}
function setMsg(node, text, ok) {
  node.textContent = text || '';
  node.className = 'msg' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
}

// 请求超时：默认 20 秒，避免弱网/后台卡住时按钮一直转圈。
// 长动作（自检、发说说、重排计划）由调用方传 timeoutMs。
var API_TIMEOUT_MS = 20000;
function api(path, opts) {
  var o = {};
  for (var k in (opts || {})) o[k] = opts[k];
  var timeoutMs = Number(o.timeoutMs) || API_TIMEOUT_MS;
  delete o.timeoutMs;
  if (o.method && o.method !== 'GET') {
    o.headers = o.headers || {};
    o.headers['x-panel-request'] = 'panel';
  }
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  o.signal = ctrl.signal;
  return fetch(path, o).then(function (res) {
    // 会话过期/没登录：让浏览器重新走一遍 gate（它会发登录页或凭口令页换 Cookie），
    // 而不是把「需要口令」当成普通报错挂在卡片上（2026-11-16，本机也要登录了）。
    if (res.status === 401) {
      if (!window.__panelRelogin) {
        window.__panelRelogin = true;
        location.reload();
      }
      const e401 = new Error('需要口令，正在重新打开登录页');
      e401.code = 401;
      throw e401;
    }
    return res.json().then(function (data) {
      if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
      return data;
    });
  }).catch(function (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时了（' + Math.round(timeoutMs / 1000) + ' 秒没回应），稍后重试');
    throw e;
  }).finally(function () { clearTimeout(timer); });
}

function pill(label, on) {
  var wrap = document.createElement('span');
  wrap.className = 'pill';
  var dot = document.createElement('i');
  dot.className = 'dot' + (on ? ' on' : '');
  wrap.appendChild(dot);
  wrap.appendChild(document.createTextNode(label));
  return wrap;
}


// ── 环形进度（SVG 圆环）：h 已完成目标用，比横条省地方 ─────────────────────
// kind: ok（绿）/ acc（蓝紫）/ warn（暖）/ off（灰）；pct 0~100
function ringSvg(pct, kind, size) {
  var p = Math.max(0, Math.min(100, Number(pct) || 0));
  var r = 15.5, c = 2 * Math.PI * r;
  var on = c * p / 100;
  var k = kind || 'acc';
  return '<svg class="ring ring-' + k + '" viewBox="0 0 36 36" width="' + (size || 36) + '" height="' + (size || 36) + '" aria-hidden="true">'
    + '<circle class="ring-bg" cx="18" cy="18" r="' + r + '" fill="none" stroke-width="3"></circle>'
    + '<circle class="ring-fg" cx="18" cy="18" r="' + r + '" fill="none" stroke-width="3" stroke-linecap="round"'
    + ' stroke-dasharray="' + on.toFixed(2) + ' ' + c.toFixed(2) + '" transform="rotate(-90 18 18)"></circle>'
    + '</svg>';
}

// 带文字的环：中间写 have/need，下方一句 label
function ringStat(o) {
  var pct = o.need > 0 ? Math.round(Number(o.have || 0) / Number(o.need) * 100) : 0;
  var kind = o.kind || (pct >= 100 ? 'ok' : pct > 0 ? 'acc' : 'off');
  return '<div class="ring-stat ring-' + kind + '">'
    + '<div class="ring-wrap">' + ringSvg(pct, kind, o.size || 52)
    + '<span class="ring-txt">' + (o.need > 0 ? (o.have || 0) + '<i>/' + o.need + '</i>' : (o.have || 0)) + '</span>'
    + '</div>'
    + '<div class="ring-label">' + (o.label || '') + '</div>'
  '</div>';
}
// ── 通用格式化（memory.js / status.js / ops.js 共用） ───────────────────────
function fmtBytes(n) {
  var v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}

function fmtChars(n) {
  var v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万字';
  return v + ' 字';
}

function fmtAgo(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  var s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}

function prettyKey(key) {
  var k = String(key || '');
  if (k.indexOf('private:') === 0) return '私聊 ' + k.slice(8);
  if (k.indexOf('group:') === 0) return '群 ' + k.slice(6);
  return k || '—';
}

function stateLabel(st) {
  return { ACTIVE: '正在聊', COOLDOWN: '刚说完', LISTEN: '待机', SLEEP: '休眠' }[st] || st || '—';
}

function renderPills(s) {
  var box = el('pills');
  box.textContent = '';
  box.appendChild(pill('SnowLuma', s.ports[5099]));
  box.appendChild(pill('OneBot', s.onebot));
  box.appendChild(pill('桥接', s.ports[3100]));
  box.appendChild(pill('DSH', s.dshRunning));
  box.appendChild(pill('守护 ' + (s.keepalive.configured ? (s.keepalive.lastResult === '0' ? '正常' : '异常 ' + s.keepalive.lastResult) : '未配置'), s.keepalive.configured && s.keepalive.lastResult === '0'));
}
