/* 控制台远控地址（她这一侧）：只做「问面板 + 排版」。
 *
 * 为什么地址不在这里算：面板自己知道绑在哪个网卡上（stellar-manager/lib/paths.js 的 HOST），
 * 桥接再扫一遍网卡只会得出第二套答案（PITFALLS #313 的老毛病：一个事实两处算）。
 * 所以候选地址、TCP 实测、一次性登录码全在面板侧（stellar-manager/lib/access-link.js），
 * 这里是唯一的调用方：本机回环 POST /api/remote-link。
 *
 * 安全口径：面板那条路由只接受回环请求，且不带任何凭据进来；只有 link=true 时
 * 面板才会发一次性码（5 分钟 / 只能用一次），码只出现在这一次的返回值里，不写日志。
 */
export const PANEL_DEFAULT_PORT = 3300

const KIND_LABEL = { tunnel: '公网隧道（手机流量）', tailnet: 'Tailscale', lan: '局域网', v6: '公网 IPv6', local: '本机' }

export function panelPort(env = process.env) {
  const n = Number((env && (env.STELLAR_PANEL_PORT || env.SURFCORE_PANEL_PORT)) || 0)
  return Number.isFinite(n) && n > 0 ? n : PANEL_DEFAULT_PORT
}

export function panelBaseUrl({ port = panelPort() } = {}) {
  return 'http://127.0.0.1:' + port
}

/**
 * 问面板要一份远控入口表。code=true 时面板会顺手发一个一次性登录码。
 * 失败一律抛带人话的 Error（工具层直接把它回给模型，别再套一层「未知错误」）。
 */
export async function requestRemoteLink({ port = panelPort(), code = false, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('这个 Node 没有 fetch，取不到远控地址')
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => { try { controller.abort() } catch {} }, timeoutMs) : null
  try {
    const res = await fetchImpl(panelBaseUrl({ port }) + '/api/remote-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-panel-request': 'panel' },
      body: JSON.stringify({ code: code === true }),
      signal: controller ? controller.signal : undefined
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data || data.ok !== true) {
      const reason = data && data.message ? String(data.message) : 'HTTP ' + res.status
      throw new Error(reason)
    }
    return data
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 把面板给的入口表排成她要说的话：只说实测连得上的，连不上的单独一行解释。
 *
 * 排序是面板给的（公网隧道在前），这里不重排——两处各排一套就是 PITFALLS #313。
 * 隧道那条要额外说清楚两件事：这是「出了家门也能开」的那条；通过它进来是只读
 * （lib/auth.js canWrite：public 只能看和审批）。
 */
export function formatRemoteLink(data) {
  const port = (data && data.port) || PANEL_DEFAULT_PORT
  const urls = Array.isArray(data && data.urls) ? data.urls : []
  const live = urls.filter((it) => it && it.reachable)
  const dead = urls.filter((it) => it && !it.reachable)
  const tun = (data && data.tunnel) || null
  const lines = []
  if (!live.length) {
    lines.push('控制台这会儿没有可用的远控地址（' + port + ' 端口一个都连不上）。')
    lines.push('可能：控制台没在跑，或者它只监听了本机（那样手机就打不开，得在面板「手机访问」里看怎么改）。')
    return lines.join('\n')
  }
  lines.push('控制台远控地址（端口 ' + port + '，面板监听 ' + (data.host || '?') + '）：')
  for (const it of live) {
    const tail = it.kind === 'tunnel'
      ? '（实测连得上；这条用手机流量也能打开，但只能看和点审批，改数据要回本机或同一 WiFi）'
      : '（实测连得上）'
    lines.push('- ' + (KIND_LABEL[it.kind] || it.kind) + '：' + it.url + tail)
  }
  if (dead.length) {
    lines.push('连不上的：' + dead.map((it) => (KIND_LABEL[it.kind] || it.kind) + ' ' + it.url).join('；') + '（面板没绑那张网卡，或那端没装/没连）')
  }
  const tunnelLive = live.some((it) => it.kind === 'tunnel')
  if (!tunnelLive) {
    if (tun && tun.url) {
      lines.push('公网那条（' + tun.url + '）现在连不上：cloudflared 活着但通道没通，或者快速隧道被 Cloudflare 回收了（控制台「手机访问」里点一次「开启远程访问」会换一条新的）。')
    } else if (tun && tun.running) {
      lines.push('公网那条还在起：cloudflared 刚开，十几秒后控制台「手机访问」里会出现地址，再问一次就有。')
    } else {
      lines.push('公网那条（手机流量也能开的那种）现在没开：控制台「手机访问」里点「开启远程访问」（快速隧道，免账号；重启后地址会变）。')
    }
  } else if (tun && tun.mode === 'quick') {
    lines.push('提醒：这是 Cloudflare 快速隧道，地址会变（cloudflared 重启或被回收就换一条）；要固定地址得配命名隧道。')
  }
  const login = data.login
  if (login && login.url) {
    const mins = Math.max(1, Math.round(Number(login.ttlSec || 300) / 60))
    lines.push('')
    lines.push('能直接打开的登录链接（' + mins + ' 分钟内有效、只能用一次）：')
    lines.push(login.url)
    lines.push('这条链接等于一次登录，只能发给主人本人，别发到群里或任何公开的地方。')
  } else {
    lines.push('')
    lines.push('要一条「点开就进去」的登录链接，再调一次带 link=true（5 分钟内有效、只能用一次）。')
  }
  return lines.join('\n')
}

export async function panelLinkText({ port = panelPort(), code = false, fetchImpl = globalThis.fetch } = {}) {
  return formatRemoteLink(await requestRemoteLink({ port, code, fetchImpl }))
}
