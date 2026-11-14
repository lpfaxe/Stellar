/**
 * 从聊天原文里抽「人物事实」（生日、忌口、过敏、称呼、住址、联系方式）。
 *
 * 为什么用确定性正则 + 一张小表，而不是让模型抽：
 *  · 抽事实是「宁可漏、不能错」的活。模型把「A 的生日」记到 B 名下、或把玩笑当事实，
 *    比漏掉十条都难收拾（她会在错误的日子祝生日）。正则只会漏，不会编。
 *  · 复核模型（memory-worker 的 review）仍然可以补：它走 upsertFact(source='review')，
 *    优先级低于人工，高于这里。
 *
 * 归属规则（最重要）：**只认第一人称**。「我生日是1月1」「生日是1月1」（这条消息本来就
 * 是他在说他自己）算；「他生日是1月1」不算 —— 那种句子属于别人，抽出来会挂错人。
 *
 * 隐私默认值：联系方式和住址 secret，生日/过敏 private，喜好/称呼 normal。
 * 主人在面板里可以改；注入时按级过滤（见 memory-db.js 的 formatFactsForModel）。
 */

const MONTH_DAY = '(\\d{1,2})\\s*[月\\-/\\.]\\s*(\\d{1,2})\\s*[日号]?';
const BIRTH = new RegExp('(?:我(?:的)?)?生日(?:是|在)?\\s*(?:\\d{4}\\s*年\\s*)?' + MONTH_DAY);
const BIRTH2 = new RegExp('(?:\\d{4}\\s*年\\s*)?' + MONTH_DAY + '(?:是|就?是)?我(?:的)?生日');

function cleanDate(m, d) {
  const mm = Number(m);
  const dd = Number(d);
  if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return '';
  return mm + '月' + dd + '日';
}

function tidy(text) {
  return String(text || '')
    .replace(/^[\s，,。.、~～!！?？]+/, '')
    .replace(/[\s，,。.、~～]+$/, '')
    .replace(/[。！？!?]+/g, '')
    .trim();
}

/** 抽一条「我喜欢/不吃/过敏」这类，值长度收在 2~20 字，避免把整段话吃进去。 */
function valueAfter(text, re) {
  const m = re.exec(text);
  if (!m) return '';
  const v = tidy(m[1]).slice(0, 20);
  if (v.length < 1) return '';
  // 「我不吃这个」「我喜欢你」这类没有信息量的，不收。
  if (/^(这个|那个|你|他|她|它|这样|那样|了|的|吗|呢)$/.test(v)) return '';
  if (v.length < 2) return '';
  return v;
}

const PATTERNS = [
  // 过敏（放最前：包含「不吃」时也要先判过敏）
  {
    test: (t) => valueAfter(t, /我(?:对|吃)?([^，,。；;!！?？]{1,16})过敏/),
    make: (v) => ({ kind: 'allergy', label: '过敏', text: '对' + v + '过敏', privacy: 'private', weight: 5 }),
  },
  {
    // 必须是否定式：先写成「我(?:吃|喜欢吃)…」会把「我喜欢吃辣」也记成「不吃辣」。
    test: (t) => valueAfter(t, /我(?:(?:不太|不怎么|不)(?:吃|喜欢吃|爱吃|能吃)|讨厌吃|受不了)([^，,。；;!！?？]{1,16})/),
    make: (v) => ({ kind: 'dislike', label: '不吃/讨厌', text: '不吃' + v, privacy: 'private', weight: 3 }),
  },
  {
    test: (t) => valueAfter(t, /我(?:最|很|超|挺)?(?:喜欢|爱|粉)([^，,。；;!！?？]{1,16})/),
    make: (v) => ({ kind: 'like', label: '喜欢', text: '喜欢' + v, privacy: 'normal', weight: 3 }),
  },
  {
    test: (t) => valueAfter(t, /我(?:家)?(?:住在|家在|住在|老家在)([^，,。；;!！?？]{2,16})/),
    make: (v) => ({ kind: 'address', label: '地址', text: '住在' + v, privacy: 'secret', weight: 4 }),
  },
  {
    test: (t) => valueAfter(t, /我(?:的)?(?:手机|电话|手机号|电话号码)(?:是|为)?\s*([0-9][0-9\-\s]{5,18})/),
    make: (v) => ({ kind: 'contact', label: '联系方式', text: '手机 ' + v.replace(/\s+/g, ''), privacy: 'secret', weight: 4 }),
  },
  {
    test: (t) => valueAfter(t, /(?:叫我|喊我)([^，,。；;!！?？]{1,10})(?:就行|就好|吧|好了|可以)/),
    make: (v) => ({ kind: 'nickname', label: '称呼', text: '叫他/她「' + v + '」', privacy: 'normal', weight: 3 }),
  },
];

/**
 * 抽事实。返回数组（通常 0~2 条）。
 * @param {string} raw 一条消息的正文
 */
export function extractFacts(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 400) return [];
  const out = [];
  const seen = new Set();
  const push = (f) => {
    const key = f.kind + '|' + f.label;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  // 第三人称/第二人称的生日不能记到说话人名下（「他生日是1月1」记成说话人的生日最难受）。
  const otherSubject = /(?:他|她|TA|ta|Ta|你|朋友|室友|同事|同学|室友|对象|老公|老婆|爸|妈|哥|姐|弟|妹)(?:的)?生日/;
  const m1 = otherSubject.test(text) ? null : (BIRTH.exec(text) || BIRTH2.exec(text));
  if (m1) {
    const day = cleanDate(m1[1], m1[2]);
    if (day) push({ kind: 'birthday', label: '生日', text: '生日是' + day, privacy: 'private', weight: 5 });
  }
  for (const rule of PATTERNS) {
    let v = '';
    try { v = rule.test(text); } catch { v = ''; }
    if (v) push(rule.make(v));
  }
  return out;
}

/** 一条消息值不值得再抽（挡住「嗯嗯」「哈哈哈」这类）。 */
export function looksFactful(raw) {
  const text = String(raw || '');
  if (text.length < 3) return false;
  return /生日|过敏|不吃|喜欢|爱|住在|家|手机|电话|叫我|喊我|纪念日|结婚|忌口/.test(text);
}
