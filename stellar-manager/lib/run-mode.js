// 面板侧的运行模式读写：状态文件由 stellar 插件的 lib/run-mode.js 定义与解释，
// 这里只负责「读出来给人看」和「按键写进去」，判定逻辑绝不在面板里重写一份
// （重写必然漂移：一边按周末默认、一边按 normal）。
import fs from 'node:fs'
import path from 'node:path'
import { BRIDGE_CFG, SURF } from './paths.js'

const MODE_FILE = path.join(SURF, 'state', 'run-mode.json')
export const RUN_MODES = ['normal', 'idle', 'minimal']
export const MODE_LABELS = {
  normal: '正常模式',
  idle: '摸鱼模式',
  minimal: '最低限度运行模式',
}

const pad = (n) => String(n).padStart(2, '0')
export function localDay(now = Date.now()) {
  const d = new Date(now)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function readRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch { return null }
}

function readBridgeConfig() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8')) } catch { return {} }
}

/** 与插件 lib/run-mode.js 的 currentRunMode 保持同一套优先级。 */
export function readRunMode({ now = Date.now() } = {}) {
  const day = localDay(now)
  const raw = readRaw()
  const cfg = readBridgeConfig()
  const configured = RUN_MODES.includes(String(cfg.runMode || '').toLowerCase()) ? String(cfg.runMode).toLowerCase() : ''
  const weekend = cfg.runModeWeekendIdle !== false && [0, 6].includes(new Date(now).getDay())
  let mode = 'normal'
  let source = 'default'
  if (raw && raw.day === day && RUN_MODES.includes(String(raw.mode || ''))) {
    mode = String(raw.mode)
    source = 'manual'
  } else if (configured) {
    mode = configured
    source = 'config'
  } else if (weekend) {
    mode = 'idle'
    source = 'weekend'
  }
  return {
    mode,
    label: MODE_LABELS[mode] || mode,
    source,
    day,
    file: MODE_FILE,
    manual: Boolean(raw && raw.day === day && RUN_MODES.includes(String(raw.mode || ''))),
    setAt: raw && raw.day === day ? Number(raw.setAt) || 0 : 0,
    setBy: raw && raw.day === day ? String(raw.setBy || '') : '',
    weekend,
    configured,
  }
}

export function saveRunMode(mode, { by = 'panel', now = Date.now() } = {}) {
  const m = String(mode || '').trim().toLowerCase()
  if (!RUN_MODES.includes(m)) {
    const err = new Error('模式只能是 normal / idle / minimal，收到：' + mode)
    err.code = 'bad-mode'
    throw err
  }
  fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true })
  const data = { version: 1, mode: m, day: localDay(now), setBy: String(by || 'panel'), setAt: now }
  const tmp = MODE_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, MODE_FILE)
  return readRunMode({ now })
}