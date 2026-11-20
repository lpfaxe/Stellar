// 好友爱看（QQ 空间公开推荐流）独立成会话 + 独立记账 + 每日总量闸门（2026-11-20）。
//
// 起因（主人发现的两件事）：
//   1. 控制台的 token 统计里没有「好友爱看」这一项 —— 因为它跟 B站 挤同一个会话，
//      花费全算进 bili，看着像免费的；
//   2. 她在同一轮里连跑了 4 次 `qzone public list`，一天看了 40 条（上限 10 的 4 倍）。
//      list 以前只按「这次拉几条」控制，从没算过「今天一共看过几条」。
//
// 这个测试盯的就是这两条：会话拆开了没有、账分开了没有、日总量有没有硬闸。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORY_SCOPES, SCOPE_LABELS, normalizeUsage, totalsOf } from '../src/token-budget.js';
import { CATEGORY_KEYS, emptyCategories, normalizeCategories } from '../plugins/stellar/lib/token-usage-pure.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
function check(cond, label) {
  if (!cond) throw new Error('❌ ' + label);
  passed += 1;
  console.log('✅ ' + label);
}

// ── 1. 记账：feed 必须是独立类别 ────────────────────────────────────────────
check(CATEGORY_KEYS.includes('feed'), 'CATEGORY_KEYS 含 feed');
check(CATEGORY_SCOPES.includes('feed'), 'CATEGORY_SCOPES 含 feed');
check(SCOPE_LABELS.feed === '好友爱看', 'feed 的显示名是「好友爱看」');
check(Object.hasOwn(emptyCategories(), 'feed'), 'emptyCategories 有 feed 桶');
const cats = normalizeCategories({ feed: { cost: 0.4, tokens: 4000 } });
check(cats.feed.cost === 0.4 && cats.feed.tokens === 4000, 'normalizeCategories 保留 feed 数字');
check(cats.qq.tokens === 0 && cats.other.cost === 0, '别的类别不被 feed 污染');
const summed = totalsOf(normalizeUsage({ qq: { cost: 1 }, bili: { cost: 2 }, feed: { cost: 4 }, other: { cost: 8 } }));
check(summed.cost === 15, '总额 = qq+bili+feed+other（不是漏掉 feed 的 11）');

// ── 2. 分类：feed-whale-* 会话归到 feed ────────────────────────────────────
const svc = read('plugins/stellar/lib/token-budget-service.js');
check(/\^feed-whale\(\?:-\|\$\)/.test(svc), 'token-budget-service 按 feed-whale 前缀分类');
check(svc.indexOf("return 'feed'") > svc.indexOf('/^bili-whale'), 'feed 判定排在 bili 之后、互不遮挡');

// ── 3. 会话真的拆开了 ─────────────────────────────────────────────────────
const sched = read('plugins/stellar/lib/scheduler.js');
check(sched.includes("const FEED_SESSION_ID = sessionId.replace(/^bili-whale/, 'feed-whale')"), '调度器派生出 feed-whale 会话 id');
check(sched.includes('await ensureSession(FEED_SESSION_ID)'), '好友爱看用自己的会话建会话');
check(/sessionId: FEED_SESSION_ID,/.test(sched), '好友爱看的 prompt 打到自己会话上');
check(/requestId: 'feed-whale-qzone-public-'/.test(sched), '好友爱看 requestId 也换了前缀');
check(/session\.id !== sessionId && session\.id !== FEED_SESSION_ID/.test(sched), 'session/created 监听认两个会话');
check(sched.includes('sessionId: FEED_SESSION_ID })') , 'retire 也会取消好友爱看会话');
check(sched.includes('const sessionsReady = new Set()'), '会话就绪状态按 id 分别记（不再是单个布尔）');

// ── 4. 日总量闸门 ────────────────────────────────────────────────────────
const qzone = read('plugins/stellar/tools/commands/qzone.mjs');
check(/const PUBLIC_SEEN_LIMIT = Math\.max\(1, Math\.min\(60, Number\(QZP\.seenTarget/.test(qzone), '日总量上限来自 qzone.public.seenTarget');
check(qzone.includes('const left = Math.max(0, PUBLIC_SEEN_LIMIT - seenToday)'), '算出「今天还能看几条」');
check(qzone.includes('if (left <= 0) {') && qzone.includes('process.exit(3)'), '到上限直接拒绝（exit 3），不再拉新的一批');
check(qzone.includes('const want = Math.min(asked, left)'), '没到上限时也不超过剩余额度');
check(qzone.indexOf('PUBLIC_SEEN_LIMIT - seenToday') < qzone.indexOf('const want = Math.min(asked, left)'), '先算额度再决定拉几条');

// ── 5. 桥接 / 面板：饲料那一类要能露出来 ─────────────────────────────────
const bridge = read('src/bridge.js');
check(bridge.includes('const feed = snapshot.day === day ? snapshot.feed'), '桥接当日用量读 feed');
check(/feed\?\.cost|feed\?\.tokens/.test(bridge), '桥接总额把 feed 加进去');
const panelCost = read('../stellar-manager/lib/cost.js');
check(/\{ key: 'feed', label: '好友爱看'/.test(panelCost), '面板花费页有「好友爱看」一类');
check(panelCost.includes("isFeed ? '好友爱看 · '"), '面板会话明细给 feed 会话单独起名');
const panelUi = read('../stellar-manager/public/js/cost.js');
check(/feed: 'linear-gradient/.test(panelUi), '面板 UI 给 feed 配了颜色');

console.log(`\n🎉 好友爱看独立会话 / 独立记账 / 日上限：${passed} 项通过`);
