/**
 * Stellar —— 小镇的「超支熔断」：钱真的花过头时，把那条鱼停掉并留一条告警。
 *
 * 为什么要有它：每天 1 元是**小镇服务端**按 social_day_cents 挡的，不是我们挡的。
 * 只要那个值被改大、被清掉，或者小镇侧算错，钱就会从主人账户出去，而我们的
 * 日预算闸只管 token（记在 token-usage-daily.json 的 town 桶），两边不是一回事。
 * 所以这里读小镇自己报的 /spending，与本地的警戒线比：超了就把插件那条鱼停掉，
 * 并在状态目录留一条记录给日志与控制台看。
 *
 * 原则：宁可误停一次（她少玩一天），也不要静默超支。判据与记录都做成纯函数，
 * 免得「测过了」只是测了字符串（PITFALLS #280）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const GUARD_DEFAULTS = {
  enabled: true,
  // 小镇侧每天上限是 ¥1，这里留 50% 余量：正常永远不会到，到了就说明闸没生效。
  dailyCNY: 1.5,
  weeklyCNY: 6,
  action: 'pause-fish',
};

function num(v, dflt) {
  // null / 空串是「没写」，不是 0：不然 dailyCNY: null 会变成「不设限」。
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** 从 town 配置里读警戒线（坏值回落默认，绝不静默变成「不限」）。 */
export function guardConfig(townConfig = {}) {
  const raw = (townConfig && typeof townConfig === 'object' && townConfig.guard) || {};
  const action = raw.action === 'alert' || raw.action === 'off' ? raw.action : GUARD_DEFAULTS.action;
  return {
    enabled: raw.enabled !== false,
    dailyCNY: num(raw.dailyCNY, GUARD_DEFAULTS.dailyCNY),
    weeklyCNY: num(raw.weeklyCNY, GUARD_DEFAULTS.weeklyCNY),
    action,
  };
}

/** 小镇 /spending 里的金额是字符串（"0.12"），统一成数字。 */
export function parseYuan(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** { today, d7, d30, total } —— 缺的当 0。 */
export function spendingTotals(spending) {
  const raw = spending && typeof spending === 'object' ? spending : {};
  return {
    today: parseYuan(raw.today),
    d7: parseYuan(raw.d7),
    d30: parseYuan(raw.d30),
    total: parseYuan(raw.total),
  };
}

/**
 * 判定：超没超。返回 { ok, code: 'ok' | 'off' | 'daily' | 'weekly', today, d7, cap, action, reason }。
 * 「周」用小镇自己给的 d7（近 7 天），不用本地日历——它才是它算的那本账。
 */
export function evaluateGuard({ spending = null, config = {}, now = Date.now() } = {}) {
  const cfg = guardConfig(config);
  const totals = spendingTotals(spending);
  const base = { ...totals, config: cfg, at: Number(now) || Date.now() };
  if (!cfg.enabled) return { ok: true, code: 'off', ...base };
  if (cfg.dailyCNY > 0 && totals.today >= cfg.dailyCNY) {
    return {
      ok: false,
      code: 'daily',
      cap: cfg.dailyCNY,
      action: cfg.action,
      reason: '今天在小镇花了 ¥' + totals.today.toFixed(2) + '，到了警戒线 ¥' + cfg.dailyCNY.toFixed(2),
      ...base,
    };
  }
  if (cfg.weeklyCNY > 0 && totals.d7 >= cfg.weeklyCNY) {
    return {
      ok: false,
      code: 'weekly',
      cap: cfg.weeklyCNY,
      action: cfg.action,
      reason: '近 7 天在小镇花了 ¥' + totals.d7.toFixed(2) + '，到了警戒线 ¥' + cfg.weeklyCNY.toFixed(2),
      ...base,
    };
  }
  return { ok: true, code: 'ok', ...base };
}

/** 记录文件：state/town/guard.json（与 wake/actions/status 放一起，不进安装清单）。 */
export function guardFilePath(townDir) {
  const dir = String(townDir || '').trim();
  return dir ? path.join(dir, 'guard.json') : '';
}

export function emptyGuard() {
  return { at: 0, day: '', paused: false, code: '', today: 0, d7: 0, cap: 0, fishId: '', reason: '', banner: '' };
}

/** 读不出来就当「没告警」——不能因为状态文件坏了把她永久关在镇外。 */
export function readGuard(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyGuard();
    return {
      at: num(raw.at, 0),
      day: String(raw.day || ''),
      paused: Boolean(raw.paused),
      code: String(raw.code || ''),
      today: num(raw.today, 0),
      d7: num(raw.d7, 0),
      cap: num(raw.cap, 0),
      fishId: String(raw.fishId || ''),
      reason: String(raw.reason || ''),
      banner: String(raw.banner || ''),
    };
  } catch {
    return emptyGuard();
  }
}

/** 原子写：同目录 tmp 再 rename（写坏了也不留半份文件）。 */
export function writeGuard(file, rec) {
  const target = String(file || '').trim();
  if (!target) return { ok: false, error: 'no-file' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, file: target };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 组装要落盘的记录（纯函数）。paused 表示「真的把鱼停了」，
 * action='alert' 时只告警不停，所以 paused 为 false 而 code 非空。
 */
export function buildGuardRecord({ verdict, day = '', fishId = '', paused = false } = {}) {
  const v = verdict && typeof verdict === 'object' ? verdict : { ok: true, code: 'ok' };
  const bad = v.ok === false;
  const rec = {
    at: num(v.at, Date.now()),
    day: String(day || ''),
    paused: Boolean(bad && paused),
    code: String(v.code || 'ok'),
    today: num(v.today, 0),
    d7: num(v.d7, 0),
    cap: num(v.cap, 0),
    fishId: String(fishId || ''),
    reason: bad ? String(v.reason || '') : '',
    banner: '',
  };
  rec.banner = guardBanner(rec);
  return rec;
}

/** 给控制台的一句话（空串 = 没有告警）。 */
export function guardBanner(rec) {
  if (!rec || typeof rec !== 'object' || !rec.code || rec.code === 'ok' || rec.code === 'off') return '';
  // 有 code 没原因 = 记录不完整（可能是坏文件），宁可不说也别在面板上挂一条空告警。
  if (!rec.reason) return '';
  const when = rec.day ? String(rec.day).slice(5) : '';
  if (rec.paused) {
    return '⚠ 小镇超支熔断：' + (rec.reason || '') + (when ? '（' + when + '）' : '') + '。那条鱼已经停掉，进小镇的通道也断了；确认没问题后在「进小镇」开关那里重新打开。';
  }
  return '⚠ 小镇花费到了警戒线：' + (rec.reason || '') + (when ? '（' + when + '）' : '') + '。这次只记了一条告警，没有停她。';
}

/** 同一个诊断要不要重复告警：同一天 + 同一个 code 只记一次。 */
export function shouldAlert(prev, next) {
  const a = prev && typeof prev === 'object' ? prev : null;
  const b = next && typeof next === 'object' ? next : null;
  // 没有 code 的记录不是告警
  if (!b || !b.code) return false;
  if (!a || !a.code || a.code === 'ok' || a.code === 'off') return true;
  return !(a.code === b.code && a.day === b.day);
}
