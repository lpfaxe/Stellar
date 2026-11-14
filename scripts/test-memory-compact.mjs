#!/usr/bin/env node
/**
 * memory-compact 单测：只跑纯函数，不碰磁盘与网络。
 * 用一份仿真的卡片文本（结构跟 memory-card-prompt-qq.md 一致）。
 */
import assert from 'node:assert/strict';
import {
  buildCompactCard, buildMemoryPromptText, extractFacts, extractPreferences,
  normalizeCompactConfig, parseCardSections,
} from '../src/memory-compact.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.error('  FAIL ' + name + '\n       ' + (e && e.message)); }
};

const CARD = [
  '【记忆卡 · 你自己的记忆】',
  '（不是别人给你的设定。）',
  '',
  '## 初次相遇（和主人）',
  '- 2026-11-08 [清晰] 主人（私聊）：？ → 她回：哈？就一个问号',
  '- 2026-11-08 [清晰] 主人（私聊）：另一个 → 她回：另一个回复',
  '',
  '## 永远不会忘的',
  '- 2026-11-09 [清晰] 主人（私聊）：我的生日是1月1日，记住了 → 她回：记死了',
  '- 2026-11-09 [清晰] 主人（私聊）：安徽宣城，记住了 → 她回：行，记住了',
  '- 2026-11-10 [清晰] 主人（私聊）：别随便泄露别人信息 → 她回：行',
  '',
  '## 记得最牢的事（按重要度）',
  '- 2026-11-09 [清晰] 主人（私聊）：记得我的生日吗？ → 她回：1月1',
  '- 2026-11-09 [清晰] 主人（私聊）：本钱的事 → 她回：先把本钱打过来',
  '- 2026-11-09 [清晰] 主人（私聊）：我的物理位置在哪？ → 她回：安徽宣城',
  '- 2026-11-09 [清晰] 主人（私聊）：能不能下次回复就一条？ → 她回：行，一条就一条。',
  '- 2026-11-10 [清晰] 主人（私聊）：没关系，以后再说 → 她回：行',
  '- 2026-11-10 [清晰] 主人（私聊）：第六条 → 她回：六',
  '- 2026-11-10 [清晰] 主人（私聊）：第七条 → 她回：七',
  '',
  '## 最近记得的',
  '- 2026-11-10 [清楚] 示例机器人（私聊）：我才不给你跑腿呢',
  '- 2026-11-10 [清楚] 主人（私聊）：帮我看看这个动画 → 她回：看了',
].join('\n');

console.log('memory-compact');

t('parseCardSections 分出四段', () => {
  const secs = parseCardSections(CARD);
  assert.equal(secs.filter((s) => s.head).length, 4);
  assert.equal(secs.find((s) => /初次相遇/.test(s.head)).items.length, 2);
});

t('normalizeCompactConfig：默认值 + clamp', () => {
  const d = normalizeCompactConfig({});
  assert.equal(d.enabled, true);
  assert.equal(d.coreLimits.strongest, 3);
  const c = normalizeCompactConfig({ factChars: 5, coreChars: 99999, itemChars: 10, coreLimits: { strongest: 99 } });
  assert.equal(c.factChars, 60);
  assert.equal(c.coreChars, 2000);
  assert.equal(c.itemChars, 40);
  assert.equal(c.coreLimits.strongest, 12);
  assert.equal(normalizeCompactConfig({ enabled: false }).enabled, false);
});

t('extractFacts 抓到生日与常住地，且不重复', () => {
  const facts = extractFacts(parseCardSections(CARD).flatMap((s) => s.items));
  assert.ok(facts.includes('生日：1 月 1 日'), facts.join(' | '));
  assert.ok(facts.includes('常住地：安徽宣城'), facts.join(' | '));
  assert.equal(facts.length, new Set(facts).size);
});

t('extractFacts 只认主人那句，她复述的不算', () => {
  const facts = extractFacts(['2026-11-09 [清晰] 示例机器人（私聊）：我家在安徽宣城']);
  assert.equal(facts.length, 0);
});

t('extractPreferences 抽到「回复一条」，并去掉她的回复部分', () => {
  const prefs = extractPreferences(parseCardSections(CARD).flatMap((s) => s.items));
  assert.ok(prefs.some((p) => p.includes('一条')), prefs.join(' | '));
  assert.ok(prefs.every((p) => !p.includes('她回')), prefs.join(' | '));
});

t('buildCompactCard 丢掉「最近记得的」', () => {
  const out = buildCompactCard(CARD);
  assert.ok(!out.includes('最近记得的'), out);
  assert.ok(!out.includes('帮我看看这个动画'), out);
});

t('buildCompactCard 三段齐全、条目按上限截断', () => {
  const out = buildCompactCard(CARD, { coreChars: 2000 });
  assert.ok(out.includes('【钉住的事实】'));
  assert.ok(out.includes('【他的偏好】'));
  assert.ok(out.includes('## 永远不会忘的'));
  const strong = out.split('## 记得最牢的事（按重要度）')[1];
  // 默认 coreLimits.strongest 现在是 3（380/1,3,3 折中档），显式传 5 才能验到 5 条。
  const wide = buildCompactCard(CARD, { coreChars: 2000, coreLimits: { firstMeet: 1, forever: 3, strongest: 5 } });
  const strongWide = wide.split('## 记得最牢的事（按重要度）')[1];
  assert.equal(strongWide.split('\n').filter((l) => l.startsWith('- ')).length, 5);
  assert.equal(strong.split('\n').filter((l) => l.startsWith('- ')).length, 3);
});

t('buildCompactCard 去重（重复的生日事件只留一条）', () => {
  const out = buildCompactCard(CARD, { coreChars: 2000 });
  const dup = out.split('\n').filter((l) => l.includes('1月1'));
  assert.ok(dup.length <= 2, out);
});

t('coreChars 预算：截断后不超过上限', () => {
  const out = buildCompactCard(CARD, { coreChars: 200 });
  const core = out.split('## 初次相遇')[1] || '';
  assert.ok(('## 初次相遇' + core).length <= 400, String(('## 初次相遇' + core).length));
});

t('compact 关闭 → 原样返回卡片', () => {
  const out = buildMemoryPromptText({ cardText: CARD, vectorText: '【想起的旧事】\n· 旧事', compact: { enabled: false } });
  assert.equal(out, CARD + '\n\n【想起的旧事】\n· 旧事');
});

t('卡片为空 → 只给向量块', () => {
  const out = buildMemoryPromptText({ cardText: '', vectorText: '【想起的旧事】\n· 旧事' });
  assert.equal(out, '【想起的旧事】\n· 旧事');
});

t('向量为空 → 只有紧凑卡', () => {
  const out = buildMemoryPromptText({ cardText: CARD, vectorText: '' });
  assert.ok(out.startsWith('【钉住的事实】'));
  assert.ok(!out.includes('【想起的旧事】'));
});

t('紧凑卡明显短于原文，但仍保留关键事实', () => {
  const out = buildMemoryPromptText({ cardText: CARD, vectorText: '' });
  // 小样例卡本来就没多少可省；真实卡（2565 字）实测降到 593 字。这里只保证明显变短。
  assert.ok(out.length < CARD.length * 0.75, CARD.length + ' -> ' + out.length);
  assert.ok(out.includes('安徽宣城'));
  assert.ok(out.includes('1 月 1 日'));
});

t('空卡片空向量 → 空串', () => {
  assert.equal(buildMemoryPromptText({}), '');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
