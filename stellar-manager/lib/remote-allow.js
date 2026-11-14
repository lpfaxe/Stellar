/* 远程可写白名单：面板如今能通过公网 IPv6 直接打开，所以「谁能写」必须显式登记。
 *
 * 默认策略是**拒绝**：任何来自全局 IPv6 的请求都算 public（只读），
 * 只有来源地址落在 state/panel-remote-allow.json 里登记过的前缀内，才升权成 lan（可写）。
 * 白名单只能在本机回环上改（server.mjs 里判 isLoopback），远程端即便拿到口令也改不了这张表。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SURF } from './paths.js'
import { atomicWriteJson } from './util.js'

export const REMOTE_ALLOW_FILE = path.join(SURF, 'state', 'panel-remote-allow.json')

// 前缀字符串只接受「IPv6 地址/长度」或「IPv4 地址/长度」，长度 1–128 / 1–32。
const V6_RE = /^[0-9a-fA-F:]{3,45}\/\d{1,3}$/
const V4_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/

function parseV6(text) {
  const s = String(text || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!s.includes(':')) return null
  const parts = s.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':') : []
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const all = [...head, ...Array(fill).fill('0'), ...tail]
  if (all.length !== 8) return null
  const out = []
  for (const h of all) {
    if (h === '' || !/^[0-9a-f]{1,4}$/.test(h)) return null
    out.push(parseInt(h, 16))
  }
  return out
}

function v6Bits(hextets, bits) {
  let out = ''
  for (const h of hextets) out += h.toString(2).padStart(16, '0')
  return out.slice(0, bits)
}

/** 判断一个来源地址是否命中某条前缀（cidr）。IPv4-mapped 的 ::ffff:a.b.c.d 会先剥离。 */
export function prefixMatches(cidr, ip) {
  const rule = String(cidr || '').trim().toLowerCase()
  let addr = String(ip || '').trim().toLowerCase()
  // 双栈监听下 IPv4 客户端会以 ::ffff:1.2.3.4 出现
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (mapped) addr = mapped[1]
  if (V4_RE.test(rule)) {
    const [base, lenRaw] = rule.split('/')
    const len = Number(lenRaw)
    const a = base.split('.').map(Number)
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return false
    const b = addr.split('.').map(Number)
    if (a.some((x) => x > 255) || b.some((x) => x > 255) || len > 32) return false
    const bitsA = a.map((x) => x.toString(2).padStart(8, '0')).join('').slice(0, len)
    const bitsB = b.map((x) => x.toString(2).padStart(8, '0')).join('').slice(0, len)
    return bitsA === bitsB
  }
  if (!V6_RE.test(rule)) return false
  const [base, lenRaw] = rule.split('/')
  const len = Number(lenRaw)
  if (!(len >= 1 && len <= 128)) return false
  const r = parseV6(base); const t = parseV6(addr)
  if (!r || !t) return false
  return v6Bits(r, len) === v6Bits(t, len)
}

export function readAllow() {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(REMOTE_ALLOW_FILE, 'utf8')); } catch { raw = null }
  const list = Array.isArray(raw && raw.prefixes) ? raw.prefixes : []
  const prefixes = []
  for (const it of list) {
    const cidr = String((it && it.cidr) || '').trim().toLowerCase()
    if (!V4_RE.test(cidr) && !V6_RE.test(cidr)) continue
    prefixes.push({ cidr, label: String((it && it.label) || '').slice(0, 40), at: Number(it && it.at) || 0 })
  }
  return { version: 1, prefixes }
}

function saveAllow(data) {
  fs.mkdirSync(path.dirname(REMOTE_ALLOW_FILE), { recursive: true })
  atomicWriteJson(REMOTE_ALLOW_FILE, { version: 1, prefixes: data.prefixes });
}

/** 来源地址是否在可写白名单里。空表 = 一律不放行（fail-closed）。 */
export function isAllowedRemote(ip) {
  const list = readAllow().prefixes
  if (!list.length) return false
  return list.some((it) => prefixMatches(it.cidr, ip));
}

export function addPrefix({ cidr, label = '' } = {}) {
  const want = String(cidr || '').trim().toLowerCase();
  if (!V4_RE.test(want) && !V6_RE.test(want)) {
    return { ok: false, message: '要写成 2409:8d30:d001:4194::/64 这样的前缀（地址/长度）' }
  }
  const data = readAllow();
  if (data.prefixes.some((it) => it.cidr === want)) return { ok: false, message: '这条前缀已经在名单里了' }
  if (data.prefixes.length >= 16) return { ok: false, message: '名单最多 16 条，先删几条' }
  data.prefixes.push({ cidr: want, label: String(label || '').slice(0, 40), at: Date.now() });
  saveAllow(data);
  return { ok: true, prefixes: data.prefixes }
}

export function removePrefix(cidr) {
  const want = String(cidr || '').trim().toLowerCase();
  const data = readAllow();
  const next = data.prefixes.filter((it) => it.cidr !== want);
  if (next.length === data.prefixes.length) return { ok: false, message: '名单里没有这条' }
  saveAllow({ prefixes: next });
  return { ok: true, prefixes: next }
}

export function clearPrefixes() {
  saveAllow({ prefixes: [] });
  return { ok: true, prefixes: [] }
}

/** 把一条来源地址归并成防爆破桶：IPv6 归到 /64，IPv4 原样。换地址不该换桶。 */
export function guardKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  const addr = mapped ? mapped[1] : s;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return addr
  const h = parseV6(addr);
  if (!h) return addr || 'unknown'
  // 100.64/10 那类是 Tailscale，整段一个桶反而会互相牵连；IPv4-mapped 已在上面处理。
  const bits = v6Bits(h, 64);
  const out = [];
  for (let i = 0; i < 64; i += 16) out.push(parseInt(bits.slice(i, i + 16), 2).toString(16));
  return out.join(':') + '::/64'
}
