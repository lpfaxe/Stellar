/**
 * 角色风格参考引擎的回归（设计 §6，方案 B）：
 *  · 名字清洗——参考角色的名字一旦进提示词，模型就开始扮演 TA；
 *  · PART1（角色档案）必须跳过——那是「TA 是谁」，注进来她会变成别人；
 *  · >800 字的片不索引、注入预算硬上限 900 字符、只挑命中情境的片；
 *  · 同一种情境连续第 3 次起跳过（防复读），标签一变就重新计数。
 *
 * 这四条任何一条退化都不报错，只是「她的语气慢慢变成别人」——属于最难发现的一类回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SLICE = await import('../src/style-refs.js');

const FIXTURE = [
  'PART0 系统提示词',
  '你是参考对象，保持短句。',
  '',
  'PART1 角色档案',
  '名字：一色彩羽',
  '身份：总武高中学生',
  '',
  'PART2 性格',
  '1｜撒娇时先笑一下',
  '被喜欢的人靠近会黏上去，用「要嘛」结尾。',
  '',
  '2｜被夸会得意',
  '嘴上说「哪有」，其实尾巴翘起来。',
  '',
  'PART3 说话风格',
  '规则 1｜句子短',
  '一句话说完就够，不写排比。',
  '',
  'PART4 对话样本',
  '■ 场景一｜被夸',
  'B：你今天真好看',
  'A：哼，本小姐一直好看。',
  '（原文）笑一下',
  '（拟写）别过脸',
  '',
  '■ 场景二｜撒娇',
  'B：在忙吗',
  'A：要嘛，陪我一下。',
  '',
  'PART5 演法',
  '◆ 情绪开关（输入 → 反应）',
  '输入：被夸',
  '先哼一声，再说一句软话。',
  '',
  '输入：被追问',
  '先轻描淡写带过，再把话题拉回对方身上。',
  '',
  'PART6 常见错误',
  '✗ 一开口就长篇大论',
  '○ 改：先说一句，再看对方反应。',
  '',
  '附：证据索引',
  '第 12 行、第 88 行',
].join('\n');

test('名字清洗：参考角色的名字不会进提示词', () => {
  const out = SLICE.scrubStyleText('一色彩羽说：伊吕波才不会这样。');
  assert.ok(!/一色|伊吕波|彩羽/.test(out), out);
  assert.ok(out.includes('参考对象'));
  assert.ok(!/我的青春恋爱物语果然有问题/.test(SLICE.scrubStyleText('《我的青春恋爱物语果然有问题》')));
});

test('排版标记清洗：不留【原文】、✗、○ 改、A： 这类教材格式', () => {
  const out = SLICE.scrubStyleText([
    'A：「本小姐才不会」【原文】',
    '✗ 一开口就长篇大论',
    '○ 改：先说一句。',
  ].join('\n'));
  assert.ok(!/【原文】|【拟写】/.test(out), out);
  assert.ok(!/^A\s*[（(：:]/m.test(out), out);
  assert.ok(out.includes('别这样：一开口就长篇大论'), out);
  assert.ok(out.includes('改成：先说一句。'), out);
  assert.ok(out.startsWith('「本小姐才不会」'), out);
});

test('作品里的其他角色名也换掉（不然她会开始演对方）', () => {
  const out = SLICE.scrubStyleText('雪之下雪乃和由比滨结衣，比企谷八幡，叶山隼人');
  assert.ok(!/雪乃|结衣|八幡|叶山/.test(out), out);
  assert.ok(out.includes('旁人') && out.includes('对方'), out);
});

test('同分时正向演法压过纯禁忌（禁忌只当兜底）', () => {
  const slices = [
    { id: 'a', kind: 'rule', tags: ['被夸'], chars: 60, text: '◆ 禁忌（演崩高发区）\n别看对方' },
    { id: 'b', kind: 'rule', tags: ['被夸'], chars: 60, text: '输入：被夸\n先哼一声再软下来' },
  ];
  const picks = SLICE.pickStyleSlices(slices, { tags: ['被夸'], maxSlices: 1 });
  assert.equal(picks.length, 1);
  assert.ok(/输入：被夸/.test(picks[0].text), picks[0].text);
});

test('PART1 与附录不入库，PART0 只出一条 prompt', () => {
  const slices = SLICE.parseReferenceText({ text: FIXTURE });
  assert.ok(!slices.some((s) => s.part === 'PART1'), 'PART1 不该被索引');
  assert.ok(!slices.some((s) => /总武高中/.test(s.text)), '角色档案正文不该进库');
  assert.ok(!slices.some((s) => /证据索引|第 12 行/.test(s.text)), '附录不该进库');
  const prompts = slices.filter((s) => s.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.ok(!/一色/.test(prompts[0].text));
});

test('切片形状：情绪开关按「输入：」细分，样本只留 A 的对白', () => {
  const slices = SLICE.parseReferenceText({ text: FIXTURE });
  const rules = slices.filter((s) => s.kind === 'rule');
  assert.ok(rules.some((s) => /被夸/.test(s.text) && /先哼一声/.test(s.text)));
  assert.ok(rules.some((s) => /被追问/.test(s.text)), '情绪开关要拆成多条，不能并成一条');
  const samples = slices.filter((s) => s.kind === 'sample');
  assert.equal(samples.length, 2);
  assert.ok(samples.every((s) => !/^B/m.test(s.text)), '样本里不该出现对方的台词');
  assert.ok(samples.every((s) => s.chars <= 400));
  assert.ok(slices.every((s) => s.chars <= 800), '超过 800 字的片不该入库');
});

test('超长段落不索引（注入反占预算）', () => {
  const long = 'PART3 说话风格\n规则 9｜超长\n' + '啰'.repeat(900);
  const slices = SLICE.parseReferenceText({ text: long });
  assert.equal(slices.length, 0);
});

test('挑片：只挑命中情境的，先 rule 后 sample，总字符不超预算', () => {
  const slices = SLICE.parseReferenceText({ text: FIXTURE }).map((s) => ({ ...s, id: s.text.slice(0, 8) }));
  const picks = SLICE.pickStyleSlices(slices, { tags: ['被夸'], maxSlices: 2, maxChars: 900 });
  assert.equal(picks.length, 2);
  assert.equal(picks[0].kind, 'rule');
  assert.equal(picks[1].kind, 'sample');
  assert.ok(picks.every((p) => /被夸|好看/.test(p.text)), JSON.stringify(picks));
  const total = picks.reduce((n, p) => n + p.chars, 0);
  assert.ok(total <= 900, '总字符 ' + total);
  assert.deepEqual(SLICE.pickStyleSlices(slices, { tags: [], maxSlices: 2 }), []);
  assert.deepEqual(SLICE.pickStyleSlices(slices, { tags: ['完全无关的标签'] }), []);
});

test('渲染：带人设名、不出现参考角色名、不超过 900 字符', () => {
  const slices = SLICE.parseReferenceText({ text: FIXTURE }).map((s) => ({ ...s, id: s.text.slice(0, 8) }));
  const picks = SLICE.pickStyleSlices(slices, { tags: ['被夸', '撒娇'] });
  const block = SLICE.renderStyleRefBlock(picks, { personaName: 'DeepSeek恶魔娘' });
  assert.ok(block.includes('【参考报告】'));
  assert.ok(block.includes('DeepSeek恶魔娘'));
  assert.ok(!/一色|伊吕波|彩羽/.test(block));
  assert.ok(block.length <= 900 + 400, '注入块 ' + block.length);
  assert.equal(SLICE.renderStyleRefBlock([], { personaName: 'x' }), '');
});

test('情境判定：普通闲聊不触发，群聊没点名不触发', () => {
  assert.equal(SLICE.detectStyleTags('今天几点开会').high, false);
  assert.equal(SLICE.detectStyleTags('今天几点开会').reason, 'no-mood');
  assert.equal(SLICE.detectStyleTags('你好烦').high, false);
  const grp = SLICE.detectStyleTags('气死我了', { isGroup: true, addressed: false });
  assert.equal(grp.high, false);
  assert.equal(grp.reason, 'group-unaddressed');
  assert.equal(SLICE.detectStyleTags('气死我了', { isGroup: true, addressed: true }).high, true);
  assert.equal(SLICE.detectStyleTags('你今天真好看').high, true);
});

test('傲娇是组合特征：嘴硬 + 心软同现才算，单嘴硬/单心软都不算', () => {
  // 同半句：「麻烦 + 喜欢」= 傲娇（参考库第 143 行那句的原型）
  const hit = SLICE.detectStyleTags('真的麻烦到死了，但就是喜欢，没办法');
  assert.ok(hit.tags.includes('傲娇'), JSON.stringify(hit));
  assert.equal(hit.high, true);
  // 跨半句但带转折词：也算
  assert.ok(SLICE.detectStyleTags('才不要，不过……谢谢你啊').tags.includes('傲娇'));
  // 只有嘴硬：不是傲娇，也不触发注入
  const hardOnly = SLICE.detectStyleTags('算了吧');
  assert.ok(!hardOnly.tags.includes('傲娇'));
  assert.equal(hardOnly.high, false);
  // 只有心软：不算傲娇（是暧昧）
  const softOnly = SLICE.detectStyleTags('我很喜欢这个');
  assert.ok(!softOnly.tags.includes('傲娇'));
  // 两句之间没有转折：不算（窗口法曾在这里误判，见 历史踩坑记录）
  assert.ok(!SLICE.detectStyleTags('今天好烦。我挺喜欢你上次说的那个').tags.includes('傲娇'));
  // 群聊没点名：仍然一律不注入
  assert.equal(SLICE.detectStyleTags('麻烦死了，但我喜欢', { isGroup: true, addressed: false }).high, false);
});
test('连读节流：同一组标签连续第 3 次起跳过，换标签重置', () => {
  let st = SLICE.nextStyleStreak(null, 'a,b');
  assert.equal(st.count, 1);
  assert.equal(st.skip, false);
  st = SLICE.nextStyleStreak(st, 'a,b');
  assert.equal(st.count, 2);
  assert.equal(st.skip, false);
  st = SLICE.nextStyleStreak(st, 'a,b');
  assert.equal(st.count, 3);
  assert.equal(st.skip, true);
  st = SLICE.nextStyleStreak(st, 'c');
  assert.equal(st.count, 1);
  assert.equal(st.skip, false);
  assert.equal(SLICE.nextStyleStreak(null, '').skip, false);
});

test('真实参考库：能切出够用的片，且不带参考角色名', (t) => {
  const dir = path.join(import.meta.dirname, '..', '..', '角色设定参考');
  const file = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.endsWith('.txt')) : null;
  if (!file) return t.skip('参考库不在本机');
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const slices = SLICE.parseReferenceText({ text });
  assert.ok(slices.length >= 40, '只切出 ' + slices.length + ' 条');
  assert.ok(slices.every((s) => s.chars <= 800));
  assert.ok(slices.every((s) => !/一色|伊吕波|彩羽|小米|小町/.test(s.text)), '有片残留参考角色名');
  assert.ok(slices.some((s) => s.kind === 'sample'));
  assert.ok(slices.some((s) => s.kind === 'mistake'));
  // 傲娇片必须能从真实库里自动打上标签（不靠手工标注）
  assert.ok(slices.some((s) => s.tags.includes('傲娇')), '真实库里没有一片被判为傲娇');
});
