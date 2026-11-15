/**
 * 回复条数概率（拟人化第①条）：按场景给出这次该回几条，写进提示词。
 * 只影响提示词里的建议，不改变发送能力；语义单元仍由她自己合并。
 */
export const DEFAULT_REPLY_PROB = {
  private: [0.55, 0.35, 0.1],   // 1 条 / 2 条 / 3 条
  owner: [0.5, 0.38, 0.12],
  group: [0.62, 0.3, 0.08],           // 1 条 / 2 条 / 3 条（原 0.8/0.18/0.02 太容易压成一句）
  question: [0.35, 0.45, 0.2],
  long: [0.4, 0.42, 0.18],
};

function pick(weights, rand) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let r = rand() * total;
  for (let i = 0; i < weights.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return i + 1;
  }
  return 1;
}

export function planReplyCount({ kind = 'private', isOwner = false, isQuestion = false, messageLen = 0, rand = Math.random } = {}) {
  const len = Math.max(0, Number(messageLen) || 0);
  let weights = kind === 'group' ? DEFAULT_REPLY_PROB.group : isOwner ? DEFAULT_REPLY_PROB.owner : DEFAULT_REPLY_PROB.private;
  let why = kind === 'group' ? '群聊' : '私聊';
  if (isQuestion) { weights = DEFAULT_REPLY_PROB.question; why = '对方在问问题'; }
  else if (len >= 80) { weights = DEFAULT_REPLY_PROB.long; why = '对方说了一大段'; }
  const count = pick(weights, typeof rand === 'function' ? rand : Math.random);
  return { count, label: count + ' 条', why, weights };
}

export function replyPlanLine(plan) {
  if (!plan || !plan.count) return '';
  return '【本次回复条数】建议这次回 ' + plan.label
    + '（' + plan.why + '；一条 = 一个语义单元，别把一句话拆成多条刷屏，也别把两三件事硬塞进一条）。\n\n';
}
