// 字幕「目录 + 命中窗口」（2026-11-21，主人拍板 A+D）：
//   看视频的钱几乎全花在「每一步把整段上下文重发一遍」上。字幕 500 字/分钟，
//   整篇 read 是几千 token；这里只回「5 分钟目录」或「2~3 个 75 秒窗口」。
//   判据有两条：问得准（原词/时间戳要命中）、问不准时不许硬凑（改述/无关问题回 0 条）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDigest,
  coverageOf,
  coverageText,
  formatClock,
  hitSnippet,
  hitsText,
  outlineOf,
  outlineText,
  parseSubtitleText,
  parseTimeRef,
  searchDigest,
  tokenize,
  windowAt,
  windowsOf
} from '../plugins/stellar/tools/lib/subs-digest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'plugins', 'stellar', 'tools');

let pass = 0;
const ok = (cond, message, detail) => {
  if (cond) { pass += 1; return; }
  console.error('✗ ' + message + (detail === undefined ? '' : '（实际：' + detail + '）'));
  process.exitCode = 1;
};

// ── 造一条 16 分钟的字幕：绝大多数是废话，只有两段有用 ────────────────────────
const filler = '然后我们继续聊这个事情的细节，其实也没有太多可说的。';
const lines = [];
for (let i = 0; i < 400; i += 1) {
  const from = Math.round(i * 2.4);
  let text = filler;
  if (i === 80) text = '先说说这个快充头，支持六十五瓦，半小时能充到百分之八十，我天天在用。';
  if (i === 200) text = '电池的保养其实很简单，别总是插着充一整夜，充到八十多就拔掉。';
  lines.push({ from, to: from + 3, text });
}
const digest = buildDigest({ lines, durationSec: 960, title: '快充实测', bvid: 'BV1TEST00001' });

// 1) 时间解析
ok(parseTimeRef('12:34') === 754, 'mm:ss → 秒', parseTimeRef('12:34'));
ok(parseTimeRef('1:02:03') === 3723, 'h:mm:ss → 秒', parseTimeRef('1:02:03'));
ok(parseTimeRef('第 6 分钟') === 360, '「第 N 分钟」也认', parseTimeRef('第 6 分钟'));
ok(parseTimeRef('随便说点什么') === null, '认不出就 null，别瞎猜', parseTimeRef('随便说点什么'));

// 2) 老格式（[mm:ss] 正文）还能解析回来 —— find 的自愈就靠它
const parsed = parseSubtitleText('[00:10] 你好\n[00:20] 再见\n[00:30] 走了');
ok(parsed.length === 3, '三行都解析出来', parsed.length);
ok(parsed[0].from === 10 && parsed[0].to === 11, '结束时间按字数推（2 字 = 1 秒）', JSON.stringify(parsed[0]));
ok(parsed[2].from === 30, '时间戳单调', parsed[2].from);

// 3) digest 结构：只存行与覆盖率，窗口读时现算（保存的是可重建的最小信息）
ok(digest.v === 1 && digest.bvid === 'BV1TEST00001', '版本与 BV 落进 digest');
ok(digest.lines.length === 400 && digest.lines[0][0] === 0, '行存成 [秒, 正文] 二元组');
ok(typeof digest.lines[0][1] === 'string', '正文是纯文本');
ok(!JSON.stringify(digest).includes('windows'), 'digest 里不存窗口（换窗口大小不用重建）');

// 4) 覆盖率：有洞就报洞（D 的事实边界）
const rawLines = [{ from: 0, to: 30, text: 'a' }, { from: 300, to: 330, text: 'b' }];
const holed = buildDigest({ lines: rawLines, durationSec: 400 });
const gaps = holed.coverage.gaps;
ok(coverageOf(rawLines, 400).gaps.length === gaps.length, 'digest 里的覆盖率与现算的一致（单一事实来源）');
ok(gaps.length === 2, '中间断 270 秒 + 结尾缺 70 秒 = 两个缺口', JSON.stringify(gaps));
ok(gaps[0].from === 30 && gaps[0].to === 300, '中间那个缺口从上一句结束到下一句开始');
ok(gaps[1].from === 330 && gaps[1].to === 400, '结尾缺口一直算到全长（别把最后一段当完整）');
ok(coverageText(digest).includes('覆盖'), '覆盖率有面向模型的一句话');
ok(coverageText({ durationSec: 0, lines: [], coverage: { gaps: [] } }).length > 0, '完全没字幕也给一句（不返回空串）');

// 5) 窗口/目录
ok(windowsOf(digest).length === Math.ceil(960 / 75), '75 秒窗口数 = ceil(全长/75)', windowsOf(digest).length);
const outline = outlineOf(digest, { blockSec: 300 });
ok(outline.length === 4, '16 分钟按 5 分钟切 = 4 段', outline.length);
ok(outline[0].from === 0 && outline[0].to === 300, '第一段 0-300');
ok(outline[0].first && outline[0].last, '每段带首句与末句');
ok(outlineText(digest, { blockSec: 300 }).split('\n').length <= 12, '目录不超过 12 行（超了会自适应放大块）',
  outlineText(digest, { blockSec: 300 }).split('\n').length);
ok(formatClock(3723) === '1:02:03', '超过一小时带上小时', formatClock(3723));

// 6) 检索：原词命中、改述不硬凑、无关回 0
const hit = searchDigest(digest, '这个快充头能充多快', { limit: 3 });
ok(hit.total === 1, '同一段只算一次（别把整片都算命中）', hit.total);
ok(hit.hits[0].from === 150 && hit.hits[0].to === 225, '落到 150-225 那 75 秒', JSON.stringify([hit.hits[0].from, hit.hits[0].to]));
ok(hit.hits[0].text.includes('快充头'), '返回的是那一段的原文');
ok(hit.hits[0].matched.some((t) => t.includes('快充')), '命中词里能看到「快充」', hit.hits[0].matched.join('/'));
const batt = searchDigest(digest, '电池怎么保养', { limit: 2 });
ok(batt.hits[0] && batt.hits[0].from === 450, '「电池/保养」落到 450-525', batt.hits[0] && batt.hits[0].from);
const none = searchDigest(digest, '量子纠缠的退相干时间', { limit: 3 });
ok(none.total === 0, '无关问题回 0 条（不硬凑 = 她才能说「没提到」）', none.total);
const single = searchDigest(digest, '六十五瓦', { limit: 1 });
ok(single.total === 1 && single.hits.length === 1, '冷词也能命中', single.total);
ok(hitsText(digest, hit.hits).includes('命中'), '命中段带一句说明（省得她再解释）');

// 7) 时间引用：问「6:10」要偏向那一段
const byTime = searchDigest(digest, '6:10 说了什么', { limit: 2 });
ok(byTime.hasTimeRef === true, '识别出问题里带时间');
ok(byTime.hits.some((h) => h.from <= 370 && 370 <= h.to), '结果里有盖住 6:10 的那一段', JSON.stringify(byTime.hits.map((h) => h.from)));
const atWin = windowAt(digest, 200);
ok(atWin.length >= 1 && atWin[0].from <= 200 && 200 <= atWin[0].to, 'windowAt 取到包含 200 秒的窗口');
ok(windowAt(digest, 200, { ring: 1 }).length >= 3, '--ring 1 会多带前后各一段（她要看上下文时）');

// 8) 片段截取：不把半句话怼在开头
const long = { from: 60, to: 135, score: 9, matched: ['快充'], text: ('前面完全无关的废话，' + '真的无关的内容，'.repeat(30) + '这个快充头支持六十五瓦，半小时能充到百分之八十。' + '后面还有一大堆啰嗦的话。'.repeat(10)) };
const snip = hitSnippet(long, 120);
ok(snip.length <= 120, '片段不超过上限', snip.length);
ok(!snip.startsWith('，') && !snip.startsWith('、'), '开头不会剩个逗号');
ok(snip.includes('快充'), '截出来的片段里有命中的词');

// 9) 分词：中文二元+三元、拉丁词、停用词过滤
const tk = tokenize('这个 快充头 支持 65W fast charge');
ok(tk.some((t) => t.t.includes('快充')), '中文切出「快充」');
ok(tk.some((t) => /65w|fast|charge/i.test(t.t)), '拉丁词保留', tk.map((t) => t.t).join(','));
ok(!tk.some((t) => t.t === '这个'), '停用词不进索引');

// ── 接线：命令注册、不联网、别把字幕塞回上下文 ────────────────────────────────
// 2026-11-23：命令表从 bili.mjs 抽到了 tools/lib/cmd-map.mjs（bili.mjs 瘦成查表 + 透传）。
const biliMap = fs.readFileSync(path.join(TOOLS, 'bili.mjs'), 'utf8');
const cmdMap = fs.readFileSync(path.join(TOOLS, 'lib', 'cmd-map.mjs'), 'utf8');
ok(cmdMap.includes("'commands/find.mjs'"), 'cmd-map.mjs 命令表里有 find');
ok(biliMap.includes('CMD_MAP'), 'bili.mjs 仍然从命令表派发（没退回内联 map）');
const findSrc = fs.readFileSync(path.join(TOOLS, 'commands', 'find.mjs'), 'utf8');
ok(!/\bfetch\(|node:https|node:http|undici/.test(findSrc), 'find 不联网（digest 是本地文件）');
ok(/process\.exit\(4\)/.test(findSrc), '没有索引时用退出码 4（好让 MCP 侧给可行动提示）');
ok(findSrc.includes('-digest.json'), '读的是 digest，不读 debrief.txt 全文');
ok(findSrc.includes("shotsPath('subs')"), '只读 subs 目录');
ok(findSrc.includes('hitsText('), '命中段走 hitsText（带截断），不是把整段拼出来');
ok(findSrc.includes('2400'), '输出超长时会给「调小 limit」的提示，而不是把上下文撑爆');

const debrief = fs.readFileSync(path.join(TOOLS, 'commands', 'debrief.mjs'), 'utf8');
ok(debrief.includes("from '../lib/subs-digest.mjs'"), 'debrief 引入 subs-digest');
ok(debrief.includes('buildDigest(') && debrief.includes("-digest.json"), 'debrief 落盘时顺手建 digest');
ok(debrief.includes('outlineText(digest'), 'debrief 打印 5 分钟目录');
ok(debrief.includes("opt['no-outline']"), '--no-outline 能关掉目录（省 token 的逃生口）');
ok(debrief.includes('coverageText('), '目录后面跟着覆盖率');

const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
ok(mcpSrc.includes("'stellar_bili_find'"), 'MCP 暴露 stellar_bili_find（QQ 会话没 shell，只能走这个）');
ok(/stellar_bili_find: 'bili'/.test(mcpSrc), 'find 也走 bili 规则门');
ok(mcpSrc.includes("args = ['find', m[1]]"), 'find 只接受 BV 号（短链先走 watch）');
ok(/code === 4/.test(mcpSrc), 'MCP 侧认得退出码 4');

const rules = fs.readFileSync(path.join(TOOLS, 'rules', 'bili.md'), 'utf8');
ok(rules.includes('stellar_bili_find'), '规则里教她问细节用 find');
ok(rules.includes('read 字幕全文'), '规则里明确禁止 read 字幕全文');
ok(rules.includes('没字幕'), '规则里要求说「这段没字幕，我不确定」');

console.log('字幕目录与命中窗口：' + pass + ' 通过');
if (process.exitCode) console.log('失败数见上面的 ✗');
