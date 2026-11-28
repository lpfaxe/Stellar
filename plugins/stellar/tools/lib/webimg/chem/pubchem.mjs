// chem/pubchem.mjs —— 用 PubChem 的公开 REST 接口取「二维结构式 PNG」。
//
// 为什么结构式要走 PubChem 而不是 Bing：
//   · 结构式只要 CID 对了，图就一定对（同一 CID 的 2D 结构是确定的）；
//   · Bing 搜「阿司匹林 结构式」经常混进教材照片、带水印的图、甚至别的分子；
//   · PubChem 的 PNG 是白底、无字、1000×1000，正好适合直接发出去。
//
// 中文名不认（会 404），所以先过 aliases.mjs；查不到就返回 NEED_IDENTIFIER，
// 让主人补 CAS/英文名，绝不拿一个「听起来像」的名字去查。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectImageBuffer } from '../image-meta.mjs'
import { isCasNumber, looksLikeChinese, resolveAlias } from './aliases.mjs'

const API = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug'
const CACHE_DAYS = 30
const CACHE_MAX = 300
const MIN_SIDE = 800

function home() { return process.env.DSH_HOME || path.join(os.homedir(), '.dsh') }
export function chemRoot() { return path.join(home(), 'stellar', 'chem-images') }
export function cacheFile(cid) { return path.join(chemRoot(), 'cid-' + String(cid) + '.png') }
export function metaFile(cid) { return path.join(chemRoot(), 'cid-' + String(cid) + '.json') }

async function getJson(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'Stellar/1.0 (image search)' }, signal: ctrl.signal })
    if (res.status === 404) return { ok: false, code: 'NOT_FOUND', status: 404 }
    if (!res.ok) return { ok: false, code: 'HTTP', status: res.status, error: 'PubChem HTTP ' + res.status }
    return { ok: true, body: await res.json() }
  } catch (error) {
    return { ok: false, code: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', error: String(error?.message ?? error) }
  } finally { clearTimeout(timer) }
}

/** 把用户给的字段整理成一组候选查询（SMILES/CAS/英文名/中文别名）。 */
export function structureQueries(input = {}) {
  const out = []
  const push = (value, field) => {
    const v = String(value || '').trim()
    if (!v) return
    if (out.some((x) => x.value.toLowerCase() === v.toLowerCase() && x.field === field)) return
    out.push({ value: v, field })
  }
  push(input.smiles, 'smiles')
  if (isCasNumber(input.cas)) push(input.cas, 'cas')
  push(input.nameEn, 'name')
  const alias = resolveAlias(input.nameEn || input.name)
  if (alias) {
    if (isCasNumber(alias.cas)) push(alias.cas, 'cas')
    push(alias.nameEn, 'name')
  }
  if (isCasNumber(input.name)) push(input.name, 'cas')
  else if (!looksLikeChinese(input.name)) push(input.name, 'name')
  return out
}

/** 解析出 CID 列表；不下载图。 */
export async function resolveCids(input = {}, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const queries = structureQueries(input)
  if (!queries.length) {
    return {
      ok: false,
      code: 'NEED_IDENTIFIER',
      cids: [],
      error: '认不出这个中文名对应哪个化合物',
      hint: '请给英文名、CAS 号或 SMILES（例如「阿司匹林」→ aspirin / 50-78-2），不要让我猜。'
    }
  }
  const notes = []
  for (const q of queries) {
    const endpoint = q.field === 'smiles'
      ? API + '/compound/smiles/' + encodeURIComponent(q.value) + '/cids/JSON'
      : API + '/compound/name/' + encodeURIComponent(q.value) + '/cids/JSON'
    const res = await getJson(endpoint, { fetchImpl, timeoutMs })
    if (res.ok) {
      const cids = (Array.isArray(res.body?.IdentifierList?.CID) ? res.body.IdentifierList.CID : [])
        .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
      if (cids.length) return { ok: true, cids: cids.slice(0, 8), query: q, notes }
      notes.push(q.field + ':' + q.value + ' 无结果')
      continue
    }
    if (res.code === 'NOT_FOUND') { notes.push(q.field + ':' + q.value + ' 未找到'); continue }
    return { ok: false, code: 'PUBCHEM_UNAVAILABLE', cids: [], error: res.error || 'PubChem 请求失败', hint: '稍后再试，或直接把 CAS 号给我。', notes }
  }
  return {
    ok: false,
    code: 'NEED_IDENTIFIER',
    cids: [],
    error: 'PubChem 查不到这个名称',
    hint: '请给 CAS 号（如 50-78-2）或英文通用名（如 aspirin）；中文商品名可能对应多个化合物。',
    notes
  }
}

export async function fetchStructurePng(cid, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const url = API + '/compound/cid/' + encodeURIComponent(String(cid)) + '/PNG?record_type=2d&image_size=1000x1000'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'Stellar/1.0 (image search)' }, signal: ctrl.signal })
    if (!res.ok) return { ok: false, code: 'PUBCHEM_UNAVAILABLE', error: 'PubChem 结构图 HTTP ' + res.status }
    const buf = Buffer.from(await res.arrayBuffer())
    const info = inspectImageBuffer(buf)
    if (info.kind !== 'png' || !info.width || !info.height) {
      return { ok: false, code: 'PUBCHEM_UNAVAILABLE', error: 'PubChem 返回的不是有效 PNG' }
    }
    if (Math.min(info.width, info.height) < MIN_SIDE) {
      return { ok: false, code: 'IMAGE_TOO_SMALL', error: '结构图只有 ' + info.width + '×' + info.height }
    }
    return { ok: true, buf, url, ...info }
  } catch (error) {
    return { ok: false, code: 'PUBCHEM_UNAVAILABLE', error: '下载结构图失败：' + String(error?.message ?? error) }
  } finally { clearTimeout(timer) }
}

function atomicWrite(file, buf) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex')
  const fd = fs.openSync(tmp, 'w', 0o600)
  try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
}

export function pruneCache({ now = Date.now(), maxAgeDays = CACHE_DAYS, maxFiles = CACHE_MAX } = {}) {
  let files = []
  try {
    files = fs.readdirSync(chemRoot()).filter((n) => /^cid-\d+\.png$/.test(n)).map((name) => {
      const file = path.join(chemRoot(), name)
      let stat = null
      try { stat = fs.statSync(file) } catch {}
      return { file, name, mtime: stat?.mtimeMs || 0 }
    })
  } catch { return 0 }
  const cutoff = now - maxAgeDays * 86400000
  let removed = 0
  for (const f of files) {
    if (f.mtime < cutoff) { try { fs.rmSync(f.file, { force: true }); fs.rmSync(f.file.replace(/\.png$/, '.json'), { force: true }); removed += 1 } catch {} }
  }
  const rest = files.filter((f) => f.mtime >= cutoff).sort((a, b) => b.mtime - a.mtime)
  for (const f of rest.slice(maxFiles)) {
    try { fs.rmSync(f.file, { force: true }); fs.rmSync(f.file.replace(/\.png$/, '.json'), { force: true }); removed += 1 } catch {}
  }
  return removed
}

function readCache(cid, maxAgeDays = CACHE_DAYS) {
  try {
    const file = cacheFile(cid)
    const stat = fs.statSync(file)
    if (!stat.isFile() || Date.now() - stat.mtimeMs > maxAgeDays * 86400000) return null
    const info = inspectImageBuffer(fs.readFileSync(file))
    if (!info.width || !info.height) return null
    return { file, ...info }
  } catch { return null }
}

/**
 * 取结构式：先查缓存，再 PubChem 解析 CID、下载 PNG、写缓存。
 * @returns {Promise<{ok:boolean, code?:string, file?:string, cid?:number, cids?:number[], ...}>}
 */
export async function getStructure(input = {}, { fetchImpl = fetch, timeoutMs = 20000, useCache = true, stateDir = '' } = {}) {
  const resolved = await resolveCids(input, { fetchImpl, timeoutMs })
  if (!resolved.ok) return resolved
  const cid = resolved.cids[0]
  if (useCache) {
    const hit = readCache(cid)
    if (hit) return { ok: true, cid, cids: resolved.cids, file: hit.file, width: hit.width, height: hit.height, bytes: hit.bytes, cached: true, query: resolved.query, notes: resolved.notes }
  }
  const got = await fetchStructurePng(cid, { fetchImpl, timeoutMs })
  if (!got.ok) return { ...got, cid, cids: resolved.cids, query: resolved.query }
  let file = ''
  try {
    file = cacheFile(cid)
    atomicWrite(file, got.buf)
    atomicWrite(metaFile(cid), Buffer.from(JSON.stringify({
      cid, query: resolved.query, url: got.url, width: got.width, height: got.height, bytes: got.bytes, at: Date.now()
    }, null, 2), 'utf8'))
  } catch (error) {
    return { ok: false, code: 'CACHE_WRITE_FAILED', cid, cids: resolved.cids, error: '结构图存不下来：' + String(error?.message ?? error), hint: '检查 ~/.dsh/stellar/chem-images 的权限。' }
  }
  pruneCache()
  return { ok: true, cid, cids: resolved.cids, file, width: got.width, height: got.height, bytes: got.bytes, cached: false, query: resolved.query, notes: resolved.notes, sourceUrl: got.url }
}
