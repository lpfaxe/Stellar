/* 手机访问：局域网地址、口令、复制链接、Cloudflare 隧道 */
// ── 手机访问 ────────────────────────────────────────────────────────────────
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise(function (resolve, reject) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); } finally { document.body.removeChild(ta); }
  });
}

// 一次性登录码：链接里只放 5 分钟有效、只能用一次的 code，不再塞长期口令。
function loginCodeUrl(base) {
  return api('/api/login-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(function (r) {
      if (!r || !r.code) throw new Error((r && r.message) || '没拿到登录码');
      return base.replace(/\/+$/, '') + '/?code=' + encodeURIComponent(r.code);
    });
}

function renderAccess(a) {
  if (!a) return;
  var box = el('accessUrls');
  box.textContent = '';
  var urls = a.urls || [];
  if (!urls.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '没找到局域网地址，确认电脑连的是 WiFi/网线。';
    box.appendChild(p);
  }
  urls.forEach(function (u) {
    var row = document.createElement('div');
    row.className = 'access-url';
    var code = document.createElement('code');
    code.textContent = u;
    var btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = '复制带口令链接';
    btn.onclick = function () {
      var b = btn;
      b.disabled = true;
      loginCodeUrl(u + '/').then(function (link) { return copyText(link).then(function () { setMsg(el('accessMsg'), '已复制，5 分钟内有效；过期就再点一次', true); }); })
        .catch(function (e) { setMsg(el('accessMsg'), '生成链接失败：' + e.message, false); })
        .then(function () { b.disabled = false; });
    };
    row.appendChild(code);
    row.appendChild(btn);
    box.appendChild(row);
  });
  // Tailscale 内网地址：有才显示（这是不走公网的固定入口）
  var tnBox = el('tailnetBox');
  var tnUrls = a.tailnetUrls || [];
  if (tnBox) {
    tnBox.classList[tnUrls.length ? 'remove' : 'add']('hide');
    if (tnUrls.length && el('tailnetUrls')) el('tailnetUrls').textContent = tnUrls.join('  ');
  }
  // 装好 Tailscale 之后就不用再看「怎么装」那段了
  var tnSetup = el('tailnetSetup');
  if (tnSetup) tnSetup.classList[tnUrls.length ? 'add' : 'remove']('hide');
  renderV6(a);
  renderTunnel(a.tunnel);
  el('accessToken').textContent = a.localOnly ? '只在电脑上显示' : (a.token || '----');
  if (el('sessionCount')) el('sessionCount').textContent = a.localOnly ? '口令不在外网显示，回电脑上换' : '';
  if (!el('accessCopy')) return;
  el('accessCopy').onclick = function () {
    var base = urls.length ? urls[0] + '/' : 'http://127.0.0.1:' + (a.port || 3300) + '/';
    loginCodeUrl(base).then(function (link) { return copyText(link).then(function () { setMsg(el('accessMsg'), '已复制，5 分钟内有效；过期就再点一次', true); }); })
      .catch(function (e) { setMsg(el('accessMsg'), '生成链接失败：' + e.message, false); });
  };
  if (el('tokenRotate')) el('tokenRotate').onclick = function () {
    if (!confirm('换口令后，所有手机/平板都要重新输入新口令。继续？')) return;
    var btn = this;
    btn.disabled = true;
    api('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rotate-token' }) })
      .then(function (r) {
        el('accessToken').textContent = r.token || '';
        setMsg(el('tokenMsg'), r.message || '已换', true);
      })
      .catch(function (e) { setMsg(el('tokenMsg'), '失败：' + e.message, false); })
      .then(function () { btn.disabled = false; });
  };
}

function renderTunnel(t) {
  var box = el('tunnelUrl');
  if (!box) return;
  box.textContent = '';
  var p = document.createElement('p');
  p.className = 'muted';
  if (!t) { box.appendChild(p); return; }
  if (!t.binary) {
    p.textContent = '远程通道没装好（缺 cloudflared.exe），只能用同一 WiFi。';
    box.appendChild(p);
    return;
  }
  if (t.url) {
    var row = document.createElement('div');
    row.className = 'access-url';
    var code = document.createElement('code');
    code.textContent = t.url + '/';
    var btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = '复制带口令链接';
    btn.onclick = function () {
      var b = btn;
      b.disabled = true;
      loginCodeUrl(t.url + '/').then(function (link) { return copyText(link).then(function () { setMsg(el('tunnelMsg'), '已复制，5 分钟内有效；过期就再点一次', true); }); })
        .catch(function (e) { setMsg(el('tunnelMsg'), '生成链接失败：' + e.message, false); })
        .then(function () { b.disabled = false; });
    };
    row.appendChild(code);
    row.appendChild(btn);
    box.appendChild(row);
    var mode = t.mode === 'named' ? '命名隧道（域名固定）' : '快速隧道（重启会变地址）';
    p.textContent = (t.running ? '隧道在跑' : '隧道没在跑') + (t.at ? '，' + fmtTime(t.at) + ' 建立' : '') + ' · ' + mode;
    box.appendChild(p);
    renderTunnelConfig(t);
    return;
  }
  p.textContent = t.enabled
    ? '正在建立隧道…十几秒后点「刷新」或等一下自动刷新'
    : '远程访问没开，点「开启远程访问」就行';
  box.appendChild(p);
  renderTunnelConfig(t);
}

// 命名隧道的状态行：现在是什么模式、有没有 token、固定域名配好没
function renderTunnelConfig(t) {
  var line = el('tnState');
  if (line) {
    var bits = [];
    bits.push(t.mode === 'named' ? '现在是命名隧道' : '现在是快速隧道');
    bits.push(t.hasToken ? 'token 已存' : 'token 没填');
    bits.push(t.hostname ? '域名 ' + t.hostname : '域名没填');
    if (t.error) bits.push('错误：' + t.error);
    line.textContent = bits.join(' · ');
  }
  if (el('tnHost') && !el('tnHost').value && t.hostname) el('tnHost').value = t.hostname;
}

function tunnelNamedAction(action, body) {
  setMsg(el('tnMsg'), '处理中…', true);
  api('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action }, body || {})) })
    .then(function (r) {
      setMsg(el('tnMsg'), (r.ok ? '✓ ' : '✗ ') + (r.message || ''), r.ok);
      if (r.ok && el('tnToken')) el('tnToken').value = '';
      return loadStatus();
    })
    .then(function () { setTimeout(loadStatus, 4000); setTimeout(loadStatus, 12000); })
    .catch(function (e) { setMsg(el('tnMsg'), '失败：' + e.message, false); });
}

function tunnelAction(action) {
  var label = action === 'tunnel-start' ? '开启远程访问' : '关闭远程访问';
  setMsg(el('tunnelMsg'), label + '…', true);
  api('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: action }) })
    .then(function (r) {
      setMsg(el('tunnelMsg'), (r.ok ? '✓ ' : '✗ ') + (r.message || ''), r.ok);
      return loadStatus();
    })
    .then(function () { setTimeout(loadStatus, 4000); setTimeout(loadStatus, 12000); })
    .catch(function (e) { setMsg(el('tunnelMsg'), '失败：' + e.message, false); });
}
if (el('tnSave')) el('tnSave').onclick = function () {
  var token = el('tnToken') ? el('tnToken').value.trim() : '';
  var host = el('tnHost') ? el('tnHost').value.trim() : '';
  if (!host) { setMsg(el('tnMsg'), '先把对外域名填上（Cloudflare 里配的，比如 panel.example.com）', false); return; }
  tunnelNamedAction('tunnel-named', { token: token, hostname: host });
};
if (el('tnQuick')) el('tnQuick').onclick = function () {
  if (!confirm('切回快速隧道？固定域名会停用，地址每次重启都会变。')) return;
  tunnelNamedAction('tunnel-quick');
};
if (el('tunnelStart')) el('tunnelStart').onclick = function () { tunnelAction('tunnel-start'); };
if (el('tunnelStop')) el('tunnelStop').onclick = function () { tunnelAction('tunnel-stop'); };

// ── 公网 IPv6 直连 + 可写白名单 ──────────────────────────────────────────
// 面板默认监听 ::（双栈），所以这台机器的公网 IPv6 能直接从外网打开。
// 但公网来源默认只读：要把常用网段加进白名单才可写。名单只能在本机改。
var V6_STATE = { prefixes: [], canManage: false };
function escV6(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderV6(a) {
  var box = el('v6Box');
  if (!box) return;
  var urls = a.v6Urls || [];
  // 卡片本身不再整块藏起来：关了公网直连也要把「为什么关、怎么再开」说清楚。
  box.classList.remove('hide');
  var list = el('v6Urls'); if (list) list.classList[urls.length ? 'remove' : 'add']('hide');
  var off = el('v6OffNote'); if (off) off.classList[urls.length ? 'add' : 'remove']('hide');
  if (el('v6Urls')) {
    // 必须做成可点的链接：手机上手输 IPv6 的方括号很容易变成全角，
    // 浏览器就会把整串当搜索词（这是「粘进去却去搜索」的真正原因）。
    el('v6Urls').innerHTML = urls.map(function (u, i) {
      return '<div class="v6-url"><a href="' + escV6(u) + '" target="_blank" rel="noreferrer">' + escV6(u) + '</a>'
        + '<button class="ghost small v6-copy" data-url="' + escV6(u) + '">复制</button></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.v6-copy'), function (b) {
      b.onclick = function () {
        copyText(b.getAttribute('data-url')).then(function () { setMsg(el('v6Msg'), '地址已复制，直接粘进手机浏览器地址栏', true); })
          .catch(function () { setMsg(el('v6Msg'), '复制失败，长按上面那条地址手动复制', false); });
      };
    });
  }
  V6_STATE.prefixes = (a.remoteAllow && a.remoteAllow.prefixes) || [];
  renderV6Allow(a);
  loadV6Allow();
}
function renderV6Allow(a) {
  var state = el('v6AllowState');
  if (!state) return;
  var mine = a.remoteAllowed ? '当前这台设备在白名单里，可以改东西。' : '当前来源不在白名单，只能看和点审批。';
  if ((a.scope || '') === 'local') mine = '你正在这台电脑上，本来就是可写。';
  state.textContent = (V6_STATE.prefixes.length ? '白名单 ' + V6_STATE.prefixes.length + ' 条 · ' : '白名单空（公网来源一律只读） · ') + mine;
}
function v6ListHtml() {
  if (!V6_STATE.prefixes.length) return '还没有登记任何网段。';
  return V6_STATE.prefixes.map(function (p) {
    return '<div class="row wrap v6-item"><code>' + escV6(p.cidr) + '</code>' + (p.label ? ' <span class="muted">' + escV6(p.label) + '</span>' : '') + ' <button class="ghost small v6-del" data-cidr="' + escV6(p.cidr) + '">删掉</button></div>';
  }).join('');
}
function loadV6Allow() {
  api('/api/remote-allow').then(function (r) {
    V6_STATE.prefixes = r.prefixes || [];
    V6_STATE.canManage = !!r.canManage;
    var list = el('v6List');
    if (list) list.innerHTML = v6ListHtml();
    if (el('v6Add')) el('v6Add').disabled = !V6_STATE.canManage;
    if (el('v6Clear')) el('v6Clear').disabled = !V6_STATE.canManage;
    Array.prototype.forEach.call(document.querySelectorAll('.v6-del'), function (b) {
      b.onclick = function () { v6Action('remove', b.getAttribute('data-cidr'), ''); };
    });
  }).catch(function () {});
}
function v6Action(action, cidr, label) {
  return api('/api/remote-allow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: action, cidr: cidr, label: label }) })
    .then(function (r) {
      V6_STATE.prefixes = r.prefixes || [];
      var list = el('v6List');
      if (list) list.innerHTML = v6ListHtml();
      setMsg(el('v6Msg'), action === 'add' ? '加好了' : (action === 'clear' ? '清空了' : '删掉了'), true);
      loadV6Allow();
    })
    .catch(function (e) { setMsg(el('v6Msg'), '失败：' + e.message, false); });
}
document.addEventListener('DOMContentLoaded', function () {
  if (el('v6Add')) el('v6Add').onclick = function () {
    var cidr = String((el('v6Cidr') || {}).value || '').trim();
    if (!cidr) return setMsg(el('v6Msg'), '先填一个网段', false);
    v6Action('add', cidr, String((el('v6Label') || {}).value || '').trim());
  };
  if (el('v6Clear')) el('v6Clear').onclick = function () {
    if (!confirm('清空后，所有公网 IPv6 来源都只能只读。继续？')) return;
    v6Action('clear', '', '');
  };
});
