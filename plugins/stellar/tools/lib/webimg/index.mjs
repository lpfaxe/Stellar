// index.mjs —— 找图的三条路：结构式 / 药品包装 / 普通图。
//
// 分流的目的不是「多几个模式」，而是让每类图用各自可判定的准确性手段：
//   structure → PubChem CID（结构确定，白底 1000px）
//   product   → 来源可信 + OCR 校验药名/规格（命中才 verified）
//   photo     → 标题相关 + 真实像素/比例排序（不声称内容正确）
//
// 2026-11-27：通用图 / 包装图支持两阶段 preload（见 preload.mjs）。
// 预加载只写临时会话目录，不碰 web-images，也不消耗每天 30 张；pick 才落盘。
import fs from 'node:fs'
import path from 'node:path'
import { addWebImage, dayDir, listWebImages, MAX_PER_DAY } from '../web-images.mjs'
import { resolveAlias } from './chem/aliases.mjs'
import { getStructure } from './chem/pubchem.mjs'
import { searchGeneric } from './generic.mjs'
import { searchProduct } from './product.mjs'
import { clampPreload, createPreload, pickPreload, preloadStatus } from './preload.mjs'

export const MODES = ['auto', 'structure', 'product', 'photo']

function has(input, ...keys) { return keys.some((k) => String(input?.[k] || '').trim()) }

export function detectMode(input = {}) {
  const explicit = String(input.mode || 'auto').toLowerCase()
  if (MODES.includes(explicit) && explicit !== 'auto') return explicit
  const q = String(input.query || input.name || '')
  if (has(input, 'smiles', 'cas', 'nameEn') || /结构式|结构图|化学式|分子式|分子结构|structural formula/i.test(q)) return 'structure'
  if (has(input, 'manufacturer', 'brand', 'strength', 'dosageForm') || /药盒|包装|说明书|片剂|胶囊|颗粒|注射液|软膏|乳膏|滴眼液/.test(q)) return 'product'
  if (q && resolveAlias(q) && !/[\s，,。]/.test(q.trim())) return 'structure'
  return 'photo'
}

function publicItem(it, extra = {}) {
  return {
    name: it.name || '',
    file: it.file || '',
    bytes: it.bytes || 0,
    width: it.width || 0,
    height: it.height || 0,
    title: it.title || '',
    page: it.page || '',
    url: it.url || '',
    source: it.source || '',
    verified: Boolean(it.verified),
    ...extra
  }
}

function publicPreloadItem(it) {
  return {
    index: Number(it.index) || 0,
    bytes: Number(it.bytes) || 0,
    width: Number(it.width) || 0,
    height: Number(it.height) || 0,
    title: String(it.title || '').slice(0, 200),
    page: String(it.page || '').slice(0, 300),
    verified: Boolean(it.verified),
    ocr: it.verified && it.ocr ? { name: it.ocr.name || '', strength: it.ocr.strength || '' } : undefined
  }
}

function cleanupTemp(items) {
  for (const it of Array.isArray(items) ? items : []) {
    try { if (it?.file) fs.rmSync(it.file, { force: true }) } catch {}
  }
}

function saveItems(items, meta, { limit }) {
  const saved = []
  const seenHash = new Set()
  for (const it of items) {
    if (saved.length >= limit) break
    if (it.sha256 && seenHash.has(it.sha256)) { try { fs.rmSync(it.file, { force: true }) } catch {} ; continue }
    const added = addWebImage(it.file, {
      origin: meta.origin,
      source: meta.source,
      query: meta.query,
      title: it.title || meta.query,
      page: it.page || '',
      url: it.url || '',
      by: 'her'
    })
    try { fs.rmSync(it.file, { force: true }) } catch {}
    if (!added.ok) { meta.notes.push('有一张没存下：' + added.reason); continue }
    if (it.sha256) seenHash.add(it.sha256)
    saved.push(publicItem(it, {
      name: added.name,
      file: added.file,
      bytes: added.bytes,
      source: meta.source,
      verified: Boolean(it.ocrVerified || it.verified),
      ocr: it.ocrVerified ? { name: it.ocrName || '', strength: it.ocrStrength || '' } : undefined
    }))
  }
  return saved
}

function roomLeft() {
  const before = listWebImages().images.length
  return Math.max(0, MAX_PER_DAY - before)
}

function preloadResult(res, { mode, query, notes }) {
  const built = createPreload({
    query,
    mode,
    engine: res.engine,
    items: res.items,
    stats: res.stats || {}
  })
  cleanupTemp(res.items)
  if (!built.ok) {
    return { ok: false, code: 'PRELOAD_FAILED', mode, items: [], error: built.error || '预加载失败', hint: '直接不带 preload 再搜一次，或换个关键词。' }
  }
  const extraNotes = [...notes, res.note, built.error].filter(Boolean)
  return {
    ok: true,
    code: '',
    mode,
    query,
    preload: true,
    session: built.session,
    sheet: built.sheet,
    items: built.items.map(publicPreloadItem),
    stats: built.stats,
    notes: extraNotes,
    error: '',
    hint: '看联系表挑 1–' + 5 + ' 张，再用 action=pick session=' + built.session + ' picks=[1,4,7] 存进今天；只有存下来才占 30 张额度。',
    dir: built.dir,
    count: listWebImages().images.length,
    max: MAX_PER_DAY
  }
}

/** 统一入口。返回的 items 里 file 已经落到本地（结构式在 chem-images，其余在今天的网图目录）。 */
export async function searchImages(input = {}, { n = 3, preload = 0 } = {}) {
  const mode = detectMode(input)
  const query = String(input.query || input.name || input.queryText || '').trim()
  const want = Math.max(1, Math.min(10, Number(n) || 3))
  const deep = clampPreload(preload)
  const notes = []
  if (!query && !has(input, 'cas', 'smiles', 'nameEn', 'name')) {
    return { ok: false, code: 'NEED_IDENTIFIER', mode, items: [], error: '要搜什么图？给 query，或给 chemical 里的 name/cas/nameEn。', hint: '例如 query=「雪山下的木屋」；化学结构式给 nameEn=aspirin 或 cas=50-78-2。' }
  }

  if (mode === 'structure') {
    const got = await getStructure({
      name: input.name || query,
      nameEn: input.nameEn,
      cas: input.cas,
      smiles: input.smiles
    })
    if (!got.ok) {
      return { ok: false, code: got.code || 'PUBCHEM_UNAVAILABLE', mode, items: [], error: got.error || '没取到结构式', hint: got.hint || '给 CAS 号或英文通用名再试。' }
    }
    const label = input.name || input.nameEn || ('CID ' + got.cid)
    const item = publicItem({
      file: got.file,
      name: 'cid-' + got.cid + '.png',
      bytes: got.bytes,
      width: got.width,
      height: got.height,
      title: label + ' 二维结构式',
      page: 'https://pubchem.ncbi.nlm.nih.gov/compound/' + got.cid,
      url: got.sourceUrl || ('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/' + got.cid + '/PNG'),
      source: 'pubchem',
      verified: true
    }, { cid: got.cid, cids: got.cids, cached: Boolean(got.cached) })
    notes.push('结构式来自 PubChem，按 CID 确定，不走 Bing。')
    if (got.cids?.length > 1) notes.push('命中多个 CID（' + got.cids.slice(0, 5).join(', ') + '），给的是第一个；要别的请指定 CAS。')
    return { ok: true, code: '', mode, query: label, verified: true, items: [item], notes, error: '', hint: '', dir: path.dirname(got.file), count: listWebImages().images.length, max: MAX_PER_DAY }
  }

  const room = roomLeft()
  if (room <= 0) {
    return { ok: false, code: 'DAILY_LIMIT', mode, items: [], error: '今天的网图已经放满 ' + MAX_PER_DAY + ' 张了', hint: '明天会自动清空；要腾地方先 webimg del / clear。结构式不占这个额度。' }
  }
  const limit = Math.min(want, room)
  if (mode === 'product') {
    const res = await searchProduct({
      name: input.name || query,
      nameEn: input.nameEn,
      strength: input.strength,
      manufacturer: input.manufacturer,
      brand: input.brand,
      dosageForm: input.dosageForm,
      query
    }, { n: limit, preload: deep })
    if (!res.ok) return { ok: false, code: res.code || 'NO_CANDIDATES', mode, items: [], error: res.error || '没找到可用包装图', hint: res.hint || '给厂家名/规格再试，或只查结构式。' }
    if (res.preload) return preloadResult(res, { mode, query, notes })
    const saved = saveItems(res.items, { origin: 'product', source: (res.engine || 'bing') + '-product', query, notes }, { limit })
    if (!saved.length) return { ok: false, code: 'NO_CANDIDATES', mode, items: [], error: '候选图都没存下来', hint: '检查今天的 30 张额度，或换个说法再试。' }
    return { ok: true, code: '', mode, query, verified: Boolean(res.verified), items: saved, notes: [...notes, res.note], error: '', hint: '', dir: dayDir(), count: listWebImages().images.length, max: MAX_PER_DAY }
  }

  const res = await searchGeneric(query, { n: limit, preload: deep })
  if (!res.ok) return { ok: false, code: res.code || 'NO_CANDIDATES', mode, items: [], error: res.error || '没找到可用图', hint: res.hint || '换个更具体的词再试。' }
  if (res.preload) return preloadResult(res, { mode, query, notes })
  const saved = saveItems(res.items, { origin: 'web', source: (res.engine || 'bing') + '-image', query, notes }, { limit })
  if (!saved.length) return { ok: false, code: 'NO_CANDIDATES', mode, items: [], error: '候选图都没存下来', hint: '检查今天的 30 张额度，或换个说法再试。' }
  return { ok: true, code: '', mode, query, verified: false, items: saved, notes: [...notes, res.note], error: '', hint: '', dir: dayDir(), count: listWebImages().images.length, max: MAX_PER_DAY }
}

/** pick 阶段：把预加载会话里挑中的编号真正存进今天的网图目录。 */
export function pickImages(session, picks = []) {
  return pickPreload(session, picks)
}

/** 预加载目录现状（给 CLI / 排障用）。 */
export function webimgPreloadStatus() {
  return preloadStatus()
}
