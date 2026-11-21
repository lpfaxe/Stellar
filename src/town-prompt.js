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
      return '【小镇】你在鱼缸小镇里有自己的日子。想知道这三天在那儿做了什么、碰见了谁、对谁有印象，就调 stellar_town_recall 现查（只记得最近 3 天）；记不清就说记不清，别编。写日记/发空间提到小镇前先查一次。\n\n';
    }
  } catch {}
  return '';
}
