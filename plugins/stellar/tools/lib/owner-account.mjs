/**
 * 主人 B 站账号的凭据解析（只读用）。
 *
 * 正常情况：owner-credentials.json（设置页「扫码登录主人的 B站 账号」写入）。
 * 单账号情况（config.self.mid === config.owner.mid，主人和示例账号本来就是一个号）：
 *   没有 owner-credentials.json 时复用 credentials.json —— 同一个号不需要两份 cookie。
 *
 * 边界不变：这里只给「只读」命令用（看历史/收藏/关注/推荐/口味抓取）；
 * 用主人号发评论/动态/私信仍然是被禁止的（见 lib/bili-qr-login.mjs:9-13）。
 */
import fs from 'node:fs'
import { accountBili } from './state-paths.mjs'
import { config } from './config.mjs'

const fishFile = () => process.env.STELLAR_FISH_CREDENTIALS || accountBili('credentials.json')
const ownerFile = () => process.env.STELLAR_OWNER_CREDENTIALS || accountBili('owner-credentials.json')

function readCred(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data?.sessdata || !data?.bili_jct) return null
    return data
  } catch {
    return null
  }
}

export function sameAccount(cfg = config()) {
  const self = String(cfg?.self?.mid ?? '').trim()
  const owner = String(cfg?.owner?.mid ?? '').trim()
  return Boolean(self && owner && self === owner)
}

/**
 * @returns {{cred:object, file:string, shared:boolean, mid:string, name:string}|null}
 *   shared=true 表示主人号与示例账号是同一个号、复用的是 credentials.json
 */
export function resolveOwnerCredentials() {
  const cfg = config()
  const owner = readCred(ownerFile())
  if (owner) {
    return {
      cred: owner,
      file: ownerFile(),
      shared: false,
      mid: String(owner.mid ?? cfg?.owner?.mid ?? ''),
      name: String(owner.name ?? cfg?.owner?.name ?? ''),
    }
  }
  if (sameAccount(cfg)) {
    const fish = readCred(fishFile())
    if (fish) {
      return {
        cred: fish,
        file: fishFile(),
        shared: true,
        mid: String(fish.mid ?? cfg?.self?.mid ?? ''),
        name: String(fish.name ?? cfg?.self?.name ?? ''),
      }
    }
  }
  return null
}

/** 读不到主人凭据时给一句人能照着做的话。 */
export function ownerCredentialHint() {
  const cfg = config()
  if (!String(cfg?.owner?.mid ?? '').trim()) {
    return '配置里还没有主人 B站 mid：设置 →「她是谁」里填上，再扫码登录主人号'
  }
  if (sameAccount(cfg)) {
    return '主人号和她的号是同一个 mid，但本机读不到 B站 cookie：设置 → B站 重新扫码登录一次（鱼）即可'
  }
  return '还没有扫码登录主人的 B站 账号：设置 → B站 →「扫码登录主人的 B站 账号」'
}
