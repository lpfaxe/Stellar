#!/usr/bin/env node
// test-qq-card.mjs —— QQ 卡片（json / xml 段）解析与渲染的回归测试（2026-11-24）。
//
// 背景：主人转发的 QQ 空间卡片，她只看到「[卡片消息]」——合并转发那条路把 json 段拍平了，
// 而桥接的 parseArkCard 只认小程序卡（meta.detail_1），Qzone 卡的正文在 meta.news 上。
//
// 全是离线的：import src/qq-card.js 的纯函数 + src/forward.js 的格式化器，不联网、不碰真状态。
// 覆盖：真实 Qzone 卡形状、B站小程序卡、XML 卡、裸链接、mqqapi base64 解码、
//       feed 渲染（正文/图/评论/链接）、token 绝不进文本、两条接线（forward.js / bridge.js）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const q = await import(pathToFileURL(path.join(root, 'src', 'qq-card.js')).href)
const fw = await import(pathToFileURL(path.join(root, 'src', 'forward.js')).href)

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fail += 1
  console.error('  ✗ ' + label)
}

// 真实卡片（2026-11-08 主人转发的那条，取自 SnowLuma messages.db，token 换成假值）
const SCHEMA = 'bXF6b25lOi8vYXJvdXNlL2RldGFpbD9hcHBpZD0zMTEmYmFubmVyX3R5cGU9MCZjZWxsaWQ9ZGIwYzUwYjRjMDA2ZjA2YWVjN2MwMTAwJmZlZWRfYWN0aW9uX2RvbWFpbl90eXBlPTEmb2xkbGluaz1odHRwcyUzQSUyRiUyRm1vYmlsZS5xem9uZS5xcS5jb20lMkZsJTNGYSUzRDMxMSUyNmklM0RkYjBjNTBiNGMwMDZmMDZhZWM3YzAxMDAlMjZ1JTNEMzAyNTE0NTA1MQ=='
const FAKE_TOKEN = 'FAKE_TOKEN_SHOULD_NEVER_LEAK_123456'
const QZONE_RAW = JSON.stringify({
  app: 'com.tencent.tuwen.lua',
  view: 'news',
  bizsrc: 'qzone.shuoshuoshareonlytext',
  prompt: '[分享]空间说说',
  meta: {
    news: {
      desc: '示例账号的说说',
      jumpUrl: 'mqqapi://qzoneschema/?schema=' + SCHEMA,
      preview: 'https://qzonestyle.gtimg.cn/qzone/client/mqq/aio/Qzone-logo-ark.png',
      tag: 'QQ空间',
      title: '分享了一条说说',
      legacyUrl: 'https://mobile.qzone.qq.com/l?a=311&i=db0c50b4c006f06aec7c0100&u=3025145051&g=1502',
      pcJumpUrl: 'https://mobile.qzone.qq.com/l?a=311&i=db0c50b4c006f06aec7c0100&u=3025145051&g=1502'
    }
  },
  config: { token: FAKE_TOKEN }
})

/* 1. 真实 Qzone 卡：认得出来，抠得到说说 id 与作者 */
const card = q.parseCard(QZONE_RAW)
ok(card && card.kind === 'qzone', 'Qzone 卡认成 kind=qzone')
ok(card.cellId === 'db0c50b4c006f06aec7c0100', '抠出 cellid（24 位）')
ok(card.uin === '3025145051', '抠出作者 QQ')
ok(/^https:\/\/mobile\.qzone\.qq\.com\//.test(card.url), '链接给的是 https，不是 mqqapi://')
ok(card.title === '分享了一条说说', '标题取 meta.news.title')
ok(card.desc === '示例账号的说说', '简介取 meta.news.desc')
ok(card.tag === 'QQ空间', '带出卡片来源标签')

/* 2. 渲染：够她说清「谁分享了什么」，且 token 绝不出现 */
const text = q.cardText(card)
ok(text.includes('[卡片·QQ空间]'), '渲染带「[卡片·QQ空间]」标签')
ok(text.includes('db0c50b4c006f06aec7c0100'), '渲染带说说 id（她据此调工具）')
ok(text.includes('3025145051'), '渲染带作者 QQ')
ok(text.includes('stellar_qzone_card'), '渲染提示用哪个工具读正文')
ok(!text.includes(FAKE_TOKEN), 'token 不进文本')
ok(!text.includes('qzonestyle.gtimg.cn'), 'preview 这类长图 URL 不进文本')
ok(text.length <= 420, '一张卡不超过 420 字（实际 ' + text.length + '）')
ok(!JSON.stringify(card).includes('token'), '结构化结果里没有 token 字段')

/* 2.5 带图说说卡（meta.miniapp）——2026-11-24 第二次修
   她转的第二张卡是 com.tencent.miniapp.lua + bizsrc=qzone.shuoshuosharepicture，
   字段全在 meta.miniapp 上（news 分支认不到，于是回落到 [卡片消息] 这个「白板」）。
   样本照真卡抓下来，作者 QQ 换成示例号，token 换成假值。 */
const MINI_RAW = JSON.stringify({
  app: 'com.tencent.miniapp.lua',
  prompt: '[分享]空间说说',
  bizsrc: 'qzone.shuoshuosharepicture',
  view: 'miniapp',
  meta: {
    miniapp: {
      title: '✨能源化工系 “聚能迎新·青春启航”双迎晚会来啦！✨...',
      source: '说说',
      tag: 'QQ空间',
      preview: 'https://photonjmaz.photo.store.qq.com/psc?/V514GIvN1U5BQY1AI8TK2FtT9N1cVkn5/abc',
      jumpUrl: 'mqqapi://qzoneschema/?schema=' + SCHEMA,
      legacyUrl: 'https://mobile.qzone.qq.com/l?a=311&i=d8f40fa25236056bc87b0500&u=1000000001&g=1502',
      pcJumpUrl: 'https://mobile.qzone.qq.com/l?a=311&i=d8f40fa25236056bc87b0500&u=1000000001&g=1502'
    }
  },
  config: { token: FAKE_TOKEN }
})
const mini = q.parseCard(MINI_RAW)
ok(mini && mini.kind === 'qzone', 'mini.app 说说卡认成 kind=qzone')
ok(mini && mini.cellId === 'd8f40fa25236056bc87b0500', 'mini.app 卡抠出 cellid')
ok(mini && mini.uin === '1000000001', 'mini.app 卡抠出作者 QQ')
ok(mini && mini.title.indexOf('...') < 0 && mini.title.indexOf('…') < 0, '标题尾部省略号被清掉（念出来才顺）')
ok(mini && /^https:\/\/mobile\.qzone\.qq\.com\//.test(mini.url), 'mini.app 卡链接取 legacyUrl 的 https')
const miniText = q.cardText(mini)
ok(miniText.includes('[卡片·QQ空间]'), 'mini.app 卡渲染成「[卡片·QQ空间]」，不是「[卡片消息]」')
ok(miniText.includes('双迎晚会'), 'mini.app 卡带出标题正文（她说得出「什么活动」）')
ok(miniText.includes('d8f40fa25236056bc87b0500'), 'mini.app 卡带出说说 id')
ok(!miniText.includes(FAKE_TOKEN), 'mini.app 卡的 token 不进文本')
ok(miniText.length <= 420, 'mini.app 卡不超过 420 字（实际 ' + miniText.length + '）')
// 只有 mqqapi:// 没有 legacyUrl 时，也要能从 base64 schema 里解出说说 id
const miniNoLegacy = q.parseCard(JSON.stringify({
  app: 'com.tencent.miniapp.lua',
  bizsrc: 'qzone.shuoshuosharepicture',
  prompt: '[分享]空间说说',
  meta: { miniapp: { tag: 'QQ空间', jumpUrl: 'mqqapi://qzoneschema/?schema=' + SCHEMA } }
}))
ok(miniNoLegacy && miniNoLegacy.kind === 'qzone', '只有 mqqapi 时仍认成 qzone')
ok(miniNoLegacy && miniNoLegacy.cellId === 'db0c50b4c006f06aec7c0100', '只有 mqqapi 时从 schema 解出 cellid')
ok(miniNoLegacy && /^https:\/\/mobile\.qzone\.qq\.com\//.test(miniNoLegacy.url), '只有 mqqapi 时链接换成解码出的 oldlink')

/* 2.6 认不出来时留得下形状（诊断用），但不漏 token（2026-11-24，PITFALLS #326） */
const unknownCard = JSON.stringify({
  app: 'com.tencent.someweird.lua',
  bizsrc: 'unknown.bizsrc',
  prompt: '[分享]某个东西',
  meta: { cool_new_thing: { title: 'x' } },
  config: { token: FAKE_TOKEN },
})
ok(q.parseCard(unknownCard) === null, '不认识的形状仍返回 null（走兜底文案）')
const shape = q.cardShape(unknownCard)
ok(shape.app === 'com.tencent.someweird.lua', 'cardShape 记下 app')
ok(shape.bizsrc === 'unknown.bizsrc', 'cardShape 记下 bizsrc')
ok(shape.metaKeys.join(',') === 'cool_new_thing', 'cardShape 记下 meta 的键名（就是它提示该加哪个分支）')
ok(!JSON.stringify(shape).includes(FAKE_TOKEN), 'cardShape 不带 token')
ok(q.cardShape('<msg url="https://x.test/a" />').kind === 'xml', 'cardShape 认 xml')
ok(q.cardShape('不是 JSON').kind === 'text', 'cardShape 认纯文本')

/* 3. B站小程序卡：BV 号与链接照旧能用 */
const BILI_RAW = JSON.stringify({
  app: 'com.tencent.miniapp_01',
  meta: {
    detail_1: {
      appid: '1109937557',
      title: '哔哩哔哩',
      desc: '【猫meme】打工人下班了',
      qqdocurl: 'https://b23.tv/abcDEF?share_medium=android&bbid=XYZ&ts=1',
      preview: 'https://pic.example.com/cover.jpg'
    }
  }
})
const bili = q.parseCard(BILI_RAW)
ok(bili && /miniapp/.test(bili.kind), '小程序卡 kind=miniapp')
const biliText = q.cardText(bili)
ok(biliText.includes('【猫meme】打工人下班了'), 'B站卡带视频标题')
ok(!biliText.includes('哔哩哔哩 —'), '应用名不当标题重复念')
ok(biliText.includes('https://b23.tv/abcDEF'), 'b23 链接去掉埋点参数，只留 scheme+host+path')
ok(!biliText.includes('bbid='), '埋点参数不带着走')

const BV_RAW = JSON.stringify({ meta: { detail_1: { title: '哔哩哔哩', desc: '一个视频', qqdocurl: 'https://www.bilibili.com/video/BV1yvaT65EGk/?p=1' } } })
ok(q.cardText(q.parseCard(BV_RAW)).includes('BV1yvaT65EGk'), '有 BV 号时直接给 BV 号')

/* 4. XML 卡：属性/标题/摘要都要，&amp; 要还原 */
const XML = '<msg serviceID="1" templateID="1" action="web" brief="[分享] 一条说说" url="https://mobile.qzone.qq.com/l?i=db0c50b4c006f06aec7c0100&amp;u=3025145051"><item layout="2"><title>一条说说</title><summary>示例账号的说说</summary></item><source name="QQ空间"/></msg>'
const xmlCard = q.parseCard(XML)
ok(xmlCard && xmlCard.kind === 'qzone', 'XML 空间卡认成 qzone')
ok(xmlCard.title === '一条说说', 'XML 取 title')
ok(xmlCard.desc === '示例账号的说说', 'XML 取 summary')
ok(xmlCard.url.includes('&u=3025145051') && !xmlCard.url.includes('&amp;'), 'XML 属性里的 &amp; 还原成 &')
ok(xmlCard.cellId === 'db0c50b4c006f06aec7c0100', 'XML 卡也能抠出说说 id')

/* 5. 裸链接与 mqqapi 解码 */
const mood = q.parseCard('https://user.qzone.qq.com/3025145051/mood/db0c50b4c006f06aec7c0100')
ok(mood && mood.cellId === 'db0c50b4c006f06aec7c0100', '裸 mood 链接抠出 cellid')
ok(mood.uin === '3025145051', '裸 mood 链接抠出 uin')
ok(q.decodeMqqSchema('mqqapi://qzoneschema/?schema=' + SCHEMA).startsWith('https://mobile.qzone.qq.com/l?'), 'mqqapi base64 解出 oldlink')
ok(q.decodeMqqSchema('https://x.y/z') === '', '不是 mqqapi 就返回空，不瞎猜')
ok(q.qzoneIdsFromUrl('https://user.qzone.qq.com/1234567/mood/0123456789abcdef01234567').uin === '1234567', 'mood 路径里的 uin')

/* 6. 段数据三种形状（网关实现不同） */
ok(q.cardTextFromSegmentData({ data: QZONE_RAW }).includes('[卡片·QQ空间]'), '{data: <json 字符串>} 能渲染')
ok(q.cardTextFromSegmentData({ json: JSON.parse(QZONE_RAW) }).includes('[卡片·QQ空间]'), '{json: <对象>} 能渲染')
ok(q.cardTextFromSegmentData(QZONE_RAW).includes('[卡片·QQ空间]'), '直接给字符串也能渲染')
ok(q.cardTextFromSegmentData(null) === '[卡片消息]', 'null 走兜底文案')
ok(q.cardTextFromSegmentData('不是 json') === '[卡片消息]', '认不出来走兜底文案，不抛错')
ok(!q.cardTextFromSegmentData({ data: QZONE_RAW }).includes(FAKE_TOKEN), '段数据渲染也不漏 token')

/* 7. feed 详情渲染（qzone card 命令的输出形态） */
const FEED = {
  cell_common: { feed_id: 'db0c50b44995026beb4f0d00', time: '1795331401' },
  cell_user_info: { user: { uin: '3025145051', nick: '示例账号' } },
  cell_summary: { summary: [{ content: '因为一些不可抗因素，猫老弟可能要离开我们一段时间了😓' }] },
  cell_media: { media_items: [{}, {}] },
  cell_comment: { num: 4 }
}
const feedText = q.feedCardText(FEED, { tid: 'db0c50b44995026beb4f0d00' })
ok(feedText.includes('[空间说说]'), 'feed 渲染带 [空间说说]')
ok(feedText.includes('示例账号（3025145051）'), 'feed 渲染带作者昵称与 QQ')
ok(feedText.includes('2026-11-22'), 'feed 渲染把 epoch 秒转成日期（本地时区）')
ok(feedText.includes('猫老弟'), 'feed 渲染带正文')
ok(feedText.includes('图 2 张'), 'feed 渲染带图数')
ok(feedText.includes('评论 4 条'), 'feed 渲染带评论数')
ok(feedText.includes('https://user.qzone.qq.com/3025145051/mood/db0c50b44995026beb4f0d00'), 'feed 渲染带说说链接')
ok(q.feedCardText(null) === '', '没有 feed 时返回空串，由调用方报打不开')
ok(q.feedCardText({ cell_summary: {} }, {}).includes('正文：（这条没有文字'), '只有图没有字时说清楚')

/* 7.5 图片：说说里的图要能变成可下载的 URL（2026-11-24 主人追加：转发动态里的图也要读得出来） */
const MEDIA = [
  { image: { lloc: 'A', default_url: { url: 'https://m.qpic.cn/a.jpg' } } },
  { image: { lloc: 'B', default_url: 'https://m.qpic.cn/b.jpg' } },
  { image: { lloc: 'C', photo_url: [{ spec: 1, url: { url: 'https://m.qpic.cn/c1.jpg' } }, { spec: 5, url: { url: 'https://m.qpic.cn/c5.jpg' } }] } },
  { image: { lloc: 'A', default_url: { url: 'https://m.qpic.cn/a.jpg' } } },
  { video: { url: 'https://m.qpic.cn/v.mp4' } },
  null
]
const urls = q.mediaImageUrls(MEDIA, { max: 9 })
ok(urls.length === 3, '三张图去重后 3 条（实际 ' + urls.length + '）')
ok(urls[0] === 'https://m.qpic.cn/a.jpg', 'default_url 是对象时取 .url')
ok(urls[1] === 'https://m.qpic.cn/b.jpg', 'default_url 是字符串时直接用')
ok(urls[2] === 'https://m.qpic.cn/c1.jpg', '只有 photo_url 时取第一档')
ok(q.mediaImageUrls(MEDIA, { max: 2 }).length === 2, 'max 生效')
ok(q.mediaImageUrls(null).length === 0, '没有图时返回空数组')
ok(!JSON.stringify(urls).includes('v.mp4'), '视频不算图')

/* 8. 合并转发：这才是主人这次遇到的那条路 */
const forwardPayload = {
  messages: [
    { sender: { nickname: '示例账号', user_id: 3025145051 }, time: 1795331401, content: [{ type: 'json', data: { data: QZONE_RAW } }] },
    { sender: { nickname: '示例账号', user_id: 3025145051 }, time: 1795331402, content: [{ type: 'text', data: { text: '你之前说的那个' } }] }
  ]
}
const out = fw.formatForwardResponse(forwardPayload)
ok(out.messages[0].text.includes('[卡片·QQ空间]'), '转发里的卡片渲染成可读文本（不再是 [卡片消息]）')
ok(!out.messages[0].text.includes('[卡片消息]'), '转发里不再出现字面量 [卡片消息]')
ok(out.messages[0].text.includes('db0c50b4c006f06aec7c0100'), '转发文本带说说 id')
ok(!out.messages[0].text.includes(FAKE_TOKEN), '转发文本不漏 token')
ok(out.messages[1].text === '你之前说的那个', '同一转发里别的消息不受影响')

/* 9. 接线：两边真的共用这一个模块 */
const bridgeSrc = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8')
ok(bridgeSrc.includes("from './qq-card.js'"), 'bridge.js 引入了 qq-card')
ok(!/function parseArkCard\(/.test(bridgeSrc), 'bridge.js 不再自己养一份 parseArkCard')
ok(bridgeSrc.includes('cardTextFromSegmentData(d.data ?? d.json ?? d)'), 'bridge 的 json 段走共用渲染')
const forwardSrc = fs.readFileSync(path.join(root, 'src', 'forward.js'), 'utf8')
ok(forwardSrc.includes("from './qq-card.js'"), 'forward.js 引入了 qq-card')
ok(/case 'xml'/.test(forwardSrc), 'forward.js 认 xml 段')
const qzoneCli = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'tools', 'commands', 'qzone.mjs'), 'utf8')
ok(qzoneCli.includes("sub === 'card'"), 'qzone CLI 有 card 子命令')
ok(qzoneCli.includes('get_qzone_feed_detail'), 'card 走 feed_detail（不是 msg_detail 那套 id）')
ok(qzoneCli.includes('feedCardText'), 'card 用共用渲染')
ok(qzoneCli.includes('mediaImageUrls'), 'card 会取说说里的图')
ok(qzoneCli.includes("args.has('images')"), 'card 的 --images 开关存在')
ok(qzoneCli.includes("args.get('max-images')"), 'card 支持 --max-images 限张数')
const mcpSrc = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8')
ok(mcpSrc.includes("'stellar_qzone_card'"), 'MCP 注册了 stellar_qzone_card')
ok(mcpSrc.includes("stellar_qzone_card: 'qzone'"), 'stellar_qzone_card 挂上空间规则门')
ok(mcpSrc.includes("'--images', '--max-images'"), 'MCP 侧让 CLI 下图')
ok(mcpSrc.includes('mediaImageBlock(pic?.file)'), 'MCP 把下载下来的图当 image 块附上')

console.log('\n' + (fail === 0 ? '✅' : '❌') + ' qq-card: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
