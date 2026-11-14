/**
 * 表情包标签体系（P2）：emotion / scene / text / source / license / usageCount。
 * 纯本地启发式：从已有 desc/content/keywords 推断，不调用模型、不产生费用。
 * 只补缺失字段，已有的 emotion/标签不动（人工标注优先）。
 */
export const STICKER_SCENES = ['打招呼', '开心', '难过', '吐槽', '撒娇', '惊讶', '害羞', '无语', '生气', '日常'];

const EMOTION_SCENE = {
  funny: '吐槽', cute: '撒娇', happy: '开心', smile: '开心', joy: '开心',
  sad: '难过', cry: '难过', angry: '生气', mad: '生气', shy: '害羞',
  surprise: '惊讶', shock: '惊讶', confused: '无语', awkward: '无语',
  greeting: '打招呼', hello: '打招呼', love: '撒娇', sleepy: '日常', tired: '日常',
};

const TEXT_RULES = [
  [/^(在吗|在不在|早|早上好|晚安|你好|嗨|hi)/i, '打招呼'],
  [/(哈|笑|乐|233|草)/, '开心'],
  [/(哭|难过|委屈|伤心|泪)/, '难过'],
  [/(无语|服了|离谱|就这|算了)/, '吐槽'],
  [/(贴贴|抱抱|喜欢|爱你|可爱|乖)/, '撒娇'],
  [/(惊|啊这|居然|竟然|真的假的)/, '惊讶'],
  [/(害羞|脸红|别夸)/, '害羞'],
  [/(生气|哼|不理|讨厌)/, '生气'],
];

function pickScene(entry) {
  const emotion = String(entry.emotion || '').toLowerCase();
  if (EMOTION_SCENE[emotion]) return EMOTION_SCENE[emotion];
  const text = [entry.desc, entry.content, entry.localNote, ...(Array.isArray(entry.keywords) ? entry.keywords : [])]
    .filter(Boolean).join(' ');
  for (const [re, scene] of TEXT_RULES) if (re.test(text)) return scene;
  return '日常';
}

function pickText(entry) {
  const key = Array.isArray(entry.keywords) && entry.keywords.length ? String(entry.keywords[0]) : '';
  const note = String(entry.localNote || '').trim();
  const desc = String(entry.desc || '').trim();
  return String(entry.text || key || note || desc || '').slice(0, 40);
}

/** 补全一条表情的标签字段；返回是否改动过。 */
export function normalizeStickerTags(entry) {
  if (!entry || typeof entry !== 'object') return false;
  let changed = false;
  if (!entry.emotion) { entry.emotion = 'funny'; changed = true; }
  const scene = entry.scene || pickScene(entry);
  if (entry.scene !== scene) { entry.scene = scene; changed = true; }
  const text = entry.text || pickText(entry);
  if (entry.text !== text) { entry.text = text; changed = true; }
  const tags = Array.isArray(entry.tags) ? entry.tags.slice() : [];
  for (const tag of [entry.emotion, scene]) {
    if (tag && !tags.includes(tag)) { tags.push(tag); changed = true; }
  }
  if (tags.length > 12) tags.length = 12;
  if (JSON.stringify(entry.tags) !== JSON.stringify(tags)) { entry.tags = tags; changed = true; }
  const source = entry.source || (entry.url ? 'qq' : 'local');
  if (entry.source !== source) { entry.source = source; changed = true; }
  if (!entry.license) { entry.license = 'unknown'; changed = true; }
  const usageCount = Number(entry.usageCount ?? entry.useCount) || 0;
  if (entry.usageCount !== usageCount) { entry.usageCount = usageCount; changed = true; }
  return changed;
}

/** 按 md5 去重：保留 useCount 高的那条，其余的 usageCount 累加过去。 */
export function dedupeStickers(list) {
  const out = [];
  const byKey = new Map();
  let removed = 0;
  for (const entry of Array.isArray(list) ? list : []) {
    const key = String(entry?.md5 || entry?.resId || entry?.id || '').trim();
    if (!key) { out.push(entry); continue; }
    const found = byKey.get(key);
    if (!found) { byKey.set(key, entry); out.push(entry); continue; }
    removed += 1;
    const keep = (Number(found.useCount) || 0) >= (Number(entry.useCount) || 0) ? found : entry;
    const drop = keep === found ? entry : found;
    keep.usageCount = (Number(keep.usageCount) || 0) + (Number(drop.usageCount ?? drop.useCount) || 0);
    keep.useCount = Math.max(Number(keep.useCount) || 0, Number(drop.useCount) || 0);
    if (keep !== found) {
      const idx = out.indexOf(found);
      if (idx >= 0) out[idx] = keep;
      byKey.set(key, keep);
    }
  }
  return { list: out, removed };
}

export function applyStickerTags(list) {
  const { list: deduped, removed } = dedupeStickers(list);
  let changed = 0;
  for (const entry of deduped) if (normalizeStickerTags(entry)) changed += 1;
  return { list: deduped, removed, changed };
}
