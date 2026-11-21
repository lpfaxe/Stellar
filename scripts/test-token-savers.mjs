// 省 token 的四项改动（2026-11-21，主人：完成省token的四项）。
//
// 背景（实测 token-usage-daily.json / context-telemetry-plugin.jsonl）：
//   一天 20.33M token、¥1.55，其中 cacheMiss 830k = ¥0.83、cacheHit 19.41M = ¥0.39、
//   输出只占 ¥0.33 —— 所以「压回复长度」「关压缩」都没用，钱在**调用次数 × 每步上下文**。
// 四项分别是：
//   1. 点赞/评论合成一条 `qzone public batch`（以前 3 赞 + 3 评 = 6 次模型往返）；
//   5. 人格卡（约 2160 字符）从「每轮重印」改成「新会话首轮全文 + 每 10 轮刷新」；
//   6. 看视频简报默认额度 3600→2400，附件文件没变就只说「没变」；
//   7. 全账号每日唤醒上限 25（防极端一天；direct 唤醒不受影响）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
function check(cond, label) {
  if (!cond) throw new Error('❌ ' + label);
  passed += 1;
  console.log('✅ ' + label);
}

const qzone = read('plugins/stellar/tools/commands/qzone.mjs');
const scheduler = read('plugins/stellar/lib/scheduler.js');
const bridge = read('src/bridge.js');
const mcp = read('src/mcp-snowluma-safe.js');

// ── 第 1 项：batch 子命令 ──────────────────────────────────────────────────
check(/async function publicBatch\(\)/.test(qzone), 'qzone 有 publicBatch()');
check(/action === 'batch' \|\| action === 'do'\) \{ await publicBatch\(\); return \}/.test(qzone), 'batch 已注册进 qzone public 分发');
check(qzone.includes('--likes') && qzone.includes('--comments'), 'batch 收 --likes 与 --comments');
check(/publicStat\(feed\)\.liked/.test(qzone), 'batch 会跳过已经赞过的');
check(/publicTouched\('public-comment', id\)/.test(qzone), 'batch 会跳过已经评过的（同一条只评一次）');
check(/checkPrivacy\(c\.text, \{ audience: 'public' \}\)/.test(qzone), 'batch 走同一套公开隐私闸');
check(/PUBLIC_LIKE_LIMIT/.test(qzone) && /PUBLIC_COMMENT_LIMIT/.test(qzone), 'batch 仍守每日赞/评上限');
check(/process\.exit\(6\)/.test(qzone), '超额度/有失败时以非 0 退出（别让模型以为成功了）');
check(/\} catch \(e\) \{/.test(qzone) && /const why = String/.test(qzone), 'batch 单条失败不影响其余');

// 真跑一次：不带参数必须 exit 2 并说明要做什么（真代码路径，不是读源码）
let batchOut = '';
let batchCode = 0;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'plugins/stellar/tools/bili.mjs'), 'qzone', 'public', 'batch'], { encoding: 'utf8', stdio: 'pipe' });
} catch (error) {
  batchCode = error.status;
  batchOut = String(error.stderr || '') + String(error.stdout || '');
}
check(batchCode === 2, 'batch 不带参数 → exit 2');
check(/--likes|--comments/.test(batchOut), 'batch 不带参数会告诉模型该给什么');

// 唤醒词：3+4 合并成一条 batch（不再一条一条 like/comment）
const feedSeg = scheduler.slice(scheduler.indexOf('【好友爱看】'), scheduler.indexOf("log('[feed-whale] 好友爱看提醒"));
check(/qzone public batch --likes/.test(feedSeg), '好友爱看唤醒词用 batch 一条命令');
check(!/qzone public like --id/.test(feedSeg), '唤醒词里不再出现逐条 like --id');
check(!/qzone public comment --id/.test(feedSeg), '唤醒词里不再出现逐条 comment --id');
check(/qzone public list/.test(feedSeg), 'list 仍然保留（一次就够）');

// ── 第 5 项：人格卡轮换 + 两段长说明压缩 ─────────────────────────────────
check(/function personaWakeBlockV2\(key, session = ''\)/.test(bridge), 'personaWakeBlockV2 认得 session');
check(/nth % 10 !== 1/.test(bridge), '人格卡每 10 次刷新一次');
check(/String\(session \|\| key \|\| ''\)/.test(bridge), '轮换计数按会话隔离（换会话重新给全文）');
check(/function buildWakePromptV2\(key, reason, vectorBlock = '', session = ''\)/.test(bridge), 'buildWakePromptV2 透传 session');
check(/buildWakePromptV2\(key, opts\.wakeReason, vectorBlock, sessionId\)/.test(bridge), '投递时把真实 sessionId 传进去');
const personaStart = bridge.indexOf('function personaWakeBlockV2');
const personaEnd = bridge.indexOf('/** 生图额度', personaStart);
const personaSeg = bridge.slice(personaStart, personaEnd);
check(/（人设同前，不用重述/.test(personaSeg), '非刷新的那几轮只给指针');
const replyLine = bridge.slice(bridge.indexOf('const replyLine ='), bridge.indexOf('const preSleepLine ='));
const preSleepLine = bridge.slice(bridge.indexOf('const preSleepLine ='), bridge.indexOf('const lastMsg ='));
check(replyLine.length < 560 && replyLine.includes('purpose="reply"'), '首回复节奏压短但仍带 quietMs 机制');
check(preSleepLine.length < 520 && preSleepLine.includes('preSleepWaitSatisfied'), '潜水前等待压短但仍带判据');

// ── 第 6 项：看视频简报额度 + 附件缓存 ────────────────────────────────────
check(/Math\.min\(12000, 3000 \+ want \* 180\) : 2400/.test(mcp), '看视频简报默认 2400 字符');
check(/const promptFileCache = new Map\(\)/.test(mcp), '提示词附件有指纹缓存');
check(/again: z\.boolean\(\)\.optional\(\)/.test(mcp), 'stellar_prompt_file 有 again 逃生口');
check(/if \(!again && prev && stamp && prev\.stamp === stamp\)/.test(mcp), '文件没变只回一句「没变」');
check(/stat\.mtimeMs/.test(mcp), '指纹用 mtime+size（改写后立刻失效）');

// ── 第 7 项：全局每日唤醒上限 ─────────────────────────────────────────────
check(/globalMaxWakesPerDay: 25/.test(bridge), 'tokenGuard 默认全局上限 25');
check(/reason: 'global-wakes'/.test(bridge), '到顶返回 global-wakes 原因');
check(/if \(globalCap > 0 && !direct\)/.test(bridge), 'direct（被 @/叫到）不被上限拦');
check(/socialV2\.tokenGuard\.globalMaxWakesPerDay/.test(bridge), '拒绝文案里给出设置路径');

// config.example.json 也要有（用户照着改的地方）
const example = JSON.parse(read('config.example.json'));
check(example.socialV2?.tokenGuard?.globalMaxWakesPerDay === 25, 'config.example.json 里也写了 25');

// ── 反向守卫：别为了省钱把这些拆掉 ────────────────────────────────────────
check(/qzone public score/.test(feedSeg), '打分那一步还在（没有为了省 token 砍掉判断）');
check(/stellar_memory_zone/.test(feedSeg), '见闻区记忆还在');
check(/preSleepMs/.test(bridge) && /maxOutboundPerTurn/.test(bridge), '发送上限/等待时长没被顺手删掉');

console.log('\n省 token 四项：' + passed + ' 项全部通过。');
