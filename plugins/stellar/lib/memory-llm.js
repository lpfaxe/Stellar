/**
 * 记忆库的模型通道（P1）。
 *
 * 为什么放插件侧：复核与侧写都要调模型，而插件是唯一同时拿得到 ctx.get('llm') 与
 * tokenBudget 的地方（persona-classify.js 用的同一套）。桥接是消息链路，不在这里插调用。
 *
 * 为什么不新起一个 DSH 会话：会话要写盘、要在侧栏里出现、还要被 run-mode/生物钟影响；
 * 一次后台复核没必要背这些。直接调 llm.stream 等于「一次不进入对话史的模型调用」，
 * 花的是同一个模型的同一份价格，但不会污染她的上下文，也不会被她的人格带跑。
 */
export function createMemoryAsk({ ctx, tokenBudget = null, log = () => {} } = {}) {
  function resolveModel() {
    try {
      const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null;
      const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null;
      const provider = String((selection && selection.provider) || '').trim();
      const model = String((selection && selection.model) || '').trim();
      return provider && model ? { provider, model } : null;
    } catch {
      return null;
    }
  }

  function available() {
    try {
      const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null;
      return Boolean(llm && llm.stream) && Boolean(resolveModel());
    } catch {
      return false;
    }
  }

  /**
   * @param {{system?:string,user:string,maxTokens?:number,reasoningEffort?:string,label?:string}} args
   * @returns {Promise<string>} 模型文本（已 trim）
   */
  async function ask(args = {}) {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null;
    if (!llm || !llm.stream) {
      const error = new Error('DSH 模型服务不可用');
      error.code = 'MEMORY_LLM_UNAVAILABLE';
      throw error;
    }
    const target = resolveModel();
    if (!target) {
      const error = new Error('读不到 DSH 默认模型');
      error.code = 'MEMORY_LLM_NO_MODEL';
      throw error;
    }
    const base = {
      provider: target.provider,
      model: target.model,
      system: String(args.system || ''),
      messages: [{ role: 'user', content: [{ type: 'text', text: String(args.user || '') }] }],
      maxTokens: Math.max(128, Math.min(4000, Number(args.maxTokens) || 1200)),
      temperature: 0.2,
    };
    if (args.reasoningEffort) base.reasoningEffort = String(args.reasoningEffort);

    let text = '';
    let usage = null;
    const stream = llm.stream(base);
    for await (const chunk of stream) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta' && chunk.text) text += chunk.text;
      else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
      else if (chunk.type === 'finish') {
        const kind = chunk.reason && chunk.reason.kind;
        if (kind === 'error' || kind === 'aborted') {
          throw new Error((chunk.reason && chunk.reason.failure && chunk.reason.failure.message) || (kind === 'aborted' ? '模型调用被取消' : '模型调用失败'));
        }
      }
    }
    if (!text.trim()) {
      const error = new Error('模型没有返回内容');
      error.code = 'MEMORY_LLM_EMPTY';
      throw error;
    }
    if (tokenBudget && typeof tokenBudget.recordExternalUsage === 'function' && usage) {
      try {
        tokenBudget.recordExternalUsage({
          category: 'other', sessionId: 'memory-worker', model: target.model, usage,
          at: Date.now(), label: String(args.label || '记忆库后台作业'),
        });
      } catch (error) {
        log('[memory] 记账失败：' + String((error && error.message) || error).slice(0, 120));
      }
    }
    return text.trim();
  }

  return { ask, available, resolveModel };
}
