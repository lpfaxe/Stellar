#!/usr/bin/env node
// test-idle-mode.mjs —— 摸鱼模式（idle）的数值不变量（2026-11-22）。
//
// 背景：主人那天说「刷好友爱看与 B站视频数量恢复为平常状态，让她花更多时间在鱼缸小镇上」。
// 这条测试钉三件事：
//   1) modeLimits('idle') 不再抬视频/好友爱看（只留醒来次数与间隔）；
//   2) config() 的模式叠加**只覆盖有值的键** —— 写成 {videoTargetPerDay: undefined}
//      会把用户配置里的值抹掉（PITFALLS #314）；
//   3) 摸鱼日的小镇次数 ≥ 4、唤醒提示多一句「时间给小镇」，平常日没有这句。
// 真跑配置读取用的是沙箱 DSH_HOME（不碰真实的 bili.config.json / run-mode.json）。
// 发布版差异：小镇默认关（必须显式打开才给提示），所以第 4 段自己造两个临时目录，
// 一个开着、一个关着，不依赖仓库根有没有 bili.config.json。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Windows 上 import() 只认 file:// URL：直接给 'D:\…' 会 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const load = (p) => import(pathToFileURL(p).href);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('✅ ' + label); }
  else { failed += 1; console.error('❌ ' + label); }
}

const root = path.join(import.meta.dirname, '..');

// ── 1. 纯函数：modeLimits ────────────────────────────────────────────────
const rm = await load(path.join(root, 'plugins', 'stellar', 'lib', 'run-mode.js'));
const idle = rm.modeLimits('idle');
ok(!('videoTargetPerDay' in idle), 'idle 不再抬 B站视频目标');
ok(!('qzonePublicSeen' in idle), 'idle 不再抬好友爱看条数');
ok(idle.maxWakesPerDay > 0 && idle.minGapMin > 0, 'idle 仍保留「醒得更勤、间隔更短」');
ok(Object.keys(rm.modeLimits('normal')).length === 0, 'normal 没有任何覆盖');
ok(Object.keys(rm.modeLimits('minimal')).length === 0, 'minimal 没有任何覆盖');
ok(Object.values(idle).every((v) => v != null), 'idle 的覆盖里没有 undefined（会被 merge 抹掉配置）');
ok(rm.modeAllows('idle', 'town') === true, 'idle 放行 town');
ok(rm.modeAllows('minimal', 'town') === false, 'minimal 不放行 town');

// ── 2. 真读配置：沙箱 DSH_HOME ───────────────────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-idle-'));
const stateDir = path.join(sandbox, 'stellar', 'state');
const cfgFile = path.join(sandbox, 'stellar', 'bili.config.json');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(cfgFile, JSON.stringify({
  night: { videoTargetPerDay: 37, maxWakesPerDay: 6, minGapMin: 30 },
  qzone: { public: { seenTarget: 9 } },
}, null, 2), 'utf8');
process.env.DSH_HOME = sandbox;
process.env.STELLAR_BILI_CONFIG = cfgFile;

const day = rm.localDay(Date.now());
const writeMode = (mode) => fs.writeFileSync(path.join(stateDir, 'run-mode.json'), JSON.stringify({ version: 1, mode, day }), 'utf8');
const { config } = await load(path.join(root, 'plugins', 'stellar', 'tools', 'lib', 'config.mjs'));

writeMode('idle');
let cfg = config();
ok(cfg.__runMode === 'idle', '沙箱切到 idle 后 config() 认这个模式');
ok(cfg.night.videoTargetPerDay === 37, 'idle 下视频目标仍是配置里的 37（不再被抬成 60）');
ok(cfg.qzone.public.seenTarget === 9, 'idle 下好友爱看仍是配置里的 9（不再被抬成 20）');
ok(cfg.night.maxWakesPerDay === idle.maxWakesPerDay, 'idle 下醒来次数用模式覆盖值');
ok(cfg.night.minGapMin === idle.minGapMin, 'idle 下最小间隔用模式覆盖值');

writeMode('normal');
cfg = config();
ok(cfg.__runMode === 'normal', '沙箱切回 normal');
ok(cfg.night.maxWakesPerDay === 6 && cfg.night.minGapMin === 30, 'normal 下醒来次数/间隔来自配置');
ok(cfg.night.videoTargetPerDay === 37 && cfg.qzone.public.seenTarget === 9, 'normal 下同为配置值');

// ── 3. 静态契约：叠加写法 + 小镇次数 ─────────────────────────────────────
const cfgSrc = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'tools', 'lib', 'config.mjs'), 'utf8');
ok(cfgSrc.includes('if (lim.videoTargetPerDay != null)'), '叠加前先判「有没有值」');
// 只看代码行：注释里专门留了「别这么写」的反例（含同样的字面量）。
const cfgCode = cfgSrc.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
ok(!/videoTargetPerDay: lim\.videoTargetPerDay/.test(cfgCode), '没有把 lim 的键无条件拼进叠加对象');
ok(!/qzonePublicSeen: lim\.qzonePublicSeen/.test(cfgCode), '好友爱看同理（有值才覆盖）');

const townJobs = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'lib', 'town-jobs.js'), 'utf8');
ok(/const IDLE_TOWN_WAKES = 4/.test(townJobs), '摸鱼日小镇至少 4 次（常量）');
ok(/runModeNow\(\) === 'idle' \? Math\.max\(want, IDLE_TOWN_WAKES\) : want/.test(townJobs), 'townPlanDay 在 idle 下取 max(配置, 4)');
ok(!/runModeNow\(\) === 'idle' \? 1 : want/.test(townJobs), '不再把 idle 压到 1 次');

// ── 4. 唤醒提示：摸鱼日多一句 ────────────────────────────────────────────
const tp = await load(path.join(root, 'src', 'town-prompt.js'));
const onDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-idle-on-'));
fs.writeFileSync(path.join(onDir, 'bili.config.json'), JSON.stringify({ town: { enabled: true } }), 'utf8');
const idleLine = tp.townPromptLine({ stellarDir: onDir, mode: 'idle' });
const normalLine = tp.townPromptLine({ stellarDir: onDir, mode: 'normal' });
ok(idleLine.includes('摸鱼日'), 'idle 的唤醒提示带「摸鱼日」');
ok(!normalLine.includes('摸鱼日'), 'normal 的唤醒提示不带这句');
ok(idleLine.length > normalLine.length && idleLine.length - normalLine.length < 200, '只多一句（差值 < 200 字）');
const offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-idle-off-'));
fs.writeFileSync(path.join(offDir, 'bili.config.json'), JSON.stringify({ town: { enabled: false } }), 'utf8');
ok(tp.townPromptLine({ stellarDir: offDir, mode: 'idle' }) === '', '小镇关着时一行都不注入');

fs.rmSync(sandbox, { recursive: true, force: true });
fs.rmSync(onDir, { recursive: true, force: true });
fs.rmSync(offDir, { recursive: true, force: true });

console.log((failed === 0 ? '✅' : '❌') + ' idle-mode: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);