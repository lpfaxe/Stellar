// verify.mjs —— 药品包装图的「文字硬校验」。
//
// 目标不是「看懂图」，而是回答一个可判定的问题：这张图上有没有同时出现
// 「药品名」和「规格」？两条都命中才算 verified；只命中一条只能算候选。
// OCR 用 Windows 自带引擎（零安装），做法与 PDF OCR 相同：进程可能以
// 0xC0000005 收尾，所以判输出文件，不判 exit code。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAlias } from './chem/aliases.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'ocr-image.ps1')
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

function tmpRoot() {
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    const v = process.env[key]
    if (v && !String(v).startsWith('undefined')) return v
  }
  const t = os.tmpdir()
  return t.includes('undefined') ? 'C:/Windows/Temp' : t
}

export function ocrAvailable() {
  return process.platform === 'win32' && fs.existsSync(PS) && fs.existsSync(SCRIPT)
}

function tidyLine(line) {
  return String(line || '')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000·•,，。.;；:：()（）\[\]【】/\\|_-]/g, '')
}

/** 从图片里认字；失败返回 {ok:false,error}，不抛。 */
export function ocrImage(file, { timeoutMs = 30000, scale = 1 } = {}) {
  if (!ocrAvailable()) return { ok: false, text: '', error: '这台机器没有可用的 Windows OCR' }
  const dir = fs.mkdtempSync(path.join(tmpRoot(), 'stellar-imgocr-'))
  const outPath = path.join(dir, 'out.json')
  try {
    const run = spawnSync(PS, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-InputPath', path.win32.normalize(String(file)),
      '-OutPath', outPath,
      '-Scale', String(Number(scale) > 1 ? Number(scale) : 1)
    ], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    let raw = ''
    try { raw = fs.readFileSync(outPath, 'utf8') } catch {}
    if (!raw) {
      const reason = run.error?.code === 'ETIMEDOUT' ? 'OCR 超时' : 'OCR 没有输出'
      return { ok: false, text: '', error: reason }
    }
    let data = null
    try { data = JSON.parse(raw) } catch { return { ok: false, text: '', error: 'OCR 输出不是 JSON' } }
    if (data?.error) return { ok: false, text: '', error: String(data.error).slice(0, 200) }
    const lines = Array.isArray(data?.lines) ? data.lines.map(tidyLine).filter(Boolean) : String(data?.text || '').split(/\r?\n/).map(tidyLine).filter(Boolean)
    return { ok: true, text: lines.join('\n'), lines, width: Number(data?.width) || 0, height: Number(data?.height) || 0, error: '' }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

export function strengthVariants(strength) {
  const m = /(\d+(?:\.\d+)?)\s*(mg|毫克|g|克|ml|毫升|μg|ug|微克)/i.exec(String(strength || ''))
  if (!m) return []
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const out = new Set()
  const add = (v, u) => out.add(String(v) + u)
  add(m[1], unit)
  if (unit === 'mg' || unit === '毫克') { add(m[1], 'mg'); add(m[1], '毫克'); add(n / 1000, 'g'); add(n / 1000, '克') }
  else if (unit === 'g' || unit === '克') { add(m[1], 'g'); add(m[1], '克'); add(n * 1000, 'mg'); add(n * 1000, '毫克') }
  else if (unit === 'ml' || unit === '毫升') { add(m[1], 'ml'); add(m[1], '毫升') }
  else { add(m[1], 'mg'); add(m[1], '微克') }
  return [...out].map((s) => s.replace(/(\.0+)(?=[a-z\u4e00-\u9fff])/i, ''))
}

export function matchName(text, { name = '', nameEn = '' } = {}) {
  const hay = normalizeForMatch(text)
  if (!hay) return ''
  const candidates = []
  const alias = resolveAlias(nameEn || name)
  if (name) candidates.push(name)
  if (nameEn) candidates.push(nameEn)
  if (alias?.nameEn) candidates.push(alias.nameEn)
  if (alias?.zh) candidates.push(alias.zh)
  for (const c of candidates) {
    const needle = normalizeForMatch(c)
    if (needle.length >= 2 && hay.includes(needle)) return c
  }
  return ''
}

export function verifyPackaging(file, { name = '', nameEn = '', strength = '' } = {}) {
  const ocr = ocrImage(file, { scale: 2 })
  if (!ocr.ok) return { ok: false, verified: false, text: '', error: ocr.error, matchedName: '', matchedStrength: '' }
  const matchedName = matchName(ocr.text, { name, nameEn })
  const variants = strengthVariants(strength)
  // 药盒小字常把 0 认成 O、1 认成 I/l；只在规格匹配时做这层数字纠偏，
  // 不去动药名，避免把 aspirin 里的 i 也换掉。
  const hay = normalizeForMatch(ocr.text).replace(/[oO]/g, '0').replace(/[ilI|]/g, '1')
  const matchedStrength = variants.find((v) => hay.includes(normalizeForMatch(v))) || ''
  return {
    ok: true,
    verified: Boolean(matchedName && matchedStrength),
    text: ocr.text.slice(0, 1200),
    matchedName,
    matchedStrength,
    error: ''
  }
}
