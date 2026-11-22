/* 说话方式（「鱼八股」）：面板侧的读写口 —— 读文件 / 校验 / 备份 / 原子写，
 * 解析与渲染一律交给仓库里的 stellar/src/voice-style.js（桥接侧的唯一真相）。
 *
 * 为什么动态 import 而不是在这抄一份渲染逻辑：
 *   桥接每次唤醒用 readVoiceStyle() 拼提示词，面板的预览必须与它逐字一致；
 *   抄一遍就是两份真相，改一处忘一处时「面板显示 A，她看到 B」，而且没人会发现。
 *
 * 谁写这张表：只有本面板的 /api/voice-style。她没有任何写配置的工具（工具面白名单 fail-closed），
 * 所以群友诱导不了她改自己的说话方式。
 *
 * 文件位置：<DSH_HOME>/stellar/state/voice-style.json（备份在同目录 voice-style.bak/）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { SURF, REPO } from './paths.js'
import { atomicWriteJson } from './util.js'

export const STATE_DIR = path.join(SURF, 'state')
export const STYLE_FILE = path.join(STATE_DIR, 'voice-style.json')
export const STATS_FILE = path.join(STATE_DIR, 'voice-stats.json')
export const BAK_DIR = path.join(STATE_DIR, 'voice-style.bak')

// 备份留几份：够回滚到「昨天那份」就行，别把 state 目录堆成垃圾场。
const BACKUP_KEEP = 10

// 仓库文件不在就当没有（面板照样能开，这张卡显示「读不到」）——绝不能让面板进程崩。
let modPromise = null
function voiceModule() {
  if (!modPromise) {
    const file = path.join(REPO, 'src', 'voice-style.js')
    modPromise = import(pathToFileURL(file).href)
      .then((mod) => {
        if (!mod || typeof mod.readVoiceStyle !== 'function' || typeof mod.validateVoiceStyle !== 'function') {
          throw new Error('src/voice-style.js 缺 readVoiceStyle/validateVoiceStyle')
        }
        return mod
      })
      .catch(() => { modPromise = null; return null })
  }
  return modPromise
}

function missingModule() {
  return { ok: false, message: '读不到仓库里的 src/voice-style.js' }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 备份文件名用的本地时间戳（按文件名倒序 = 时间倒序，所以不用读 mtime）。 */
function stampName(d = new Date()) {
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
}

/** 现有备份，最新的在前。 */
function backupList() {
  try {
    return fs.readdirSync(BAK_DIR).filter((n) => /\.json$/.test(n)).sort().reverse()
  } catch { return [] }
}

/** 把现在这份记成一次备份；没有旧文件就什么也不做（回空串）。 */
function backupCurrent() {
  let stat = null
  try { stat = fs.statSync(STYLE_FILE) } catch { return '' }
  if (!stat || !stat.size) return ''
  fs.mkdirSync(BAK_DIR, { recursive: true })
  const base = stampName()
  let name = base + '.json'
  let n = 2
  // 同一秒里连按两次保存：文件名会撞，加 -2 / -3 后缀，不许覆盖掉上一份备份。
  while (fs.existsSync(path.join(BAK_DIR, name))) { name = base + '-' + n + '.json'; n += 1 }
  fs.cpSync(STYLE_FILE, path.join(BAK_DIR, name))
  for (const old of backupList().slice(BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(BAK_DIR, old)) } catch {}
  }
  return name
}

/** 文件还没建时面板要显示的那份默认值（= 面板第一次打开的样子）。 */
function defaultStyle(mod) {
  return {
    enabled: true,
    stats: true,
    maxChars: mod.VOICE_MAX_CHARS,
    principles: mod.DEFAULT_PRINCIPLES.slice(),
    entries: [],
  }
}

/**
 * 面板读一份「显示用的真相」：当前 style + 渲染文本 + 今天的统计 + 上限。
 *
 * 文件不存在时必须显式给默认原则：readVoiceStyle() 对坏/丢文件走 normalizeVoiceStyle(null)，
 * 那里 principles 是空数组，而 renderVoiceStylePrompt 在没行可渲染时又兜底成 DEFAULT_PRINCIPLES ——
 * 不显式补，面板就会「上面空原则、下面预览却有 3 条」，主人一眼以为词表丢了。
 */
export async function readVoicePanel() {
  const mod = await voiceModule()
  if (!mod) return missingModule()

  let mtimeMs = 0
  let existed = false
  try {
    const stat = fs.statSync(STYLE_FILE)
    mtimeMs = stat.mtimeMs
    existed = stat.size > 0
  } catch { existed = false }

  let style
  let source
  if (existed) {
    const read = mod.readVoiceStyle({ file: STYLE_FILE })
    style = read.style
    source = read.source
  } else {
    style = defaultStyle(mod)
    source = 'default'
  }

  const rendered = mod.renderVoiceStylePrompt(style, { maxChars: style.maxChars })
  return {
    ok: true,
    file: STYLE_FILE,
    mtimeMs,
    source,
    style,
    rendered: { text: rendered.text, chars: rendered.chars, truncated: rendered.truncated, droppedLines: rendered.droppedLines },
    stats: mod.readVoiceStats({ file: STATS_FILE }),
    limits: {
      maxChars: mod.VOICE_MAX_CHARS,
      maxPrinciples: mod.VOICE_MAX_PRINCIPLES,
      maxEntries: mod.VOICE_MAX_ENTRIES,
      lineMax: mod.VOICE_LINE_MAX,
    },
    head: mod.VOICE_HEAD,
    legacy: mod.LEGACY_FALLBACK,
    hint: existed ? '' : '还没有 voice-style.json，保存一次就会建出来',
  }
}

function fileShape(style) {
  return {
    enabled: style.enabled !== false,
    stats: style.stats !== false,
    maxChars: style.maxChars,
    principles: style.principles,
    entries: style.entries,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 保存：先校验，不通过就一个字都不写（免得半份配置落盘、桥接下一轮读到怪东西）。
 * 通过则 备份旧文件 → 原子写 → 回读（回读的是「她下一轮真会看到的那段」，不是我们以为的那段）。
 */
export async function saveVoicePanel(patch) {
  const mod = await voiceModule()
  if (!mod) return missingModule()

  const checked = mod.validateVoiceStyle(patch && typeof patch === 'object' ? patch : {})
  if (!checked.ok) return { ok: false, errors: checked.errors }

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    backupCurrent()
    atomicWriteJson(STYLE_FILE, fileShape(checked.style))
  } catch (error) {
    return { ok: false, message: '写不进去：' + String((error && error.message) || error) }
  }
  // 同一毫秒内两次内容等长的写入会让 readVoiceStyle 的 mtime:size 键命中旧缓存；
  // 这里显式清一次，别让面板预览落后一格。
  try { if (typeof mod.resetVoiceStyleCache === 'function') mod.resetVoiceStyleCache() } catch {}

  const out = await readVoicePanel()
  return { ...out, ok: true, errors: [] }
}

/**
 * 回滚到最新一份备份。
 * 备份不删：恢复本身也是一次写入，会先把「现在这份」记成新备份，所以回滚也能再回滚
 * （A → B 之后想要 A，回滚一次就回来了，因为 A 还在备份里）。
 */
export async function restoreVoicePanel() {
  const mod = await voiceModule()
  if (!mod) return missingModule()

  const list = backupList()
  if (!list.length) return { ok: false, message: '还没有备份' }
  const name = list[0]

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.join(BAK_DIR, name), 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { ok: false, message: '这份备份读不出来：' + name }
  }

  const checked = mod.validateVoiceStyle(raw)
  if (!checked.ok) {
    return { ok: false, message: '这份备份不通过校验，没有写回去：' + checked.errors.join('；'), errors: checked.errors }
  }

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    backupCurrent()
    atomicWriteJson(STYLE_FILE, fileShape(checked.style))
  } catch (error) {
    return { ok: false, message: '写不进去：' + String((error && error.message) || error) }
  }
  try { if (typeof mod.resetVoiceStyleCache === 'function') mod.resetVoiceStyleCache() } catch {}

  const out = await readVoicePanel()
  return { ...out, ok: true, restored: name, errors: [] }
}

/**
 * 今天的用量（只数数量，不存原文）。
 * 统计开关关着也照常回数据（可能还有关之前记下的），只是多一个 disabled:true 让面板写「统计已关」。
 */
export async function readVoiceStatsPanel() {
  const mod = await voiceModule()
  if (!mod) return missingModule()
  const stats = mod.readVoiceStats({ file: STATS_FILE })
  const panel = await readVoicePanel()
  const on = !panel || panel.ok !== true || !panel.style ? true : panel.style.stats !== false
  return on ? { ok: true, stats } : { ok: true, stats, disabled: true }
}
