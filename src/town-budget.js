/**
 * Stellar —— 小镇的钱：日预算闸与软目标文本。
 *
 * 为什么单独一个文件：调度器（决定叫不叫她、要不要提醒省着点）和 MCP 工具
 * （真正花钱的 visit/play/goto 之前的最后一道闸）必须用**同一份数字**。
 * 两处各写一遍，迟早会出现「调度器以为还有钱、工具已经花超」的错位。
 *
 * 数据来源：token-usage-daily.json 的 town 桶（由 token-budget-service 按会话分类写入），
 * 单位是人民币元。读不到就当 0（宁可让她做一次，也不要因为账本坏了整晚不醒）。
 */
import path from 'node:path';
import { readDailyUsage } from './token-budget.js';

export const DEFAULT_TOWN_DAILY_CNY = 1;
export const DEFAULT_TOWN_SOFT_CNY = 0.3;

/**
 * 今天在小镇花了多少（元）——直接给「数据目录」（里面有 token-usage-daily.json）。
 * 控制台快照是从 state/town 往上两级拿到的数据目录，走的正是这条；永不抛。
 */
export function townSpendFromDataDir(dataDir) {
  try {
    const dir = String(dataDir || '').trim();
    if (!dir) return 0;
    const daily = readDailyUsage(dir);
    const town = (daily && daily.town) || {};
    return Math.max(0, Number(town.cost ?? town.cny ?? 0) || 0);
  } catch { return 0; }
}

/** 今天在小镇花了多少（元）。永不抛。 */
export function townSpendToday(dshHome) {
  try {
    // 显式传空串 = 「这次没有数据目录」，不能回退到进程的 DSH_HOME：
    // 否则测试/离线调用会把真机上的账读进一个本该是 0 的地方（2026-11-22 修）。
    const home = String(dshHome === undefined || dshHome === null ? process.env.DSH_HOME || '' : dshHome).trim();
    if (!home) return 0;
    const daily = readDailyUsage(path.join(home, 'stellar'));
    const town = (daily && daily.town) || {};
    // readDailyUsage 归一出的是 { cost, tokens }；旧写法读 .cny 永远是 0（2026-11-21 修）。
    return Math.max(0, Number(town.cost ?? town.cny ?? 0) || 0);
  } catch { return 0; }
}

/** 日预算上限（元）。0 或负数 = 不设上限（不推荐）。 */
export function townDailyCap(config = {}) {
  const raw = config.dailyBudgetCNY;
  const cap = raw == null || raw === '' ? DEFAULT_TOWN_DAILY_CNY : Number(raw);
  if (!Number.isFinite(cap)) return DEFAULT_TOWN_DAILY_CNY; // 坏值回落默认，绝不静默变成「不限」
  return cap > 0 ? cap : 0;
}

/** 软目标（元）：花到这个数就提醒她省着点，但不拦。 */
export function townSoftCap(config = {}) {
  const raw = config.softBudgetCNY;
  const soft = raw == null || raw === '' ? DEFAULT_TOWN_SOFT_CNY : Number(raw);
  if (!Number.isFinite(soft)) return DEFAULT_TOWN_SOFT_CNY;
  return soft > 0 ? soft : 0;
}

/** 花超了没有。返回 { blocked, spent, cap }。 */
export function townBudgetState(dshHome, config = {}) {
  const spent = townSpendToday(dshHome);
  const cap = townDailyCap(config);
  return { blocked: cap > 0 && spent >= cap, spent, cap };
}

/** 同上，但入参是数据目录（控制台快照用）。 */
export function townBudgetStateFromDataDir(dataDir, config = {}) {
  const spent = townSpendFromDataDir(dataDir);
  const cap = townDailyCap(config);
  return { blocked: cap > 0 && spent >= cap, spent, cap };
}

/** 软目标提示（空串 = 还早，不用提醒）。 */
export function townSoftLine(dshHome, config = {}) {
  const soft = townSoftCap(config);
  if (!soft) return '';
  const spent = townSpendToday(dshHome);
  if (spent < soft) return '';
  const cap = townDailyCap(config);
  const tail = cap > 0 ? '（今天上限 ¥' + cap.toFixed(2) + '）' : '';
  return '今天在小镇的钱已经用掉大半了（软目标 ¥' + soft.toFixed(2) + '，已花 ¥' + spent.toFixed(2) + tail + '）：能不去花钱的地方就别去，也别请客。';
}
