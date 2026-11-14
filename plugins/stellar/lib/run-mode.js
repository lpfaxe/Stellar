/* 运行模式（owner 2026-11-11 22:25 定的三档）：
 *
 *   normal  正常模式 —— 现在这套：每日任务、生物钟、空间、B站全都跑。
 *   idle    摸鱼模式 —— 只留写日志 + 更主动找人聊天；醒来更频繁，B站刷 60 个、
 *           好友爱看看 20 条。周六、周日**默认**用这一档。
 *   minimal 最低限度 —— 停掉一切自主活动（不主动唤醒、不刷 B站/空间），
 *           只有 QQ 收到消息才醒，醒后 2 分钟没新消息就回去睡。
 *
 * 为什么单独一个文件：调度器、桥接、面板三处都要判断「现在是什么模式」，
 * 各写一份必然漂移。状态只有一个 JSON，读取走 mtime 缓存（改完下一轮生效）。
 *
 * 优先级：手动指定的模式 > 周末默认 > normal。手动指定只在**当天**有效
 * （state 里记了 day），跨天自动回到默认，避免「切了摸鱼忘记切回来」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const RUN_MODES = ['normal', 'idle', 'minimal'];
export const MODE_LABELS = {
  normal: '正常模式',
  idle: '摸鱼模式',
  minimal: '最低限度运行模式',
};
// 最低限度模式下，收到消息后保持清醒多久（主人指定 2 分钟）。
export const MINIMAL_IDLE_MS = 2 * 60 * 1000;

export function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'stellar', 'state');
}
export function modeFile() { return path.join(stateDir(), 'run-mode.json'); }

export function localDay(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function readRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(modeFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch { return null; }
}

/** 配置里显式写的模式（面板没点过就用它）；不合法返回空串。 */
function configuredMode(cfg) {
  const v = String(cfg?.runMode ?? '').trim().toLowerCase();
  return RUN_MODES.includes(v) ? v : '';
}

/** 周末（周六/周日）默认摸鱼 —— 主人 2026-11-11 的要求。 */
function weekendIdle(cfg, now) {
  if (cfg?.runModeWeekendIdle === false) return false;
  const day = new Date(now).getDay();
  return day === 0 || day === 6;
}

/**
 * 当前生效模式。
 * @param {{ now?: number, config?: object }} [opts]
 * @returns {{ mode:'normal'|'idle'|'minimal', source:'manual'|'config'|'weekend'|'default', day:string, raw:object|null }}
 */
export function currentRunMode({ now = Date.now(), config = null } = {}) {
  const day = localDay(now);
  const raw = readRaw();
  const manual = raw && raw.day === day && RUN_MODES.includes(String(raw.mode ?? '')) ? String(raw.mode) : '';
  if (manual) return { mode: manual, source: 'manual', day, raw };
  const cfg = configuredMode(config);
  if (cfg) return { mode: cfg, source: 'config', day, raw };
  if (weekendIdle(config, now)) return { mode: 'idle', source: 'weekend', day, raw };
  return { mode: 'normal', source: 'default', day, raw };
}

export function setRunMode(mode, { by = 'panel', now = Date.now() } = {}) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (!RUN_MODES.includes(m)) throw new Error('模式只能是 normal / idle / minimal，收到：' + mode);
  const file = modeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { version: 1, mode: m, day: localDay(now), setBy: String(by || 'panel'), setAt: now };
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8');
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  fs.renameSync(tmp, file);
  return currentRunMode({ now });
}

export function clearManualMode({ now = Date.now() } = {}) {
  try { fs.rmSync(modeFile(), { force: true }); } catch {}
  return currentRunMode({ now });
}

/** 这个模式允不允许某类自主活动。*/
export function modeAllows(mode, action) {
  const m = RUN_MODES.includes(String(mode)) ? String(mode) : 'normal';
  if (m === 'normal') return true;
  const act = String(action ?? '');
  if (m === 'minimal') return act === 'reply';
  // idle：写日志 + 主动找人聊天 + 刷视频 + 看好友爱看 + 到点醒来 + 待办提醒。
  // 2026-11-13 修：原来漏了 'wake'，而 tick() 第一行就是 modeCan('wake') ——
  // 结果摸鱼模式根本不会自己醒，videoTargetPerDay 60 / maxWakesPerDay 12 都没机会生效。
  // 发动态、发说说、三连、日报、B站搭话这些「按表交作业」的任务仍然全停。
  return ['diary', 'chat', 'watch', 'qzone-public', 'wake', 'todo'].includes(act);
}

/** 摸鱼模式要的数值覆盖（醒来更频繁、刷得更多）。 */
export function modeLimits(mode) {
  if (String(mode) === 'idle') {
    return { videoTargetPerDay: 60, maxWakesPerDay: 12, qzonePublicSeen: 20, minGapMin: 15 };
  }
  return {};
}