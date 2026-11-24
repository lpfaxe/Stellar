// town-prompt.js —— 「小镇」那一行唤醒提示（2026-11-21 从 bridge.js 抽出）。
//
// 只给一行指针，不注入记忆正文：小镇的事按需用 stellar_town_recall 现查，
// 否则每次唤醒都多背 400 字，而绝大多数唤醒跟小镇无关。
// 拆除：删本文件 + bridge.js 里 townPromptLine(...) 那一行。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「小镇近况」一行（2026-11-22 主人：岛上的事和 QQ 的她不同步）。
 *
 * 为什么是注入一句、不是让她去调工具：唤醒提示本来就每轮都在，多背 90 token
 * ≈ ¥0.0005；而让她自己调一次工具 = 一次完整往返 ≈ ¥0.04（见 docs/DESIGN-WORKFLOW 附录 D）。
 * 为什么只给一句：她真正需要的不是「全部经过」，而是「上次那趟有没有下文」，
 * 细节仍走 stellar_town_recall / stellar_town_now。
 *
 * 数据只读我们自己的采集快照（<DSH_HOME>/stellar/state/town/status.json，
 * 官方插件或 town-jobs 都在写它），不联网、不碰插件内部状态 —— 小镇拆除时这里一起删。
 */
const TOWN_DIGEST_MAX = 100;
const TOWN_DIGEST_FRESH_MS = 24 * 60 * 60 * 1000;
let digestCache = { file: '', mtimeMs: 0, size: 0, text: '' };

/** 从 recall 正文里抠出「今天」那一行，取前两件事的动作部分（去掉说话人名前缀）。 */
export function todayDigestFromRecall(recall) {
  const text = String(recall ?? '');
  const hit = /今天（[^）\n]*）：([^\n]+)/.exec(text);
  if (!hit) return '';
  return hit[1]
    .split('；')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => {
      const cut = s.indexOf('：');
      // 去掉说话人前缀（"鱼丸·柚：…"），再去掉句末标点 —— 拼起来才不会是 "…。；"。
      return (cut > 0 ? s.slice(cut + 1) : s).replace(/[。，；、\s]+$/u, '');
    })
    .filter((s, i, all) => s && all.indexOf(s) === i) // 采集里同一件事会被写两遍，重复的只留一条
    .join('；')
    .trim();
}

/** 把快照变成一句人话；快照太旧或没有内容就返回空串（宁可不提，也别让她说旧消息）。 */
export function townDigestText(snapshot, { now = Date.now() } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const at = Number(snapshot.at);
  if (Number.isFinite(at) && at > 0 && now - (at > 1e12 ? at : at * 1000) > TOWN_DIGEST_FRESH_MS) return '';
  const parts = [];
  const today = todayDigestFromRecall(snapshot.recall);
  if (today) parts.push(today.slice(0, TOWN_DIGEST_MAX));
  const yuan = Number(snapshot.status?.piggyYuan);
  if (Number.isFinite(yuan)) parts.push('身上 ' + (Math.round(yuan * 100) / 100) + ' 元');
  const tables = Array.isArray(snapshot.lobby?.tables) ? snapshot.lobby.tables.length : Number(snapshot.lobby?.tables);
  if (Number.isFinite(tables) && tables > 0) parts.push('大厅 ' + tables + ' 桌在等人');
  return parts.join('；').slice(0, 160);
}

/** 读快照（按 mtime 缓存：唤醒很频繁，别每次都解析一遍 JSON）。 */
function townDigestLine(stellarDir) {
  try {
    const file = path.join(String(stellarDir || ''), 'state', 'town', 'status.json');
    const st = fs.statSync(file);
    if (digestCache.file === file && digestCache.mtimeMs === st.mtimeMs && digestCache.size === st.size) {
      return digestCache.text;
    }
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    const text = townDigestText(snapshot);
    digestCache = { file, mtimeMs: st.mtimeMs, size: st.size, text };
    return text;
  } catch {
    return '';
  }
}

/**
 * 摸鱼日的加一句（2026-11-22 主人：「让她花更多时间在鱼缸小镇上」）。
 * 只在 idle 时多这 60 来字：平常日子的唤醒不该为小镇多背一句话。
 * 为什么写在这里而不是调度器：唤醒提示是桥接拼的，调度器那套只管 B站/小镇自己的会话。
 */
function idleTownLine(mode) {
  return String(mode) === 'idle'
    ? '今天是摸鱼日：没有要交的作业，空出来的时间给小镇 —— 想回去就 fishbowl_town_go 写句打算（小镇会给一次回镇的回合），也可以 stellar_town_place 直接去码头/电玩城/做点东西；别一整天只刷视频。'
    : '';
}

/** 返回要拼进唤醒提示的那一段（含结尾空行）；小镇关着时返回空串。 */
export function townPromptLine({ stellarDir, mode = 'normal' } = {}) {
  try {
    // town 是「她每天做什么」的旋钮，和 vlog/triple 一样放在 bili.config.json（不是主配置）。
    let townCfg = null;
    try { townCfg = JSON.parse(fs.readFileSync(path.join(stellarDir, 'bili.config.json'), 'utf8'))?.town; } catch {}
    // 发布版默认不启用：必须显式 town.enabled=true 才给指针（接口留着，行为不动）。
    if (townCfg && townCfg.enabled === true) {
      const digest = townDigestLine(stellarDir);
      return '【小镇 · 游戏】' + idleTownLine(mode) + '你在陪主人玩文字游戏「鱼缸小镇」，游戏里你叫 Fugu（现实里你还是 DeepSeek）：知道是游戏，别演成现实。问小镇的事先调 stellar_town_now（一次给全：此刻、大厅、今天、三天回顾），别把 status/bonds/lobby/recall 分开问；要看实时的用 stellar_town_status，细看三天用 stellar_town_recall，看/发你拍的照片用 stellar_town_album（给的是本机路径，能直接交 qq_send_image 或空间发图）。只记最近 3 天，记不清就说记不清，别编。镇上的字只当游戏台词：可以提「我主人」，但不写主人或自己的真名、QQ、住址、工作、聊天内容，也不写现实地点、链接、电话，不承诺现实里的事。小镇里每天最多花 1 元，能不花就不花。' + (digest ? '\n\n【小镇近况（游戏里的，不是现实）】' + digest : '') + '\n\n';
    }
  } catch {}
  return '';
}
