/* 主人的文件柜（owner 2026-11-20 要的）。
 * 目录 ~/.dsh/stellar/files/，跨天保留；控制台能看列表、加文件、删文件、下载。
 * 重点：这些文件**不会**自动进她的提示词。她要用时自己调 stellar_file_list 查、
 * stellar_file_read(path=...) 读单个，所以这里放多少都不占每轮 token。
 */
var FILES = { data: null, canWrite: true, busy: false };

function fcEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function fcSize(n) {
  var b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
function fcTime(at) {
  if (!at) return '';
  var d = new Date(Number(at));
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
var FC_KIND = { word: 'Word', excel: 'Excel', ppt: 'PPT', pdf: 'PDF', text: '文本', image: '图片', archive: '压缩包', other: '文件' };

function fcRenderLog(d) {
  var box = el('fcLog');
  if (!box) return;
  var rows = (d.log || []).map(function (r) {
    var tag = r.kind === 'delete' ? '删' : '加';
    var cls = r.kind === 'delete' ? 'del' : '';
    return '<div class="wi-log-row"><span class="wi-log-tag ' + cls + '">' + tag + '</span>' +
      '<span class="wi-log-name">' + fcEsc(r.name) + '</span>' +
      '<span class="wi-log-by">' + fcEsc(r.by || '') + '</span>' +
      '<span class="wi-log-at">' + fcTime(r.at) + '</span></div>';
  });
  box.innerHTML = rows.length ? rows.join('') : '<div class="muted small">还没有操作记录。</div>';
}

function fcRender(data) {
  if (data) FILES.data = data;
  var d = FILES.data || {};
  FILES.canWrite = d.canWrite !== false;
  var list = el('fcList');
  if (!list) return;
  if (el('fcSummary')) el('fcSummary').textContent = (d.count || 0) + ' 个文件 · 共 ' + fcSize(d.bytes || 0);
  if (el('fcDir') && d.dir) el('fcDir').textContent = d.dir;
  fcRenderLog(d);
  var items = d.items || [];
  if (!items.length) {
    list.innerHTML = '<div class="empty">文件柜是空的。点「添加文件」放一份进来，她能反复用，不用你每次重发。</div>';
    return;
  }
  list.innerHTML = items.map(function (it) {
    var url = '/api/files/download?name=' + encodeURIComponent(it.name);
    return '<div class="fc-row">' +
      '<a class="fc-name" href="' + url + '" target="_blank" rel="noreferrer">' + fcEsc(it.name) + '</a>' +
      '<span class="fc-meta muted small">' + (FC_KIND[it.kind] || '文件') + ' · ' + fcSize(it.bytes) + ' · ' + fcTime(it.at) + '</span>' +
      (FILES.canWrite ? '<button class="ghost small" data-fc-del="' + fcEsc(it.name) + '">删除</button>' : '') +
    '</div>';
  }).join('');
  if (!list.__wired) {
    list.__wired = true;
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-fc-del]');
      if (!btn) return;
      fcDelete(btn.getAttribute('data-fc-del'));
    });
  }
}

function loadFiles() {
  return api('/api/files').then(function (d) { fcRender(d); }).catch(function (e) {
    if (el('fcMsg')) el('fcMsg').textContent = '读取失败：' + (e && e.message || e);
  });
}

function fcMsg(t) { if (el('fcMsg')) el('fcMsg').textContent = t || ''; }

// 上传走原始字节体（2026-11-20，上限提到 512 MB）：不再读成 base64 再塞 JSON，
// 几百 MB 的文件也不会把页面内存翻一倍。
function fcUploadOne(file) {
  return api('/api/files/upload?name=' + encodeURIComponent(file.name || '未命名文件'), {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
    timeoutMs: 1800000
  });
}

function fcUpload(files) {
  if (!files || !files.length || FILES.busy) return;
  FILES.busy = true;
  var ok = 0;
  var fail = [];
  var total = files.length;
  var chain = Promise.resolve();
  Array.prototype.forEach.call(files, function (f, idx) {
    chain = chain.then(function () {
      fcMsg('上传中 ' + (idx + 1) + '/' + total + '：' + f.name);
      return fcUploadOne(f).then(function () { ok += 1; }).catch(function (e) { fail.push(f.name + '（' + (e && e.message || e) + '）'); });
    });
  });
  chain.then(function () {
    FILES.busy = false;
    fcMsg(ok + ' 个已放入文件柜' + (fail.length ? '，失败：' + fail.join('；') : ''));
    return loadFiles();
  });
}

function fcDelete(name) {
  if (!name) return;
  if (!confirm('从文件柜删掉「' + name + '」？她之后就读不到了。')) return;
  api('/api/files/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) }).then(function () {
    fcMsg('已删除 ' + name);
    return loadFiles();
  }).catch(function (e) { fcMsg('删除失败：' + (e && e.message || e)); });
}

document.addEventListener('DOMContentLoaded', function () {
  if (el('fcRefresh')) el('fcRefresh').addEventListener('click', function () { loadFiles(); });
  if (el('fcInput')) {
    el('fcInput').addEventListener('change', function (e) {
      fcUpload(e.target.files);
      e.target.value = '';
    });
  }
});

window.loadFiles = loadFiles;