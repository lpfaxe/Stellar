#!/usr/bin/env node
// test-group-link-guard.mjs —— 群聊不发 B站 视频链接的回归测试（2026-11-22，主人 m02721）。
//
// 全是离线的：直接 import src/group-link-guard.js 的纯函数，不启动桥接、不碰真状态。
// 覆盖：各种链接形态（带/不带协议、www/m、b23.tv 短链）、独立 BV 号、去重、
//       剥链接后的最小清理、纯链接被丢、allow=true 不剥、消息段里保留图片段。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const g = await import(pathToFileURL(path.join(root, 'src', 'group-link-guard.js')).href)

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fail += 1
  console.error('  ✗ ' + label)
}

/* 1. 识别：三种常见形态 + 不带协议的裸链接 */
const mixed = '看这个 https://www.bilibili.com/video/BV1yvaT65EGk/ 很好笑，还有 b23.tv/abc 和 http://m.bilibili.com/video/BV13SR5YMEis'
const found = g.findBiliLinks(mixed)
ok(found.length === 3, '一条消息里认出 3 个不同的链接（实际 ' + found.length + '）')
ok(found.some((x) => x.includes('b23.tv/abc')), '认出 b23.tv 短链')
ok(found.some((x) => x.includes('m.bilibili.com')), '认出 m.bilibili.com')
ok(g.findBiliLinks('bilibili.com/video/BV1yvaT65EGk').length === 1, '不带协议的裸链接也认')

/* 2. 识别：独立 BV 号（B 站视频的主键，贴了等于贴链接） */
ok(g.findBiliLinks('就是 BV1yvaT65EGk 那条').includes('BV1yvaT65EGk'), '单独一个 BV 号也认')
ok(g.findBiliLinks('ABV1yvaT65EGkx').length === 0, '更长单词里的 BV 不算（前后有字母数字）')

/* 3. 识别：别的链接不碰（主人要禁的是分享视频，不是禁一切链接） */
ok(g.findBiliLinks('新闻 https://example.com/a 和 ftp://x.y/z').length === 0, '非 B站 链接不动')

/* 4. 去重：同一条消息里重复贴只算一次 */
ok(g.findBiliLinks('https://b23.tv/abc 又 https://b23.tv/abc').length === 1, '重复链接去重')

/* 5. 剥离：留话、去链接、不留双空格 */
const one = g.stripBiliLinks('看这个 https://www.bilibili.com/video/BV1yvaT65EGk/ 很好笑')
ok(one.removed.length === 1, '剥离时记下 1 条')
ok(!/bilibili|b23\.tv|BV[0-9A-Za-z]{10}/.test(one.text), '剥离后正文里没有链接或 BV 号')
ok(one.text.includes('看这个') && one.text.includes('很好笑'), '保留前后的话')
ok(!/ {2,}/.test(one.text), '不留连续空格')
ok(one.text === one.text.trim(), '首尾无空白')

/* 6. 剥离：中文标点紧贴链接时，标点留下 */
const punct = g.stripBiliLinks('看看https://b23.tv/abc！好看')
ok(punct.removed.length === 1 && punct.text.includes('！好看'), '链接后面的中文标点没被吃掉')

/* 7. 剥离：纯链接 → 空正文（调用方据此拒发） */
const only = g.stripBiliLinks('https://b23.tv/xyz')
ok(only.removed.length === 1 && only.text === '', '纯链接剥完是空串')

/* 8. 剥离：多行里空行被丢掉，不留下空洞 */
const multi = g.stripBiliLinks('第一句\n\nhttps://b23.tv/a\n第三句')
ok(multi.text === '第一句\n第三句', '多行剥完只剩有内容的行（实际 ' + JSON.stringify(multi.text) + '）')

/* 9. 没有链接时一个字都不改（避免把她的话悄悄重排） */
const clean = g.stripBiliLinks('  今天风很大  ')
ok(clean.removed.length === 0 && clean.text === '  今天风很大  ', '没问题时原样返回（连空格都不动）')

/* 10. guardGroupMessages：默认剥、纯链接丢并标 dropped */
const pure = g.guardGroupMessages(['https://b23.tv/xyz'])
ok(pure.dropped === true, '只有链接的一条 → dropped')
ok(pure.messages.length === 0, 'dropped 时没有可发的消息')
ok(pure.changed === true, 'dropped 也算 changed')

const said = g.guardGroupMessages(['这条好看 https://b23.tv/xyz 真的'])
ok(said.dropped === false && said.messages.length === 1, '带话的一条照发')
ok(said.changed === true && said.removed.length === 1, 'changed 与 removed 都对得上')

const arr = g.guardGroupMessages(['第一句', 'https://b23.tv/xyz', '第三句'])
ok(arr.messages.length === 2 && arr.dropped === false, '三条里纯链接那条被丢掉，其余照发')
ok(arr.messages[0] === '第一句' && arr.messages[1] === '第三句', '顺序不变')

const untouched = g.guardGroupMessages(['今天好热', '风大'])
ok(untouched.changed === false && untouched.dropped === false && untouched.messages.length === 2, '没链接时整组不动')

/* 11. allow=true：主人显式放开时，一个字节都不改 */
const allowed = g.guardGroupMessages(['https://b23.tv/xyz'], { allow: true })
ok(allowed.messages[0] === 'https://b23.tv/xyz', 'allow=true 时不剥')
ok(allowed.changed === false && allowed.removed.length === 0, 'allow=true 时不算改动')

/* 12. 消息段：只改 text 段，图片段原样留着 */
const segs = g.guardGroupSegments([
  { type: 'text', data: { text: '这张图 https://b23.tv/xyz' } },
  { type: 'image', data: { file: 'a.png' } },
])
ok(segs.segments.length === 2, '有正文时两条段都留')
ok(segs.segments[0].data.text === '这张图', 'text 段被剥干净')
ok(segs.segments[1].type === 'image', '图片段不受影响')
ok(segs.dropped === false, '还有图片就不算 dropped')

const segsOnlyLink = g.guardGroupSegments([{ type: 'text', data: { text: 'https://b23.tv/xyz' } }])
ok(segsOnlyLink.segments.length === 0 && segsOnlyLink.dropped === true, '只有链接的 text 段 → dropped')

const segsImgOnly = g.guardGroupSegments([{ type: 'image', data: { file: 'a.png' } }])
ok(segsImgOnly.dropped === false && segsImgOnly.changed === false, '本来就只有图片 → 不动')

const segsAllow = g.guardGroupSegments([{ type: 'text', data: { text: 'https://b23.tv/xyz' } }], { allow: true })
ok(segsAllow.segments.length === 1 && segsAllow.changed === false, 'allow=true 时段也不动')

/* 13. 提示语：要让模型知道「以后别贴」，而不是只说「被拦了」 */
ok(typeof g.GROUP_LINK_HINT === 'string' && g.GROUP_LINK_HINT.includes('群聊'), '提示语点明这是群聊规则')
ok(g.GROUP_LINK_HINT.includes('不要贴链接'), '提示语给出替代做法')
ok(!/\n/.test(g.GROUP_LINK_HINT), '提示语是单行（要塞进工具响应）')

/* 14. 接线：桥接真的用了它（防止只写模块不接线） */
const fs = await import('node:fs')
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8')
ok(bridge.includes("from './group-link-guard.js'"), 'bridge.js 引入了 group-link-guard')
ok(bridge.includes('allowBiliLinksInGroups'), '桥接读 allowBiliLinksInGroups 开关')
ok(bridge.includes('GROUP_BILI_LINK'), '纯链接被拒时带 GROUP_BILI_LINK 错误码')
ok(bridge.includes('groupLinkPolicyOn()'), '有统一的策略开关函数')
ok(/guardGroupSegments\(\s*segments/.test(bridge), '消息段那一层也过闸（分享卡/图片走这里）')

console.log('\n' + (fail === 0 ? '✅' : '❌') + ' group-link-guard: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
