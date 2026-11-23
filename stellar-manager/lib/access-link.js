/* 控制台远控地址：给「她」按主人要求报一条当下真能打开的入口。
 *
 * 为什么不让她/桥接自己扫一遍网卡：只有面板自己知道绑在哪个地址上（lib/paths.js 的 HOST）。
 * 自己扫会把 0.0.0.0 根本没覆盖的 IPv6、或者压根没绑的网卡也报出去——
 * lib/status.js 里 access.v6Urls 那句注释就是这个教训：**打不开的链接比没有链接更糟**。
 *
 * 这里只做三件事：列出候选（按面板实际绑定过滤）→ 逐个 TCP 实测 → 主人要链接时才发一次性码。
 * 地址永远是面板自己算的，桥接侧（src/panel-link.js）只负责问和排版，两边不会各说一套。
 */
import net from 'node:net'
import { HOST, PORT } from './paths.js'
import { issueLoginCode, lanAddresses, publicV6Addresses, tailnetAddresses } from './auth.js'

const PROBE_TIMEOUT_MS = 600

// 顺序就是「手机上最可能打得开」的顺序：公网隧道（走流量也能开）排第一。
export const KIND_LABEL = { tunnel: '公网隧道（手机流量）', tailnet: 'Tailscale', lan: '局域网', v6: '公网 IPv6', local: '本机' }

function isCgnat(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(String(address || ''))
  if (!m) return false
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127
}

export function urlOf(address, port = PORT) {
  const host = String(address).includes(':') ? '[' + String(address).replace(/^\[|\]$/g, '') + ']' : String(address)
  return 'http://' + host + ':' + port + '/'
}

/**
 * 面板绑在 0.0.0.0 时只开 IPv4（见 lib/paths.js 的注释）；'::' 才覆盖 IPv6；
 * 绑死某一个地址时另一种协议就不该报。真正能不能连由 probeTcp 决定，这里只做粗筛。
 */
export function binds(kind, host = HOST, address = '') {
  if (kind === 'local') return true
  if (host === '::') return true
  if (host === '0.0.0.0') return kind !== 'v6'
  // 绑死某一个地址（STELLAR_PANEL_HOST=192.168.1.5 这类）：只有那个地址能连，其余报出去也是假的。
  return Boolean(address) && String(address) === String(host)
}

/**
 * 候选地址（未探测）：公网隧道 → tailnet → 局域网 → IPv6 → 本机，主人最可能用的排前面。
 *
 * tunnel 传的是面板 lib/tunnel.js 的 tunnelState()。它跟面板绑哪张网卡无关——
 * cloudflared 自己连出去、再把请求转回 127.0.0.1:PORT，所以这里不做 binds() 过滤。
 * 为什么它必须排第一：主人在外面用手机流量时，局域网和 IPv6 都可能打不开，
 * 只有这条是「出了家门也能开」的（2026-11-23 主人原话：「要那种用流量也能远程连上的」）。
 */
export function candidateLinks({ host = HOST, port = PORT, nets = null, tunnel = null } = {}) {
  const net4 = nets || { lan: lanAddresses(), tailnet: tailnetAddresses(), v6: publicV6Addresses() }
  const out = []
  const seen = new Set()
  const push = (kind, label, address) => {
    if (!binds(kind, host, address)) return
    if (!address || seen.has(kind + address)) return
    seen.add(kind + address)
    out.push({ kind, label, address, url: urlOf(address, port) })
  }
  const tUrl = String((tunnel && tunnel.url) || '').trim()
  if (tUrl) {
    const addr = tUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    if (addr && !seen.has('tunnel' + addr)) {
      seen.add('tunnel' + addr)
      out.push({
        kind: 'tunnel',
        label: KIND_LABEL.tunnel,
        address: addr,
        url: 'https://' + addr + '/',
        https: true,
        mode: String((tunnel && tunnel.mode) || 'quick'),
        permanent: Boolean(tunnel && tunnel.permanent)
      })
    }
  }
  for (const a of net4.tailnet || []) push('tailnet', KIND_LABEL.tailnet, a.address)
  for (const a of net4.lan || []) if (!isCgnat(a.address)) push('lan', KIND_LABEL.lan, a.address)
  for (const a of net4.v6 || []) push('v6', KIND_LABEL.v6, a.address)
  push('local', KIND_LABEL.local, '127.0.0.1')
  return out
}

/** 真的连一下：能建立 TCP 连接才算「打得开」。连不上/超时一律 false，不抛。 */
export function probeTcp(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false
    const socket = net.connect({ host, port })
    const finish = (ok) => {
      if (done) return
      done = true
      try { socket.destroy() } catch {}
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 远控入口总表。code=true 时才发一次性登录码（5 分钟、只能用一次，见 lib/auth.js issueLoginCode），
 * 发给**最可能用**的那条地址；不发码时返回值里没有任何凭据。
 */
export async function buildRemoteLink({ code = false, host = HOST, port = PORT, links = null, tunnel = null, probe = probeTcp, now = Date.now() } = {}) {
  const list = Array.isArray(links) ? links : candidateLinks({ host, port, tunnel })
  // 隧道那条是 https + 443，其余是本机端口——探测端口跟着候选走，别一律用 port。
  const checked = await Promise.all(list.map(async (it) => ({ ...it, reachable: await probe(it.address, it.https ? 443 : port) })))
  const live = checked.filter((it) => it.reachable)
  const best = ['tunnel', 'tailnet', 'lan', 'v6', 'local'].map((k) => live.find((it) => it.kind === k)).find(Boolean) || null
  let login = null
  if (code && best) {
    const issued = issueLoginCode()
    login = {
      url: best.url + '?code=' + issued.code,
      code: issued.code,
      via: best.kind,
      expiresAt: issued.expiresAt,
      ttlSec: Math.max(0, Math.round((issued.expiresAt - now) / 1000))
    }
  }
  return {
    port,
    host,
    checkedAt: new Date(now).toISOString(),
    opened: live.length > 0,
    best: best ? best.kind : '',
    urls: checked,
    // 隧道自己的状态原样带回去：没跑 / 跑着但还没拿到地址 / 快速隧道（地址会变），
    // 她那边要靠这几个字段决定是说「手机流量能开」还是「公网通道现在没开」。
    tunnel: tunnel
      ? {
          url: String(tunnel.url || ''),
          running: Boolean(tunnel.running),
          mode: String(tunnel.mode || 'quick'),
          permanent: Boolean(tunnel.permanent),
          error: String(tunnel.error || '')
        }
      : null,
    login
  }
}
