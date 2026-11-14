/* 黑名单/未授权拦截审计：只追加一行 JSON，绝不参与消息处理 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {string} stateDir state 目录（调用方传入，测试可换临时目录）
 * @param {string} reason deny.users / deny.private / deny.groups / not-allowlisted
 * @param {{key?:string,userId?:string|number,kind?:string,id?:string|number}} info
 */
export function auditAccessBlock(stateDir, reason, info = {}) {
  try {
    const file = path.join(stateDir, 'access-audit.jsonl')
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1')
    } catch {}
    const line = JSON.stringify({
      at: new Date().toISOString(),
      reason: String(reason || 'blocked'),
      key: String(info.key || ''),
      userId: String(info.userId || ''),
      kind: String(info.kind || ''),
      id: String(info.id || ''),
    }) + '\n'
    fs.appendFileSync(file, line)
    return true
  } catch {
    return false
  }
}
