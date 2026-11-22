// town-prompt.js —— 「小镇」那一行唤醒提示（2026-11-21 从 bridge.js 抽出）。
//
// 只给一行指针，不注入记忆正文：小镇的事按需用 stellar_town_recall 现查，
// 否则每次唤醒都多背 400 字，而绝大多数唤醒跟小镇无关。
// 拆除：删本文件 + bridge.js 里 townPromptLine(...) 那一行。
import fs from 'node:fs';
import path from 'node:path';

/** 返回要拼进唤醒提示的那一段（含结尾空行）；小镇关着时返回空串。 */
export function townPromptLine({ stellarDir } = {}) {
  try {
    // town 是「她每天做什么」的旋钮，和 vlog/triple 一样放在 bili.config.json（不是主配置）。
    let townCfg = null;
    try { townCfg = JSON.parse(fs.readFileSync(path.join(stellarDir, 'bili.config.json'), 'utf8'))?.town; } catch {}
    // 发布版默认不启用：必须显式 town.enabled=true 才给指针（接口留着，行为不动）。
    if (townCfg && townCfg.enabled === true) {
      return '【小镇 · 游戏】你在陪主人玩文字游戏「鱼缸小镇」，游戏里你叫 Fugu（现实里你还是 DeepSeek）：知道是游戏，别演成现实。问小镇的事先调 stellar_town_now（一次给全：此刻、大厅、今天、三天回顾），别把 status/bonds/lobby/recall 分开问；要看实时的用 stellar_town_status，细看三天用 stellar_town_recall，看/发你拍的照片用 stellar_town_album（给的是本机路径，能直接交 qq_send_image 或空间发图）。只记最近 3 天，记不清就说记不清，别编。镇上的字只当游戏台词：可以提「我主人」，但不写主人或自己的真名、QQ、住址、工作、聊天内容，也不写现实地点、链接、电话，不承诺现实里的事。小镇里每天最多花 1 元，能不花就不花。\n\n';
    }
  } catch {}
  return '';
}
