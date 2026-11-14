(function () {
  var el = document.getElementById('code')
  var err = document.getElementById('err')
  var btn = document.getElementById('go')
  el.focus()
  function submit() {
    var code = el.value.trim().toLowerCase()
    if (!code) { err.textContent = '先输入口令'; return }
    err.textContent = ''
    btn.disabled = true
    fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-panel-request': 'panel' },
      body: JSON.stringify({ code: code })
    }).then(function (r) { return r.json() }).then(function (j) {
      if (j && j.ok) { location.replace('/'); return }
      err.textContent = (j && j.message) || '口令不对'
      btn.disabled = false
    }).catch(function () {
      err.textContent = '连不上，检查电脑和网络'
      btn.disabled = false
    })
  }
  btn.onclick = submit
  el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit() })
})()
