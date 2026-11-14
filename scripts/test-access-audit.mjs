/* 黑名单审计单测：字段完整、只追加、2MB 轮转、坏目录不抛 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditAccessBlock } from '../src/access-audit.js'

let failed = 0
const ok = (cond, name) => { if (cond) console.log('  ok   ' + name); else { failed++; console.log('  FAIL ' + name) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'))
try {
  ok(auditAccessBlock(dir, 'deny.users', { key: 'private:1', userId: 2, kind: 'private', id: 3 }) === true, 'write returns true')
  ok(auditAccessBlock(dir, 'not-allowlisted', {}) === true, 'write without info works')
  const lines = fs.readFileSync(path.join(dir, 'access-audit.jsonl'), 'utf8').trim().split('\n')
  ok(lines.length === 2, 'two lines appended')
  const rec = JSON.parse(lines[0])
  ok(rec.reason === 'deny.users' && rec.key === 'private:1' && rec.userId === '2' && rec.kind === 'private' && rec.id === '3', 'fields preserved')
  ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.at), 'ISO timestamp')

  fs.writeFileSync(path.join(dir, 'access-audit.jsonl'), 'x'.repeat(2 * 1024 * 1024 + 10))
  auditAccessBlock(dir, 'deny.groups', { id: 9 })
  ok(fs.existsSync(path.join(dir, 'access-audit.jsonl.1')), 'rotates at 2MB')
  ok(fs.statSync(path.join(dir, 'access-audit.jsonl')).size < 200, 'new file is small')

  const bad = path.join(dir, 'no-such-dir')
  ok(auditAccessBlock(bad, 'deny.users', {}) === false, 'bad dir returns false, does not throw')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'access audit test FAILED (' + failed + ')' : 'access audit test OK')
process.exitCode = failed ? 1 : 0
