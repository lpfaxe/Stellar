/**
 * Stellar —— 鱼缸小镇相册镜像（小镇功能独占文件；拆小镇时随 src/town-* 整块删）。
 *
 * 为什么要有它：小镇相册里的照片是她自己在游戏里拍的/请人画的，她想拿这些发 QQ 空间、
 * 或在聊天里发图。相册在远端，出站图片又只认本地文件（bridge loadOutboundImage 的
 * allowedRoots 含 %DSH_HOME%/stellar），所以把照片镜像到本地来，再把绝对路径交给
 * qq_send_image / stellar_qzone_post 就能直接发。
 *
 * 边界（安全关键，改之前先读）：
 * - 目录固定在 <DSH_HOME>/stellar/state/town/album/，文件名只有 <id>.<ext> 与 <id>.thumb.<ext>，
 *   而 id 必须过 ALBUM_ID_RE（al_ + 16 位十六进制），别人的文件名进不来；
 * - 下载只走 https + 白名单域 + /town/api/album/<id>/{file,thumb}，**不带授权头**
 *   （服务端这个端点只认 id），不跟随重定向；
 * - 只收 PNG / JPEG / GIF / WebP 四种图片（bridge 出站也只认这四种）；
 * - 单张超过 8MB 只留缩略图（出站上限 socialV2.media.maxBytes 默认 8MB）；
 * - 双限淘汰：最多 60 张、总量 120MB，超了按 created 从旧到新删；
 * - kind === 'song' 是音频，这里只镜像照片和画，跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ALBUM_ID_RE, TOWN_HOSTS, albumFileUrl, normalizeBaseUrl, redactCode, TownError } from './town-client.js'

export const ALBUM_KEEP_MAX = 60
export const ALBUM_KEEP_BYTES = 120 * 1024 * 1024
export const ALBUM_MAX_FILE_BYTES = 8 * 1024 * 1024
export const ALBUM_FETCH_MAX_BYTES = 25 * 1024 * 1024
export const ALBUM_TIMEOUT_MS = 20000
export const ALBUM_INDEX = 'index.json'
export const ALBUM_INDEX_VERSION = 1

const IMAGE_EXT = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })

/** 自建相册目录（不建也行，写入时才 mkdir）。 */
export function albumDir(dshHome) {
  const home = String(dshHome || process.env.DSH_HOME || '').trim()
  if (!home) return null
  return path.join(home, 'stellar', 'state', 'town', 'album')
}

/**
 * 小镇的 created 是 epoch 秒（浮点），面板与工具都按 ISO 字符串切前 10 位显示日期，
 * 直接 String(1795264946.04) 会显示成「1795264946」。这里统一成 ISO；认不出的原样留着。
 */
export function isoFromCreated(value) {
  if (value == null || value === '') return ''
  const s = String(value).trim()
  // 统一成「不带毫秒的 UTC ISO」：小镇给的是 epoch 秒、测试/旧索引里是带 Z 的字符串，
  // 两种写法混在一起会按字符串排序出错（'…00Z' 与 '…00.000Z' 不相等）。
  const norm = (d) => (Number.isFinite(d.getTime()) ? d.toISOString().replace('.000Z', 'Z') : '')
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return norm(new Date(n > 1e12 ? n : n * 1000))
  }
  return norm(new Date(s)) || s
}

/** 相册的 with 是 [{fish_id,name}]（不是字符串数组）；只留名字，别把 [object Object] 写进索引。 */
export function fishNames(list) {
  if (!Array.isArray(list)) return []
  return list
    .slice(0, 8)
    .map((x) => (typeof x === 'string' ? x : String((x && (x.name || x.nick || x.fish_name || x.id || x.fish_id)) || '')))
    .filter(Boolean)
}

function safeId(value) {
  const id = String(value || '')
  return ALBUM_ID_RE.test(id) ? id : ''
}

/** 从 content-type 定扩展名；不认识的图片类型返回空（拒收）。 */
export function extFromType(type) {
  const clean = String(type || '').split(';')[0].trim().toLowerCase()
  return IMAGE_EXT[clean] || ''
}

/** 只认四种图片的魔数，别的一律拒（防止把 HTML/压缩包当图片存下来）。 */
export function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp'
  return ''
}

/** 读索引；坏了就当空索引（相册是缓存，不是账本，不能因为索引坏了让采集炸掉）。 */
export function readAlbumIndex(dir) {
  const empty = { version: ALBUM_INDEX_VERSION, at: '', items: {} }
  if (!dir) return empty
  let raw
  try { raw = fs.readFileSync(path.join(dir, ALBUM_INDEX), 'utf8') } catch { return empty }
  let data
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { return empty }
  const items = data && typeof data.items === 'object' && data.items ? data.items : {}
  const clean = {}
  for (const [id, item] of Object.entries(items)) {
    if (!safeId(id) || !item || typeof item !== 'object') continue
    clean[id] = {
      id,
      kind: String(item.kind || 'photo'),
      what: String(item.what || '').slice(0, 200),
      with: fishNames(item.with),
      occasion: String(item.occasion || '').slice(0, 40),
      created: String(item.created || ''),
      file: safeId(id) && item.file ? String(item.file) : '',
      thumb: item.thumb ? String(item.thumb) : '',
      bytes: Number(item.bytes) || 0,
      thumbOnly: !!item.thumbOnly,
      thumbTried: !!item.thumbTried,
      at: String(item.at || ''),
    }
  }
  return { version: Number(data.version) || ALBUM_INDEX_VERSION, at: String(data.at || ''), items: clean }
}

/** 原子写索引（先写 .tmp 再 rename，半截索引不会盖掉好的）。 */
export function writeAlbumIndex(dir, index) {
  if (!dir) return false
  fs.mkdirSync(dir, { recursive: true })
  const body = JSON.stringify({ version: ALBUM_INDEX_VERSION, at: String(index.at || ''), items: index.items || {} }, null, 2)
  const tmp = path.join(dir, ALBUM_INDEX + '.tmp')
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, path.join(dir, ALBUM_INDEX))
  return true
}

/** 索引里这个 id 该算多少字节（缩略图也占地方，一起算）。 */
function itemBytes(item) {
  return (Number(item && item.bytes) || 0)
}

function fileAbs(dir, name) {
  const base = path.basename(String(name || ''))
  if (!base || base.includes('..')) return ''
  const abs = path.join(dir, base)
  if (path.dirname(abs) !== path.resolve(dir)) return ''
  return abs
}

function existsSize(abs) {
  try { return fs.statSync(abs).size } catch { return -1 }
}

/** 校验好 URL 再抓字节：https + 白名单域 + 相册路径，不带授权头。 */
async function fetchAlbumBytes(target, { fetchImpl = globalThis.fetch, timeoutMs = ALBUM_TIMEOUT_MS, maxBytes = ALBUM_FETCH_MAX_BYTES } = {}) {
  if (typeof fetchImpl !== 'function') throw new TownError('no_fetch', '当前运行环境没有 fetch')
  let u
  try { u = new URL(String(target)) } catch { throw new TownError('bad_album_url', '相册地址不合法') }
  if (u.protocol !== 'https:') throw new TownError('bad_album_url', '相册地址必须是 https')
  if (!TOWN_HOSTS.includes(u.hostname.toLowerCase())) throw new TownError('bad_album_url', '相册域名不在白名单')
  if (!/^\/town\/api\/album\/[A-Za-z0-9_]+\/(file|thumb)$/.test(u.pathname)) throw new TownError('bad_album_url', '相册路径不合法')
  if (u.username || u.password || u.port) throw new TownError('bad_album_url', '相册地址不能带凭据或端口')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(u.href, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { accept: 'image/*', 'user-agent': 'Stellar town album mirror' },
    })
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /aborted/i.test(String(error.message)))
    throw new TownError(aborted ? 'timeout' : 'network', redactCode(aborted ? '相册下载超时' : '相册下载失败：' + (error && error.message)))
  } finally {
    clearTimeout(timer)
  }
  if (res.status >= 300 && res.status < 400) throw new TownError('redirect', '相册下载被重定向，已拒绝')
  if (!res.ok) throw new TownError('http_' + res.status, '相册下载返回 ' + res.status)
  const declared = Number(res.headers.get('content-length')) || 0
  if (declared && declared > maxBytes) throw new TownError('too_large', '相册文件超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB，已跳过')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) throw new TownError('too_large', '相册文件超过上限，已跳过')
  return { buf, type: String(res.headers.get('content-type') || '') }
}

/** 插件自己的相册缓存（fishbowl lib/extras.js 落的那份）——有就直接抄，省一次下载。 */
function fromPluginCache(dshHome, id) {
  const home = String(dshHome || '').trim()
  if (!home) return null
  const dir = path.join(home, 'fishbowl-town', 'state', 'album')
  let names
  try { names = fs.readdirSync(dir) } catch { return null }
  for (const name of names) {
    if (!name.startsWith(id + '.')) continue
    if (name.includes('.thumb.')) continue
    const abs = path.join(dir, name)
    const size = existsSize(abs)
    if (size <= 0) continue
    try {
      const buf = fs.readFileSync(abs)
      const ext = looksLikeImage(buf)
      if (!ext) continue
      return { buf, ext }
    } catch { /* 读不动就看下一个 */ }
  }
  return null
}

function writeImage(dir, name, buf) {
  const abs = path.join(dir, name)
  fs.writeFileSync(abs, buf)
  return abs
}

/**
 * 给面板留一份缩略图：局域网会话只能看缩略图（原图是她的照片，不该在共享 WiFi 上摊开），
 * 而原图不一定有缩略图，所以每张成功的原图都顺手抓一个小的。失败只记一次，不每轮重试。
 */
async function ensureThumb({ dir, id, baseUrl, prev, fetchImpl, log }) {
  if (prev && prev.thumb) {
    const abs = fileAbs(dir, prev.thumb)
    if (abs && existsSize(abs) > 0) return prev.thumb
  }
  if (prev && prev.thumbTried) return prev.thumb || ''
  try {
    const { buf } = await fetchAlbumBytes(albumFileUrl(baseUrl, id, { thumb: true }), { fetchImpl })
    const ext = looksLikeImage(buf)
    if (!ext) return ''
    const name = id + '.thumb' + ext
    writeImage(dir, name, buf)
    return name
  } catch (error) {
    log('[town-album] ' + id + ' 缩略图没拿到：' + redactCode(error && error.message))
    return ''
  }
}

/**
 * 同步一次相册。
 *
 * client 复用小镇客户端（列表要授权头、走它的串行限速）；文件下载不走 client。
 * 任何一步失败都只做减法：抓不到列表就返回 ok:false，单张失败跳过，绝不让调用方炸。
 */
export async function syncAlbum({ dshHome, client, fetchImpl, log = () => {}, now = () => new Date(), limit = 30, keep = ALBUM_KEEP_MAX, keepBytes = ALBUM_KEEP_BYTES } = {}) {
  const dir = albumDir(dshHome)
  if (!dir) return { ok: false, code: 'no_home', message: '没有 DSH_HOME，相册没地方放' }
  if (!client || typeof client.read !== 'function') return { ok: false, code: 'no_client', message: '没有小镇客户端' }

  let payload
  try {
    payload = await client.read('album', { query: { limit: Math.max(1, Math.min(30, Number(limit) || 30)) } })
  } catch (error) {
    log('[town-album] 拉列表失败：' + redactCode(error && error.message))
    return { ok: false, code: (error && error.code) || 'network', message: redactCode(error && error.message) }
  }
  if (!payload || payload.available === false) {
    return { ok: false, code: 'unavailable', message: '小镇那边相册暂不可用' }
  }
  // 小镇 /album 把 items 放在**顶层**（不是包一层 data）；旧写法只认 payload.data，
  // 于是永远读到 0 条、却回 ok:true —— 相册一直是空的正是这个（2026-11-22 修）。
  const data = payload && Array.isArray(payload.items)
    ? payload
    : (payload && payload.data && typeof payload.data === 'object' ? payload.data : {})
  const list = Array.isArray(data.items) ? data.items : []
  const baseUrl = client.baseUrl || normalizeBaseUrl(client.baseUrl)
  const index = readAlbumIndex(dir)
  const stamp = now().toISOString()

  let added = 0
  let refreshed = 0
  let skipped = 0
  fs.mkdirSync(dir, { recursive: true })

  for (const raw of list) {
    const id = safeId(raw && raw.item_id ? raw.item_id : raw && raw.id)
    if (!id) { skipped += 1; continue }
    if (String(raw.kind || 'photo') === 'song') { skipped += 1; continue }
    const prev = index.items[id]
    const meta = {
      id,
      kind: String(raw.kind || 'photo'),
      what: String(raw.what || '').slice(0, 200),
      with: fishNames(raw.with),
      occasion: String(raw.occasion || '').slice(0, 40),
      created: isoFromCreated(raw.created),
      file: '',
      thumb: '',
      bytes: 0,
      thumbOnly: false,
      at: stamp,
    }

    // 已有实体文件且没坏：只刷新元数据（what 可能是新写的）。
    if (prev && prev.file) {
      const prevAbs = fileAbs(dir, prev.file)
      const size = prevAbs ? existsSize(prevAbs) : -1
      if (size > 0) {
        let thumb = prev.thumb || ''
        let thumbTried = !!prev.thumbTried
        if (!prev.thumbOnly && !thumb && !thumbTried) {
          thumb = await ensureThumb({ dir, id, baseUrl, prev: null, fetchImpl, log })
          if (!thumb) thumbTried = true
        }
        index.items[id] = { ...meta, file: prev.file, thumb, bytes: size, thumbOnly: !!prev.thumbOnly, thumbTried }
        refreshed += 1
        continue
      }
    }

    // 1) 插件缓存兜底 → 2) 远端原图 → 3) 原图太大就退缩略图。
    let saved = null
    const cached = fromPluginCache(dshHome, id)
    if (cached && cached.buf.length <= ALBUM_MAX_FILE_BYTES) {
      try {
        const name = id + cached.ext
        writeImage(dir, name, cached.buf)
        saved = { name, bytes: cached.buf.length, thumbOnly: false }
      } catch { saved = null }
    }
    if (!saved) {
      try {
        const { buf } = await fetchAlbumBytes(albumFileUrl(baseUrl, id, { thumb: false }), { fetchImpl })
        const ext = looksLikeImage(buf)
        if (!ext) throw new TownError('bad_image', '返回的不是 PNG/JPEG/GIF/WebP')
        if (buf.length <= ALBUM_MAX_FILE_BYTES) {
          const name = id + ext
          writeImage(dir, name, buf)
          saved = { name, bytes: buf.length, thumbOnly: false }
        }
      } catch (error) {
        log('[town-album] ' + id + ' 原图没拿到：' + redactCode(error && error.message))
      }
    }
    if (!saved) {
      try {
        const { buf } = await fetchAlbumBytes(albumFileUrl(baseUrl, id, { thumb: true }), { fetchImpl })
        const ext = looksLikeImage(buf)
        if (!ext) throw new TownError('bad_image', '缩略图也不是图片')
        const name = id + '.thumb' + ext
        writeImage(dir, name, buf)
        saved = { name, bytes: buf.length, thumbOnly: true }
      } catch (error) {
        log('[town-album] ' + id + ' 缩略图也没拿到：' + redactCode(error && error.message))
        skipped += 1
        continue
      }
    }
    meta.file = saved.name
    meta.bytes = saved.bytes
    meta.thumbOnly = !!saved.thumbOnly
    if (!saved.thumbOnly) {
      meta.thumb = await ensureThumb({ dir, id, baseUrl, prev: null, fetchImpl, log })
      meta.thumbTried = !meta.thumb
    }
    index.items[id] = meta
    added += 1
  }

  // 淘汰：先按 created 从新到旧，保留前 keep 张、且累计字节 ≤ keepBytes。
  const ordered = Object.values(index.items).sort((a, b) => String(b.created || b.at || '').localeCompare(String(a.created || a.at || '')))
  let used = 0
  let kept = 0
  let pruned = 0
  for (const item of ordered) {
    const fits = kept < keep && used + itemBytes(item) <= keepBytes
    if (fits) { kept += 1; used += itemBytes(item); continue }
    const abs = fileAbs(dir, item.file)
    if (abs) { try { fs.rmSync(abs) } catch { /* 删不掉就留着，下次再来 */ } }
    // 缩略图一起删：只删原图会让 .thumb.* 越积越多（60 张 × 2 个文件）
    const thumbAbs = fileAbs(dir, item.thumb)
    if (thumbAbs) { try { fs.rmSync(thumbAbs) } catch { /* 同上 */ } }
    delete index.items[item.id]
    pruned += 1
  }

  index.at = stamp
  writeAlbumIndex(dir, index)
  // 只要「远端给的条数」和「落盘结果」有一处异常就写一行：2026-11-22 那次相册永远空、
  // 日志里一个字都没有，就是因为这条只在 added/pruned 时才响，而结构 bug 让两者都是 0。
  if (added || pruned || skipped || list.length === 0) {
    log('[town-album] 远端 ' + list.length + ' 条 → 新增 ' + added + '，刷新 ' + refreshed + '，跳过 ' + skipped + '，淘汰 ' + pruned + '，共 ' + kept + ' 张 / ' + Math.round(used / 1024) + 'KB')
  }
  return { ok: true, dir, added, refreshed, pruned, skipped, total: kept, bytes: used, indexedAt: stamp, making: Number(data.making || 0) || 0 }
}

/** 给她看的清单：只列能直接拿去发图的条目（文件真的在）。 */
export function listAlbum(dshHome, { limit = 6 } = {}) {
  const dir = albumDir(dshHome)
  if (!dir) return { ok: false, items: [], total: 0, dir: '' }
  const index = readAlbumIndex(dir)
  const items = []
  for (const item of Object.values(index.items)) {
    const abs = fileAbs(dir, item.file)
    if (!abs) continue
    const size = existsSize(abs)
    if (size <= 0) continue
    items.push({
      id: item.id,
      kind: item.kind,
      what: item.what,
      with: item.with,
      occasion: item.occasion,
      created: item.created,
      path: abs,
      bytes: size,
      thumbOnly: !!item.thumbOnly,
    })
  }
  items.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
  const max = Math.max(1, Math.min(20, Number(limit) || 6))
  return { ok: true, dir, total: items.length, items: items.slice(0, max) }
}

/** 面板用的条目（带 thumb 路径，不暴露索引内部结构）。 */
export function albumEntries(dshHome) {
  const dir = albumDir(dshHome)
  if (!dir) return []
  const index = readAlbumIndex(dir)
  const out = []
  for (const item of Object.values(index.items)) {
    const abs = fileAbs(dir, item.file)
    const thumbAbs = item.thumb ? fileAbs(dir, item.thumb) : ''
    if (!abs || existsSize(abs) <= 0) continue
    out.push({
      id: item.id,
      kind: item.kind,
      what: item.what,
      with: item.with,
      occasion: item.occasion,
      created: item.created,
      file: path.basename(abs),
      thumb: thumbAbs && existsSize(thumbAbs) > 0 ? path.basename(thumbAbs) : '',
      bytes: existsSize(abs),
      thumbOnly: !!item.thumbOnly,
    })
  }
  out.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
  return out
}
