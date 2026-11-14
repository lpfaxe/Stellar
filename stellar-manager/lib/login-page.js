/* 未登录时给的那张口令页（样式/脚本都是独立文件，方便上 CSP） */
export function loginPageHtml() {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="theme-color" content="#080a11"><title>Stellar 控制台 · 口令</title>'
    + '<link rel="icon" href="/icon.svg" type="image/svg+xml">'
    + '<link rel="stylesheet" href="/login.css">'
    + '</head><body><div class="box">'
    + '<div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2.4l2.3 6.1 6.1 2.3-6.1 2.3L12 19.2l-2.3-6.1L3.6 10.8l6.1-2.3z" fill="currentColor"/><circle cx="19.2" cy="5" r="1.4" fill="currentColor"/><circle cx="5.2" cy="18.6" r=".95" fill="currentColor"/></svg></div>'
    + '<h1>Stellar 控制台</h1>'
    + '<p id="hint">输入访问口令（电脑上 panel-token.txt 里那 8 位字符），之后这台设备会记住。</p>'
    + '<input id="code" inputmode="latin" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="32" placeholder="访问口令" aria-label="访问口令">'
    + '<button id="go" type="button">进入</button><div class="err" id="err" role="status"></div>'
    + '</div><script src="/login.js"></script></body></html>'
}
