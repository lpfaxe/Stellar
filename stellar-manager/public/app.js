/* 最小控制台前端：只调本目录 server.mjs 暴露的接口，不直接碰桥接，也不碰令牌。 */
const $ = (id) => document.getElementById(id);
const state = { logName: 'plugin', overview: null, busy: false };

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return '¥' + v.toFixed(2);
}

function tokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M tokens';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K tokens';
  return Math.round(v) + ' tokens';
}

function when(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return '';
  const d = new Date(v);
  const p2 = (x) => String(x).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

function pill(el, cls, text) {
  el.className = 'pill ' + cls;
  el.textContent = text;
}

const MODE_TEXT = { normal: '正常模式', idle: '摸鱼模式', minimal: '最低限度' };
const SRC_TEXT = { manual: '手动指定的，今天有效', config: '按配置里的 runMode', weekend: '周末默认摸鱼', 'default': '默认' };

function render(data) {
  state.overview = data;
  const b = data.bridge || {};
  const st = b.status || {};
  pill($('pillBridge'), b.reachable ? 'ok' : 'bad', b.reachable ? '桥接在线' : '桥接不通');
  pill($('pillDsh'), st.dshReady ? 'ok' : (b.reachable ? 'warn' : ''), 'DSH' + (st.dshReady ? ' 就绪' : (b.reachable ? ' 未就绪' : ' 未知')));
  const snow = st.snowluma || {};
  const snowOk = snow.connected === true || snow.ok === true;
  pill($('pillSnow'), b.reachable ? (snowOk ? 'ok' : 'warn') : '', 'SnowLuma' + (b.reachable ? (snowOk ? ' 已连接' : ' 未连接') : ' 未知'));

  const rm = data.runMode || {};
  $('sMode').textContent = MODE_TEXT[rm.mode] || rm.mode || '—';
  $('sModeSrc').textContent = SRC_TEXT[rm.source] || (rm.ok ? '' : (rm.message || '读不到运行模式'));
  $('sRole').textContent = st.role || '—';
  $('sRoleMode').textContent = st.roleMode ? ('人格状态：' + st.roleMode) : '';
  // 桥接 /api/tokens/daily 的形状是 usage.total.{cost,tokens}；老版本给的是 totalCost/totalTokens，
  // 两个都认，省得换一版桥接就变成两个「—」。
  const usage = (data.tokens && data.tokens.usage) || {};
  const total = usage.total || {};
  const cost = total.cost != null ? total.cost : usage.totalCost;
  const count = total.tokens != null ? total.tokens : usage.totalTokens;
  $('sCost').textContent = cost != null ? money(cost) : '—';
  $('sTokens').textContent = [tokens(count), usage.stale ? '（快照有点旧）' : ''].filter(Boolean).join(' ');
  const sessions = (data.sessions && data.sessions.sessions) || [];
  $('sSessions').textContent = sessions.length ? sessions.length + ' 个' : '0';
  const pending = (data.pending && data.pending.pending) || [];
  $('sPending').textContent = pending.length ? (pending.length + ' 个待批') : '没有等她批的东西';

  const note = $('bridgeNote');
  if (!b.reachable) {
    note.className = 'note bad';
    note.textContent = '连不上桥接（127.0.0.1:' + (b.port || '?') + '）：' + (b.error || '未知原因') + '。先双击「首次启动.bat」或看下面的日志。';
  } else {
    note.className = 'note';
    const allow = (st.allowPrivate || []).length + (st.allowGroups || []).length;
    note.textContent = '主人 QQ：' + (st.ownerQQ || '没填（config.json 的 ownerQQ）') + ' · 白名单 ' + allow + ' 条' + (allow ? '' : '（空 = 谁都不理）') + ' · 桥接模式 ' + (st.mode || '—');
  }

  const modeRow = $('modeRow');
  for (const btn of modeRow.querySelectorAll('.mode')) {
    btn.classList.toggle('on', btn.dataset.mode === rm.mode);
  }
  $('modeNote').textContent = rm.ok
    ? ('现在：' + (MODE_TEXT[rm.mode] || rm.mode) + (rm.source === 'manual' ? '（手动指定，跨天自动回到默认）' : ''))
    : (rm.message || '读不到运行模式');

  renderTodos(data.todos);
}

function renderTodos(todos) {
  const list = $('todoList');
  const rows = (todos && todos.rows) || [];
  if (!rows.length) {
    list.innerHTML = '<li class="empty">还没有待办。上面写一句、选个时间就能替她记下。</li>';
    return;
  }
  list.innerHTML = rows.map((it) => {
    const who = it.targetName ? '<span class="who">' + esc(it.targetName) + '</span>' : (it.targetKey ? '<span class="who">' + esc(it.targetKey) + '</span>' : '');
    return '<li><span class="t">' + esc(it.text) + '</span>' + who +
      '<span class="when">' + esc(when(it.dueAt)) + '</span>' +
      '<button data-done="' + esc(it.id) + '">办完了</button></li>';
  }).join('');
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    err.hint = data && data.hint;
    throw err;
  }
  return data;
}

async function loadOverview() {
  if (state.busy) return;
  state.busy = true;
  try {
    render(await getJson('/api/overview'));
  } catch (error) {
    const note = $('bridgeNote');
    note.className = 'note bad';
    note.textContent = '读不到状态：' + error.message + (error.hint ? ('。' + error.hint) : '');
  } finally {
    state.busy = false;
  }
}

async function loadLog() {
  const box = $('logBox');
  box.textContent = '读取中…';
  try {
    const data = await getJson('/api/log?name=' + encodeURIComponent(state.logName) + '&lines=200');
    box.textContent = data.ok ? ((data.lines || []).join('\n') || '（文件是空的）') : (data.message + (data.hint ? ('\n\n' + data.hint) : ''));
  } catch (error) {
    box.textContent = '读不到日志：' + error.message;
  }
}

async function setMode(mode) {
  const note = $('modeNote');
  note.textContent = '切换中…';
  try {
    await getJson('/api/run-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    await loadOverview();
  } catch (error) {
    note.textContent = '没切成：' + error.message;
  }
}

async function addTodo(event) {
  event.preventDefault();
  const text = $('todoText').value.trim();
  const whenVal = $('todoWhen').value;
  const msg = $('todoMsg');
  if (!text) { msg.textContent = '先写清楚要提醒什么'; return; }
  if (!whenVal) { msg.textContent = '再选一个提醒时间'; return; }
  const dueAt = new Date(whenVal).getTime();
  if (!Number.isFinite(dueAt)) { msg.textContent = '时间格式不对，重新选一次'; return; }
  msg.textContent = '记下中…';
  try {
    await getJson('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, dueAt }),
    });
    $('todoText').value = '';
    msg.textContent = '记下了，到点她会来提醒。';
    await loadOverview();
  } catch (error) {
    msg.textContent = '没记上：' + error.message;
  }
}

async function doneTodo(id) {
  try {
    await getJson('/api/todos/done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await loadOverview();
  } catch (error) {
    $('todoMsg').textContent = '划不掉：' + error.message;
  }
}

function defaultWhen() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  const p2 = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

$('btnRefresh').addEventListener('click', () => { loadOverview(); loadLog(); });
$('modeRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode');
  if (btn) setMode(btn.dataset.mode);
});
$('todoForm').addEventListener('submit', addTodo);
$('todoList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-done]');
  if (btn) doneTodo(btn.dataset.done);
});
$('logSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-log]');
  if (!btn) return;
  state.logName = btn.dataset.log;
  for (const b of $('logSeg').querySelectorAll('button')) b.classList.toggle('on', b === btn);
  loadLog();
});

$('todoWhen').value = defaultWhen();
loadOverview();
loadLog();
setInterval(loadOverview, 15000);
setInterval(loadLog, 30000);
