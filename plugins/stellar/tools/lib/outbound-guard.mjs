/**
 * B站 出站身份闸（2026-10-23 用户要求：只准自己互认，不许泄露主人和别人的信息）。
 *
 * 为什么在工具层：
 *   · B站 评论/动态是**公开面**，一旦把主人的 QQ 号、主人的 B站 mid、或对齐表里
 *     别人的账号贴出去，就再也收不回来；
 *   · 提示词里的「不许泄露」只是概率约束，正则才是确定性的。
 *
 * 受保护的东西（只认这些，避免误伤普通数字）：
 *   · 主人：合体层 `admin.qq` / `admin.biliMid`、`bili.config.json` 的 `owner.mid`；
 *   · 别人：`alignments.json` 里每个 link 的各平台 id（QQ 号 / B站 mid / 贴吧 uid）；
 *   · 任何「QQ / 群号 + 数字」形态（即使不在名单里，那也是在往外递联系方式）。
 * 明确**不拦**：她自己的 B站 mid（公开资料）、昵称（会撞、误伤成本高）、普通数字。
 *
 * 只负责「要不要发」，不做内容改写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { STELLAR_DIR } from './state-paths.mjs';
import { findIdentityLeaks, formatIdentityLeakError } from '../../../../src/identity-guard.js';
import { checkPrivacy, privacyRejectText } from './privacy-guard.mjs';

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * 收集「不许出现在 B站 出站文本里」的 ID。
 * @param {{stellarDir?:string}} options 覆盖配置目录（测试用）
 * @returns {string[]}
 */
export function collectProtectedIdentities({ stellarDir = STELLAR_DIR } = {}) {
  const unified = readJson(path.join(stellarDir, 'config.json'), {}) ?? {};
  const bili = readJson(path.join(stellarDir, 'bili.config.json'), {}) ?? {};
  const align = readJson(path.join(stellarDir, 'alignments.json'), {}) ?? {};
  const admin = unified && typeof unified.admin === 'object' && unified.admin ? unified.admin : {};
  const owner = bili && typeof bili.owner === 'object' && bili.owner ? bili.owner : {};
  const self = bili && typeof bili.self === 'object' && bili.self ? bili.self : {};
  const selfMid = String(self.mid ?? '').trim();
  const ids = new Set();
  const add = (value) => {
    const s = String(value ?? '').trim();
    if (!/^\d{4,15}$/.test(s) || s === selfMid) return;
    ids.add(s);
  };
  add(admin.qq);
  add(admin.biliMid);
  add(owner.mid);
  for (const link of Array.isArray(align.links) ? align.links : []) {
    const identities = link && typeof link.identities === 'object' ? link.identities : {};
    for (const identity of Object.values(identities)) add(identity && identity.id);
  }
  return [...ids];
}

/**
 * 出站前检查。命中就抛 Error（调用方负责打印并中止发送）。
 * @param {string} text 准备发出去的正文
 * @param {{surface?:string, stellarDir?:string, ids?:string[]}} options
 */
export function assertOutboundIdentitySafe(text, { surface = 'B站 内容', stellarDir, ids, audience = 'public', selfUin } = {}) {
  const protectedIds = Array.isArray(ids) ? ids : collectProtectedIdentities({ stellarDir });
  const hits = findIdentityLeaks(text, { ids: protectedIds });
  if (hits.length) throw new Error(formatIdentityLeakError(hits, surface));
  // 第二道：主人自己的生日/城市/住址/电话，以及通讯录里别人的号码与备注（2026-11-10 要求）。
  // 私信时名字放行（c.uin 仍拦），公开面（动态/评论/视频）名字也拦。
  const privacy = checkPrivacy(text, { audience, selfUin });
  if (!privacy.ok) throw new Error(privacyRejectText(privacy.hits) + '（命中：' + privacy.hits.map((h) => h.why).join('、') + '）');
  return { ok: true, hits };
}
