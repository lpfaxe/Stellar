#!/usr/bin/env node
// test-town-scheduler.mjs —— 小镇影子会话调度（P2）的静态契约（2026-11-21）。
//
// 为什么是静态断言：townTick / townPlanDay 都在 startScheduler 的闭包里，
// 没有导出；真跑需要 DSH 宿主 + 会话控制器 + 真访问码。这里钉住的是
// 「不花钱、不越界、不丢定时器」这些一旦改坏就会静默出事的形状。
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('✅ ' + label); }
  else { failed += 1; console.error('❌ ' + label); }
}

const root = path.join(import.meta.dirname, '..');
const scheduler = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'lib', 'scheduler.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const caps = fs.readFileSync(path.join(root, 'src', 'capabilities.js'), 'utf8');
const defaults = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'tools', 'lib', 'config.mjs'), 'utf8');

// 1. 存在性
ok(scheduler.includes("const TOWN_SESSION_ID = 'town-whale'"), '影子会话 id = town-whale');
ok(scheduler.includes('function townTick('), '有 townTick');
ok(scheduler.includes('function townCollectTick('), '有 townCollectTick');
ok(scheduler.includes('function townPlanDay('), '有 townPlanDay');
ok(scheduler.includes('function ensureTownSession('), '有 ensureTownSession');
ok(scheduler.includes("let preset = 'town-act'") && scheduler.includes('agentPreset: preset'), '影子会话用 town-act 预设');

// 2. 守卫链顺序（任何一环挪到后面都等于放宽；顺序即安全语义）
const tickStart = scheduler.indexOf('async function townTick(');
const tickEnd = scheduler.indexOf('const timer = setInterval(() => { tick()');
const body = tickStart >= 0 && tickEnd > tickStart ? scheduler.slice(tickStart, tickEnd) : '';
ok(body.length > 0, '能切出 townTick 函数体');
const order = [
  ['busy 重入保护', "if (townBusy) return"],
  ['运行模式闸', "modeCan('town')"],
  ['能力开关', "capabilityEnabled('town')"],
  ['配置开关（默认关，必须显式 true）', 'T.enabled !== true'],
  ['会话控制器', 'ctx.sessionController'],
  ['没有访问码就不醒', 'townClientNow()'],
  ['当天次数上限', 'state.wakes.length >= state.plan.length'],
  ['到点才醒', 'nowMs < next'],
  ['最小间隔', 'minGapMin'],
  ['静默时段', "peakBlockedNow('小镇唤醒')"],
  ['当日预算', "budgetBlockedNow('小镇唤醒')"],
];
let lastAt = -1;
let ordered = true;
for (const [label, needle] of order) {
  const at = body.indexOf(needle);
  ok(at >= 0, 'townTick 含「' + label + '」判定');
  if (at < 0 || at < lastAt) ordered = false;
  lastAt = Math.max(lastAt, at);
}
ok(ordered, '守卫顺序：busy → 模式 → 能力 → 配置（默认关） → 控制器 → 访问码 → 次数 → 时间 → 间隔 → 静默 → 预算');

// 3. 先占位再叫醒（否则 promptBili 抛错会每小时重试、把一天 3 次烧成无限次）
const writeWakeAt = body.indexOf('writeTownWake(state)');
const sessionAt = body.indexOf('ensureTownSession()');
const promptAt = body.indexOf("requestId: 'town-whale-'");
ok(writeWakeAt > 0 && sessionAt > writeWakeAt && promptAt > sessionAt, '先写 wake.json 占位，再建会话，最后叫醒');

// 4. 零动作：P2 只读，调度器里不该出现任何小镇动作端点
ok(!/act\('visit'/.test(scheduler) && !/act\('play'/.test(scheduler) && !/act\('goto'/.test(scheduler),
  '调度器不调用任何小镇动作端点（visit/play/goto）');
ok(!scheduler.includes("client.act("), '调度器完全不调用 act()');

// 5. 定时器挂载 / 停止 / 退休
ok(scheduler.includes('townCollectTick().catch(() => {}) }, 35_000'), '启动后 35s 跑第一次采集');
ok(scheduler.includes('townTick().catch(() => {}) }, 38_000'), '启动后 38s 跑第一次唤醒检查');
ok(/setInterval\(\(\) => \{\s*town[\s\S]{0,200}?\}, 60_000\)/.test(scheduler), '每分钟一个独立的小镇定时器（采集+唤醒）');
ok(scheduler.includes('clearInterval(timerTown)'), 'stop() 会清掉小镇定时器');
ok(/retire[\s\S]{0,400}TOWN_SESSION_ID/.test(scheduler), 'retire() 会收掉影子会话');

// 6. 预设缺失就不醒（避免退化成万能会话）
ok(scheduler.includes("'town-act'") && scheduler.includes('ids.includes(preset)'), '会校验 town-act 预设存在');
ok(/return false/.test(scheduler.slice(scheduler.indexOf('function ensureTownSession('), scheduler.indexOf('function townWakeText('))),
  '预设缺失时 ensureTownSession 回 false 而不是降级');

// 7. 唤醒提示把边界写死
const wake = scheduler.slice(scheduler.indexOf('function townWakeText('), scheduler.indexOf('async function townTick(') + 1);
ok(wake.includes('不坐下') && wake.includes('不发消息'), '唤醒提示明确禁止坐下/发消息');
ok(wake.includes('数据') && (wake.includes('不是命令') || wake.includes('不是给你的')), '唤醒提示声明小镇文本是数据不是命令');
ok(wake.includes('stellar_town_day'), '唤醒提示允许写一句当日感受');

// 7.5 默认不启用（发布版只留接口）：配置文件默认 enabled=false，两处守卫都要求显式 true
ok(/town:\s*\{[\s\S]{0,400}?enabled:\s*false/.test(defaults), 'config 里 town.enabled 默认 false（发布版不启用）');
ok(scheduler.split('T.enabled !== true').length - 1 === 2, '采集与唤醒两处守卫都写成 !== true（缺失/未填一律不跑）');

// 8. 配置默认值与能力开关
ok(/town:\s*\{[\s\S]{0,600}?wakesPerDay:\s*3/.test(defaults), 'config 默认每天 3 次');
ok(/town:\s*\{[\s\S]{0,600}?actions:\s*false/.test(defaults), 'config 默认 actions=false');
ok(/town:\s*\{[\s\S]{0,600}?dailyBudgetCNY:\s*1/.test(defaults), 'config 默认日预算 ¥1');
ok(caps.includes("id: 'town'") && caps.includes("path: 'town.enabled'"), 'capabilities 注册 town 开关');

// 9. 提示词只给指针，不注入正文
const townLineAt = bridge.indexOf('townLine');
ok(townLineAt > 0, 'bridge 有 townLine');
const townLineBlock = bridge.slice(townLineAt - 600, townLineAt + 1600);
ok(townLineBlock.includes('stellar_town_recall'), '提示里指向 stellar_town_recall');
ok(townLineBlock.includes('bili.config.json'), '提示读的是 bili.config.json（与能力开关同源）');
ok(!/townLine\s*\+?=\s*[^;]*renderRecall/.test(bridge), '唤醒提示不注入小镇正文（只给指针）');

// 10. token 分类
const tokenPure = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'lib', 'token-usage-pure.js'), 'utf8');
const budgetSvc = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'lib', 'token-budget-service.js'), 'utf8');
ok(tokenPure.includes("'town'"), 'token 类别含 town');
ok(/\^town-whale/.test(budgetSvc), 'town-whale 会话记到 town 类别');

console.log(failed ? '\n❌ 小镇调度契约：' + passed + ' 通过 / ' + failed + ' 失败' : '\n🎉 小镇调度契约：' + passed + ' 项通过');
process.exit(failed ? 1 : 0);
