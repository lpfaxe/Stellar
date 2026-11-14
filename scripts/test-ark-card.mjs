// 回归（2026-11-11 主人要求）：别人通过 QQ 分享的 B站视频卡片，她得能看懂。
//
// 现象：好友用 B站「分享」按钮发来的小程序卡，在 bridge 的 segmentsToText 里
// 只变成字面量「[卡片消息]」—— 标题、简介、链接全丢，她既不知道分享了什么，
// 也没法顺着去看。而她又没有「点开卡片」这种能力（卡片要 QQ 客户端渲染）。
//
// 这条测试直接从 src/bridge.js 里把 parseArkCard/arkCardText 抠出来跑：
// 改的是真源码，不是复制品；不引入 import，vm 里不需要任何依赖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
const start = SRC.indexOf('function parseArkCard(raw) {');
const end = SRC.indexOf('async function segmentsToText(');
assert.ok(start > 0 && end > start, '在 bridge.js 里找不到 parseArkCard / segmentsToText 的边界');

// vm 里没有 URL 全局：trimShareUrl 用 new URL() 解析分享链接，缺了它就会走 catch，
// 把带埋点参数的长链接原样吐出来（第一版就是这样，测试看着像代码坏了）。
const sandbox = { URL };
vm.createContext(sandbox);
vm.runInContext(SRC.slice(start, end) + '\nthis.parseArkCard = parseArkCard; this.arkCardText = arkCardText;', sandbox);
const { parseArkCard, arkCardText } = sandbox;

const card = (detail) => JSON.stringify({ app: 'com.tencent.miniapp_01', meta: { detail_1: detail } });

test('好友分享的 B站卡片：标题与 BV 号都进文本（不再只是「[卡片消息]」）', () => {
  const text = arkCardText(parseArkCard(card({
    title: '哔哩哔哩',
    desc: '【官方 MV】Never Gonna Give You Up',
    qqdocurl: 'https://www.bilibili.com/video/BV1GJ411x7h7?share_source=qq',
  })));
  assert.match(text, /Never Gonna Give You Up/);
  assert.match(text, /BV1GJ411x7h7/);
  assert.doesNotMatch(text, /\[卡片消息\]/);
});

test('应用名不当标题重复（哔哩哔哩 + desc 时不念两遍）', () => {
  const text = arkCardText(parseArkCard(card({ title: '哔哩哔哩', desc: '真正标题' })));
  assert.equal(text.includes('哔哩哔哩 — 真正标题'), false);
  assert.match(text, /真正标题/);
});

test('只有短链时给链接（拿不到 BV 也不至于什么都没有）', () => {
  const text = arkCardText(parseArkCard(card({ title: '哔哩哔哩', desc: '某视频', url: 'm.q.qq.com/a/s/abc123' })));
  assert.match(text, /m\.q\.qq\.com/);
});

test('data 已经是对象（部分网关实现）也能解析', () => {
  const text = arkCardText(parseArkCard({ meta: { detail_1: { title: '标题X', desc: '简介Y', jumpUrl: 'https://b23.tv/zzz' } } }));
  assert.match(text, /标题X/);
  assert.match(text, /b23\.tv/);
});

test('真实卡片（测试员A 2026-11-11 分享的那条）能落到「标题 + 干净短链」', () => {
  const real = {
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序]我们做了个免费套件，来解决Fable 5.2办不了的事情……【B站AI创造公开赛】',
    meta: { detail_1: {
      appid: '1109937557',
      title: '哔哩哔哩',
      desc: '我们做了个免费套件，来解决Fable 5.2办不了的事情……【B站AI创造公开赛】',
      icon: 'http://miniapp.gtimg.cn/public/appicon/432b76be3a548fc128acaa6c1ec90131_200.jpg',
      preview: 'https://qq.ugcimg.cn/v1/qo9ne3ktljf7b1v0gds03l04k201lt6k76ujjhqcd7ocj340eim2qpnj5nojf5jp5ioknq08jvt0a37vm4tdnoovv66kctcv',
      url: 'm.q.qq.com/a/s/c096f8dbc2930e114753baab15a9cbcd',
      qqdocurl: 'https://b23.tv/s4GDIt2?share_medium=android&share_source=qq&bbid=XUC10A5CA3CD0997017AD794010071141817A&ts=1794408883114',
    } },
  };
  const text = arkCardText(parseArkCard(JSON.stringify(real)));
  assert.match(text, /免费套件/);
  // 埋点参数要剪掉：她拿着这个链接丢给 stellar_bili_watch 一样能跳
  assert.equal(text.includes('share_source=qq'), false);
  assert.equal(text.includes('bbid='), false);
  assert.match(text, /https:\/\/b23\.tv\/s4GDIt2/);
  assert.equal(text.includes('ugcimg.cn'), false);
});

test('不是 JSON 的垃圾串 → 退回「[卡片消息]」，不许抛', () => {
  assert.equal(arkCardText(parseArkCard('not json at all')), '[卡片消息]');
  assert.equal(arkCardText(parseArkCard('null')), '[卡片消息]');
});

test('卡片里的 token / icon 不进上下文（只留标题、简介、链接）', () => {
  const text = arkCardText(parseArkCard(card({
    title: '哔哩哔哩', desc: '视频', qqdocurl: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    icon: 'https://p.qpic.cn/very/long/icon/path.png?x=1&y=2', preview: 'pubminishare-30161.picgzc.qpic.cn/deadbeef',
  })));
  assert.equal(text.includes('p.qpic.cn'), false);
  assert.equal(text.includes('deadbeef'), false);
});
