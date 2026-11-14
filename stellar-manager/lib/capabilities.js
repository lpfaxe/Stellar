/* 她的能力：面板只做校验 + 落盘，运行期判断在插件仓库的 src/capabilities.js 与各调用点。 */
import fs from 'node:fs'
import { CFG_FILE } from './paths.js'
import { atomicWriteJson, readJson } from './util.js'
import { CAPABILITY_BY_ID, listCapabilities, setCapabilityPath } from '../../src/capabilities.js'

export function capabilitiesSnapshot() {
  let mtime = 0
  try { mtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
  return { ok: true, groups: listCapabilities(), mtime }
}

/** updates: { [capabilityId]: boolean } —— 未知 id 直接报错，不静默吞掉。 */
export function saveCapabilities(updates) {
  const entries = Object.entries(updates || {})
  if (!entries.length) throw new Error('没有要保存的开关')
  for (const [id] of entries) {
    if (!CAPABILITY_BY_ID.has(String(id))) throw new Error('未知能力：' + id)
  }
  const cfg = readJson(CFG_FILE, {})
  for (const [id, value] of entries) setCapabilityPath(cfg, id, value === true)
  atomicWriteJson(CFG_FILE, cfg)
  let mtime = 0
  try { mtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
  return { ok: true, updated: entries.map(([id, value]) => ({ id, enabled: value === true })), mtime }
}
