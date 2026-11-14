/**
 * 记忆库后台作业的定时器（插件侧）。
 *
 * 为什么放插件侧而不是桥接：
 *  · 桥接是消息链路，任何 setInterval 里的异常都可能拖慢收发；插件宿主本来就是「维护者」
 *    （记忆卡、向量记忆、角色存档都在这里定时）。
 *  · 复核与侧写要调模型，模型通道（ctx.get('llm')）只有插件宿主拿得到。
 *
 * 为什么内部用动态 import：
 *  插件是以 bundle 形式被 DSH 加载的，静态 import '../../../src/memory-worker.js' 会被
 *  打到 bundle 里；动态 import 让「没装 sqlite / 库坏了」只在真正跑作业时报错，
 *  而不是让整个插件加载失败（插件挂了 QQ 就不说话了）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.resolve(HERE, '..', '..', '..', 'src', 'memory-worker.js');
const TICK_MS = 10 * 60 * 1000;        // 10 分钟一次，与记忆卡同一个节奏
const FIRST_DELAY_MS = 30 * 1000;      // 启动 30 秒后先跑一次（避开启动风暴）
// 侧写时间与复核时间都从 config.json 的 memory 段读（这台机器 0 点后断电断网，
// 原本的 00:05 / 04:00 等于永远不跑；现在默认 06:30 复核、07:00 侧写）。
const PROFILE_HOUR = 7;                 // 侧写：本地 07:00 之后（可被 memory.profile.hour 覆盖）
const REQUEST_TTL_MS = 40 * 60 * 1000;  // 面板请求文件最多留 40 分钟（过期的当没发过）

let timer = null;
let initial = null;
let workerPromise = null;
let lastError = '';
let lastProfileDay = '';
let running = false;

function loadWorker() {
  if (!workerPromise) {
    workerPromise = import(workerPromiseUrl()).catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function workerPromiseUrl() {
  // Windows 路径要转 file:// URL；工作区路径里有中文（C:/Desktop/...），
  // 必须走 pathToFileURL 才会正确百分号编码。
  return pathToFileURL(WORKER_FILE).href;
}

/**
 * 开关：stellar/config.json 的 memory.worker（默认开）。false 时只停后台作业，
 * 不影响写入（写入由桥接侧 memory.cache 控制）——两个开关分别管「记」和「整理」。
 */
function workerEnabled(cfg) {
  const mem = cfg && cfg.memory;
  return !(mem && mem.worker === false);
}

function hourOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : fallback;
}

function minuteOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 59 ? Math.floor(n) : fallback;
}

/** 复核窗口与侧写时间：以 config.json 的 memory.window / memory.profile 为准。 */
export function scheduleOf(cfg) {
  const mem = (cfg && cfg.memory) || {};
  const win = mem.window || {};
  const prof = mem.profile || {};
  return {
    window: { hour: hourOf(win.hour, 6), minute: minuteOf(win.minute, 30), days: Number(win.days) || 2 },
    profile: { hour: hourOf(prof.hour, PROFILE_HOUR), minute: minuteOf(prof.minute, 0) },
  };
}

function modelEnabled(cfg) {
  const mem = cfg && cfg.memory;
  return !(mem && mem.model === false);
}

/** 面板「立即复核 / 生成侧写」写的请求文件：路径与 worker 的 state 目录同一处。 */
function stateDir() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  return path.join(home, 'stellar', 'state');
}

function requestFile(name) {
  return path.join(stateDir(), name);
}

function takeRequest(name) {
  const file = requestFile(name);
  try {
    if (!fs.existsSync(file)) return false;
    const st = fs.statSync(file);
    fs.rmSync(file, { force: true });
    return Date.now() - Number(st.mtimeMs || 0) < REQUEST_TTL_MS;
  } catch {
    return false;
  }
}

async function tick(log, cfg, asker) {
  if (!workerEnabled(cfg)) return;
  if (running) return;   // 上一轮还在等模型（复核可能要几十秒），别叠上去
  running = true;
  try {
    const worker = await loadWorker();
    const useModel = Boolean(asker && asker.available && asker.available()) && modelEnabled(cfg);
    const wantReview = takeRequest('memory-review-request.json');
    const wantProfile = takeRequest('memory-profile-request.json');
    const sched = scheduleOf(cfg);
    const res = await worker.runTick({
      log,
      ask: useModel ? asker.ask : null,
      force: wantReview || undefined,
      window: sched.window,
    });
    const topics = res?.split?.topics?.length || 0;
    const held = res?.split?.held || 0;
    const frags = res?.split?.fragments || 0;
    if (topics || held || frags) {
      log('[memory] 切分：话题 ' + topics + ' / 挂起 ' + held + ' / 零碎 ' + frags);
    }
    const errs = res?.split?.errors || [];
    if (errs.length) log('[memory] 切分告警：' + errs.slice(0, 2).join(' | '));
    const review = res?.review;
    if (review && review.skipped && review.skipped !== 'done-today' && review.skipped !== 'too-early') {
      // 只报真正值得看的跳过原因（每天只该有一条）
      if (review.skipped === 'model-unavailable' || review.skipped === 'no-target') log('[memory] 复核未跑：' + review.skipped);
    }
    if (review && review.ok === false && review.error) log('[memory] 复核失败：' + String(review.error).slice(0, 160));

    // 侧写：每天 memory.profile.hour（默认 07:00）之后一次（或用面板请求强制一次）
    const nowDate = new Date();
    const hour = nowDate.getHours();
    const minute = nowDate.getMinutes();
    const day = nowDate.toDateString();
    const profileDue = hour > sched.profile.hour || (hour === sched.profile.hour && minute >= sched.profile.minute);
    if (useModel && (wantProfile || (profileDue && lastProfileDay !== day))) {
      const prof = await worker.runProfiles({ log, ask: asker.ask });
      if (prof && prof.written) lastProfileDay = day;
      else if (prof && prof.ok === false && prof.skipped !== 'model-unavailable') log('[memory] 侧写未跑：' + (prof.skipped || 'unknown'));
    }
    if (lastError) lastError = '';
  } catch (error) {
    const message = error?.message ?? String(error);
    // 同一个错误只报一次，避免每 10 分钟刷一行日志
    if (message !== lastError) {
      lastError = message;
      log('[memory] 后台作业失败：' + message);
    }
  } finally {
    running = false;
  }
}

/**
 * 启动定时器。readConfig 每次 tick 重新读配置（面板改开关不用重启）。
 * asker: { ask(args), available() } —— 由 memory-llm.js 提供；没有就先只做切分与清理。
 * 返回 { stop() }。
 */
export function startMemoryDbTimer({ log = () => {}, readConfig = null, asker = null } = {}) {
  stopMemoryDbTimer();
  const cfgReader = typeof readConfig === 'function' ? readConfig : () => ({});
  const run = () => {
    let cfg = {};
    try { cfg = cfgReader() || {}; } catch {}
    tick(log, cfg, asker).catch(() => {});
  };
  initial = setTimeout(run, FIRST_DELAY_MS);
  initial.unref?.();
  timer = setInterval(run, TICK_MS);
  timer.unref?.();
  const model = Boolean(asker && asker.available && asker.available());
  log('[memory] 记忆库后台作业已排程（每 10 分钟；切分 + 每日 06:30 复核 + 07:00 侧写'
    + (model ? '，模型通道就绪' : '，模型通道未就绪：只切分不复核') + '）');
  return {
    stop() { stopMemoryDbTimer(); },
  };
}

export function stopMemoryDbTimer() {
  if (initial) { clearTimeout(initial); initial = null; }
  if (timer) { clearInterval(timer); timer = null; }
}
