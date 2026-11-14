/* 紧急停止：主人手动按停；**不再自动恢复**（owner 2026-11-11 22:25：
 * 「之前控制台内的强制休眠的 24h 后自动重启废除，这三个模式在强制休眠的基础上制作」）。
 *
 * 停止期间：不回复、不主动唤醒、不发空间/动态/评论，只保留读能力。
 * 什么时候恢复？主人在控制台点「恢复」——三档运行模式（正常/摸鱼/最低限度）
 * 是**在停止之上**叠加的调节，不会再替你解除停止。
 *
 * 兼容：老状态文件里带 autoResumeAt 的，readStop 仍然当它是一条过期记录的判断依据，
 * 但 now 之后不再自动失效——只有 clearedAt / active=false 才算解除。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 保留导出：面板/桥接还在引用它做兼容判断，语义已经改成「历史字段」。
export const AUTO_RESUME_MS = 24 * 3600 * 1000;

export function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'stellar', 'state');
}
export function stopFile() { return path.join(stateDir(), 'emergency-stop.json'); }

export function readStop(now = Date.now()) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(stopFile(), 'utf8')); } catch {}
  if (!raw || raw.active !== true) return { active: false };
  const at = Number(raw.at) || 0;
  // 2026-11-11 之前写下的状态可能带 autoResumeAt：那时它意味着「到点自己恢复」。
  // 现在按主人新要求不再自动恢复：只有「旧版本写下的、已经过了它自己的 24h 线」
  // 那种记录才当失效（那时她本来就该自己起来了，继续卡住反而是新 bug）。
  const legacyAuto = Number(raw.autoResumeAt) || 0;
  if (legacyAuto > 0 && now >= legacyAuto) {
    return { active: false, expiredAt: legacyAuto, legacy: true };
  }
  return { active: true, at, autoResumeAt: legacyAuto, by: String(raw.by || ''), reason: String(raw.reason || ''), persistent: true };
}

export function setStop({ active, by = 'panel', reason = '', now = Date.now() } = {}) {
  const file = stopFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = active
    ? { active: true, at: now, by, reason: String(reason || '').slice(0, 200), persistent: true }
    : { active: false, at: now, clearedAt: now, by };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return readStop(now);
}