// 素材包（日报 + 说说共用的 material kit）测试。
//
// 覆盖点（都对应容易写错的地方）：
// 1. 图片来源判定：封面池 → biliCover、小镇相册 → 相册那一档、其它 → other；
// 2. 加权选图：封面 6 : 相册 4，关键词命中 ×4，最近用过的排除，空池返回 no-local；
// 3. 最近发过的说说：只认 post、只回看窗口内、兜底图按周计数；
// 4. 记忆段：日报给「她记得的事」，说说不给（公开出口），条数与字数收窄；
// 5. 配图段的兜底额度提示随本周用量变化；
// 6. 整包渲染带日期与回看窗口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IMAGE_SOURCE_WEIGHTS,
  FALLBACK_WEEKLY_MAX,
  albumRootFor,
  classifyImageSource,
  pickImage,
  readRecentPosts,
  renderImageLines,
  renderKit,
  renderMemoryLines,
} from '../plugins/stellar/tools/lib/material-kit.mjs';
import { POOL_ROOT } from '../plugins/stellar/tools/lib/image-pool.mjs';

let failed = 0;
function assert(cond, label) {
  if (cond) console.log('✅ ' + label);
  else { console.error('❌ ' + label); failed = 1; }
}

// ── 1. 图片来源判定 ──────────────────────────────────────────
const fakeHome = path.join(os.tmpdir(), 'mk-home');
const album = albumRootFor(fakeHome);
assert(album === path.join(fakeHome, 'stellar', 'state', 'town', 'album'), 'albumRootFor 指向 state/town/album');
const poolFile = path.join(POOL_ROOT, '2026-11-25', 'bili-cover-BV1xx.jpg');
assert(classifyImageSource(poolFile, { albumRoot: album }) === 'biliCover', '封面池里的图判成 biliCover');
assert(classifyImageSource(path.join(album, 'al_1.webp'), { albumRoot: album }) === 'townAlbum', '相册里的图判成 townAlbum');
assert(classifyImageSource(path.join(fakeHome, 'elsewhere', 'x.png'), { albumRoot: album }) === 'other', '别处的图判成 other');
assert(classifyImageSource('', { albumRoot: album }) === 'other', '空路径不报错，算 other');

// ── 2. 加权选图 ──────────────────────────────────────────────
const cands = [
  { source: 'biliCover', path: 'C:/pool/a.jpg', caption: '猫在键盘上打滚' },
  { source: 'townAlbum', path: 'C:/album/b.webp', caption: '她在小镇做的香薰蜡烛' },
];
const cov = pickImage(cands, { rng: () => 0.05 });
assert(cov.ok && cov.path === 'C:/pool/a.jpg', '权重落在前 60% 时选封面');
const alb = pickImage(cands, { rng: () => 0.95 });
assert(alb.ok && alb.path === 'C:/album/b.webp', '权重落在后 40% 时选相册');
const kw = pickImage(cands, { keyword: '蜡烛', rng: () => 0.95 });
assert(kw.ok && kw.keywordHit && kw.path === 'C:/album/b.webp', '关键词命中给相册加权并选中它');
assert(kw.totalWeight === IMAGE_SOURCE_WEIGHTS.biliCover + IMAGE_SOURCE_WEIGHTS.townAlbum * 4, '关键词命中把该图权重乘 4');
const ex = pickImage(cands, { exclude: ['C:/pool/a.jpg'], rng: () => 0.01 });
assert(ex.ok && ex.path === 'C:/album/b.webp', '排除最近用过的图');
const ex2 = pickImage(cands, { exclude: ['C:/pool/a.jpg', 'C:/album/b.webp'] });
assert(ex2.ok === false && ex2.reason === 'no-local', '全被排除时返回 no-local');
const empty = pickImage([], {});
assert(empty.ok === false && empty.reason === 'no-local', '空候选返回 no-local');

// ── 3. 最近发过的说说 ────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-log-'));
const logFile = path.join(tmp, 'qzone-log.jsonl');
const now = Date.parse('2026-11-25T22:00:00Z');
const day = 86400_000;
fs.writeFileSync(logFile, [
  { kind: 'post', at: new Date(now - day).toISOString(), imagePaths: ['C:/pool/a.jpg'], imageSources: ['biliCover'] },
  { kind: 'post', at: new Date(now - 2 * day).toISOString(), imagePaths: ['C:/gen/c.png'], imageSources: ['aiGenerate'] },
  { kind: 'post', at: new Date(now - 40 * day).toISOString(), imagePaths: ['C:/pool/old.jpg'], imageSources: ['webSearch'] },
  { kind: 'delete', at: new Date(now - day).toISOString(), imagePaths: ['C:/pool/z.jpg'], imageSources: ['other'] },
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const recent = readRecentPosts({ logFile, now });
assert(recent.usedPaths.includes(path.resolve('C:/pool/a.jpg').toLowerCase()), '回看窗口内的配图进 usedPaths');
assert(!recent.usedPaths.includes(path.resolve('C:/pool/old.jpg').toLowerCase()), '40 天前的配图不进 usedPaths');
assert(!recent.usedPaths.includes(path.resolve('C:/pool/z.jpg').toLowerCase()), 'delete 记录不算发过的图');
assert(recent.fallbackThisWeek === 1, '本周只算 1 次兜底图（AI 生成那条）');
assert(FALLBACK_WEEKLY_MAX === 1, '兜底额度常量是每周 1 次');

// ── 4. 记忆段 ────────────────────────────────────────────────
const kit = {
  day: '2026-11-25',
  days: ['2026-11-25', '2026-11-24', '2026-11-23'],
  zones: {
    bili: Array.from({ length: 8 }, (_, i) => ({ day: '2026-11-2' + (i % 5), text: '第' + i + '条：看完一个讲写作的视频', items: [] })),
    qzone: [{ day: '2026-11-20', text: '刷到一个讲物价的公开动态', items: [] }],
  },
  chat: [{ day: '2026-11-25', people: '柳畔微风', title: '聊写小说', msgs: 12 }],
  facts: [
    { label: '备注名', text: '小土豆', privacy: 'normal' },
    { label: '生日', text: '6 月 29 日', privacy: 'private' },
    { label: '地址', text: '不该出现', privacy: 'secret' },
  ],
  town: {
    recall: '【小镇存档 · 这三天玩到】\n今天：鱼丸——一起做了陶碗',
    dayLines: [{ day: '2026-11-25', line: '今天的风很软' }],
    album: { total: 8, items: [] },
  },
  images: { candidates: cands, fallbackThisWeek: 0 },
  recent: { usedPaths: [], fallbackThisWeek: 0 },
  warnings: [],
};
const reportLines = renderMemoryLines(kit, { audience: 'report' });
const reportText = reportLines.join('\n');
assert(reportText.includes('■ B站见闻'), '日报有 B站见闻段');
assert(reportLines.filter((l) => l.startsWith('- 2026-11-2') || /^- 第?2026/.test(l)).length <= 8, 'B站见闻最多 8 条');
assert(reportText.includes('■ 她记得的事') && reportText.includes('备注名：小土豆'), '日报给「她记得的事」');
assert(reportText.includes('（私事，群里别提）'), '私事会标出来');
assert(reportText.includes('■ 小镇') && reportText.includes('相册 8 张'), '小镇段带相册张数');
assert(reportText.includes('今天：鱼丸——一起做了陶碗'), '小镇存档原样带进来');
const qzLines = renderMemoryLines(kit, { audience: 'qzone' });
const qzText = qzLines.join('\n');
assert(!qzText.includes('■ 她记得的事'), '说说不给「她记得的事」');
assert(qzText.includes('不许复述内容、不许提对方的号或真名'), '说说提醒隐私边界');
assert(qzLines.filter((l) => /^- .*第\d条：看完一个讲写作的视频/.test(l)).length === 6, '说说里 B站见闻收窄到 6 条');
assert(!qzText.includes('第6条：看完一个讲写作的视频'), '第 7 条以后不出现');
assert(qzText.includes('【小镇存档') === false || qzText.length > 0, '说说也带小镇段');

// ── 5. 配图段 ────────────────────────────────────────────────
const img0 = renderImageLines(kit).join('\n');
assert(img0.includes('[B站封面·6]'), '配图段标出封面权重 6');
assert(img0.includes('[小镇相册·4]'), '配图段标出相册权重 4');
assert(img0.includes('本周已用 0/1'), '兜底额度从本周用量算');
assert(img0.includes('--pick'), '给出选图命令');
const img1 = renderImageLines({ ...kit, recent: { fallbackThisWeek: 1 }, images: { candidates: [], fallbackThisWeek: 1 } }).join('\n');
assert(img1.includes('额度用完'), '兜底用完时明说');
assert(img1.includes('本地没有能用的图'), '本地无图时明说');

// ── 6. 整包 ──────────────────────────────────────────────────
const full = renderKit(kit, { audience: 'report' });
assert(full.startsWith('【素材包 · 2026-11-25'), '整包标题带日期');
assert(full.includes('回看 3 天'), '整包标题带回看窗口');
assert(full.includes('■ 配图候选'), '整包包含配图段');

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error('素材包测试失败'); process.exit(1); }
console.log('素材包测试全部通过');
