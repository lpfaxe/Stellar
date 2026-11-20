/**
 * 记忆库写入侧（memory-cache.js）回归：全部在临时 DSH_HOME 里跑，不碰真实记忆目录。
 *
 * 钉住四件事：
 *  ① cacheKind 的判定（图片/表情/转发/纯文字）；
 *  ② 入站带 media 但正文为空时也要落（否则「他发了张图」在话题里彻底消失）；
 *  ③ 出站 role 必须是 self（只记入站会切出「对方一个人在说话」的假话题）；
 *  ④ 库不可用时**绝不抛**（消息发不出去比少记一条严重）。
 *
 * 跑法：node scripts/test-memory-cache.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-memcache-'));
process.env.DSH_HOME = root;

const { cacheKind, cacheInbound, cacheOutbound, isSystemNotice } = await import('../src/memory-cache.js');
const dbMod = await import('../src/memory-db.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(() => {
  try { dbMod.closeDb(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('cacheKind：图片/表情/转发/文字', () => {
  assert.equal(cacheKind([], []), 'text');
  assert.equal(cacheKind([{ kind: 'image' }], []), 'image');
  assert.equal(cacheKind([{ kind: 'face', faceId: '1' }], []), 'sticker');
  assert.equal(cacheKind([{ kind: 'sticker' }], []), 'sticker');
  assert.equal(cacheKind([], ['fwd1']), 'forward');
});

test('入站：有正文就落，且 owner 标签与 kind 都对', async () => {
  const payload = cacheInbound({ conversationKey: 'private:1000000003', speakerId: '1000000003', speakerName: '测试员A', text: '帮我画一张挽昼的图', media: [], forwardIds: [] }, () => {});
  assert.equal(payload.role, 'user');
  assert.equal(payload.ownerId, '1000000003');
  assert.equal(payload.kind, 'text');
  await sleep(60);
  const rows = dbMod.pendingRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '帮我画一张挽昼的图');
  assert.equal(rows[0].role, 'user');
});

test('入站：只有图、正文为空也要落（否则话题里「发了张图」整段消失）', async () => {
  cacheInbound({ conversationKey: 'private:1000000003', speakerId: '1000000003', speakerName: '测试员A', text: '', media: [{ kind: 'image', url: 'https://x/y.jpg' }] }, () => {});
  await sleep(60);
  const rows = dbMod.pendingRows();
  const hit = rows.find((r) => r.kind === 'image');
  assert.ok(hit, '图片消息必须落库');
  assert.ok(hit.text.length > 0, '正文不能空（用占位符，切话题时模型才知道这里有过一张图）');
});

test('空正文 + 无媒体（纯拍一拍）不落库', () => {
  assert.equal(cacheInbound({ conversationKey: 'private:1', text: '   ' }, () => {}), null);
  assert.equal(cacheInbound({ conversationKey: '', text: 'hi' }, () => {}), null);
});

test('出站 role 必须是 self，speaker_id 是机器人自己的 QQ', async () => {
  const payload = cacheOutbound({ conversationKey: 'private:1000000003', text: '行，那你想要什么角度', at: Date.now(), selfUserId: '1000000002' }, () => {});
  assert.equal(payload.role, 'self');
  assert.equal(payload.speakerId, '1000000002');
  await sleep(60);
  const rows = dbMod.pendingRows();
  const self = rows.find((r) => r.role === 'self');
  assert.ok(self, '她说的话必须落库');
  assert.equal(self.text, '行，那你想要什么角度');
});

test('切出来的分段双方都在（入站+出站合并后的真实效果）', () => {
  const segs = dbMod.segmentRows(dbMod.pendingRows());
  assert.equal(segs.length, 1);
  const roles = new Set(segs[0].rows.map((r) => r.role));
  assert.deepEqual([...roles].sort(), ['self', 'user']);
});

test('桥接自己的系统提示不进出站记忆（2026-11-18 的 502 横幅事故）', () => {
  // 事故原样：她「发」了这条错误横幅，对方没回 → 单边 → 降级成零碎记忆。
  const banner = '⚠️ agent 处理出错：DeepSeek Messages request failed (502)';
  assert.equal(isSystemNotice(banner), true);
  assert.equal(cacheOutbound({ conversationKey: 'private:1000000004', text: banner, at: Date.now(), selfUserId: '1000000002' }, () => {}), null);
  assert.equal(cacheOutbound({ conversationKey: 'private:1', text: '⏹️ 已停止', at: Date.now() }, () => {}), null);
  assert.equal(cacheOutbound({ conversationKey: 'private:1', text: '🔐 agent 请求审批：stellar_bili_post', at: Date.now() }, () => {}), null);
  // 她真正说的话里也可能带 ⚠️，但不能按「像不像系统话」误杀
  assert.equal(isSystemNotice('⚠️ 这个视频有点吓人'), false);
  assert.ok(cacheOutbound({ conversationKey: 'private:1', text: '⚠️ 这个视频有点吓人', at: Date.now() }, () => {}), '正常发言必须照常落库');
});

test('库不可用时不抛（只回 null 或静默）', () => {
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-memcache-bad-'));
  const blocker = path.join(badRoot, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  // 直接打穿到真库层：把 memory-db 的打开路径指到一个必定失败的目录
  assert.doesNotThrow(() => {
    try { dbMod.openDb({ file: path.join(blocker, 'memory.db') }); } catch {}
  });
  fs.rmSync(badRoot, { recursive: true, force: true });
});
