// 表达式解析与求值（绘图专用，**不用 eval / new Function**）
//
// 支持：
//   · 变量：x（一元函数）、t（参数方程）、theta（极坐标）；由调用方限定
//   · 常量：pi、e
//   · 运算符：+ - * / ^、比较 < <= > >= == !=（只用于 if 条件）
//   · 函数：sin cos tan asin acos atan sinh cosh tanh sec csc cot
//           sqrt abs exp ln lg log floor ceil round sign min max pow
//           if(cond, a, b) 惰性求值，用来画分段函数
//   · 隐式乘法：2x、2(x+1)、(x+1)(x-1)、x sin(x)
//
// 安全边界：输入先过字符白名单（tokenizer 只认固定字符），拒绝属性访问、引号、
// 分号、方括号、花括号；长度、token 数、AST 节点数都有上限。

const MAX_SOURCE = 200;
const MAX_TOKENS = 400;
const MAX_NODES = 400;
const MAX_DEPTH = 40;

export class ExprError extends Error {
  constructor(message, code = 'EXPR_INVALID') {
    super(message);
    this.name = 'ExprError';
    this.code = code;
  }
}

const FUNCTIONS = new Map([
  ['sin', { min: 1, max: 1, fn: (a) => Math.sin(a[0]) }],
  ['cos', { min: 1, max: 1, fn: (a) => Math.cos(a[0]) }],
  ['tan', { min: 1, max: 1, fn: (a) => Math.tan(a[0]) }],
  ['asin', { min: 1, max: 1, fn: (a) => Math.asin(a[0]) }],
  ['acos', { min: 1, max: 1, fn: (a) => Math.acos(a[0]) }],
  ['atan', { min: 1, max: 1, fn: (a) => Math.atan(a[0]) }],
  ['sinh', { min: 1, max: 1, fn: (a) => Math.sinh(a[0]) }],
  ['cosh', { min: 1, max: 1, fn: (a) => Math.cosh(a[0]) }],
  ['tanh', { min: 1, max: 1, fn: (a) => Math.tanh(a[0]) }],
  ['sec', { min: 1, max: 1, fn: (a) => 1 / Math.cos(a[0]) }],
  ['csc', { min: 1, max: 1, fn: (a) => 1 / Math.sin(a[0]) }],
  ['cot', { min: 1, max: 1, fn: (a) => 1 / Math.tan(a[0]) }],
  ['sqrt', { min: 1, max: 1, fn: (a) => Math.sqrt(a[0]) }],
  ['abs', { min: 1, max: 1, fn: (a) => Math.abs(a[0]) }],
  ['exp', { min: 1, max: 1, fn: (a) => Math.exp(a[0]) }],
  ['ln', { min: 1, max: 1, fn: (a) => Math.log(a[0]) }],
  ['lg', { min: 1, max: 1, fn: (a) => Math.log10(a[0]) }],
  ['log', { min: 1, max: 2, fn: (a) => a.length === 1 ? Math.log10(a[0]) : Math.log(a[0]) / Math.log(a[1]) }],
  ['floor', { min: 1, max: 1, fn: (a) => Math.floor(a[0]) }],
  ['ceil', { min: 1, max: 1, fn: (a) => Math.ceil(a[0]) }],
  ['round', { min: 1, max: 1, fn: (a) => Math.round(a[0]) }],
  ['sign', { min: 1, max: 1, fn: (a) => Math.sign(a[0]) }],
  ['min', { min: 1, max: Infinity, fn: (a) => Math.min(...a) }],
  ['max', { min: 1, max: Infinity, fn: (a) => Math.max(...a) }],
  ['pow', { min: 2, max: 2, fn: (a) => Math.pow(a[0], a[1]) }],
  ['if', { min: 3, max: 3, lazy: true }],
]);

const CONSTANTS = new Map([
  ['pi', Math.PI],
  ['e', Math.E],
]);

const ALLOWED_VARIABLES = new Set(['x', 't', 'theta', 'y']);

function normalizeSource(source) {
  return String(source ?? '')
    .replace(/π/g, 'pi')
    .replace(/θ/g, 'theta')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .trim();
}

function tokenize(source) {
  const src = normalizeSource(source);
  if (!src) throw new ExprError('表达式为空', 'EXPR_EMPTY');
  if (src.length > MAX_SOURCE) throw new ExprError('表达式太长（最多 ' + MAX_SOURCE + ' 个字符）', 'EXPR_TOO_LONG');
  const tokens = [];
  let i = 0;
  const push = (type, value, at) => {
    tokens.push({ type, value, at });
    if (tokens.length > MAX_TOKENS) throw new ExprError('表达式过于复杂（token 超过 ' + MAX_TOKENS + '）', 'EXPR_TOO_COMPLEX');
  };
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      const rest = src.slice(i);
      const m = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!m) throw new ExprError('数字格式不正确（位置 ' + (i + 1) + '）', 'EXPR_NUMBER');
      const text = m[0];
      const n = Number(text);
      if (!Number.isFinite(n)) throw new ExprError('数字超出范围：' + text, 'EXPR_NUMBER');
      push('num', n, i);
      i += text.length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      const text = m[0];
      push('id', text, i);
      i += text.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      push('cmp', two, i); i += 2; continue;
    }
    if ('+-*/^'.includes(ch)) { push('op', ch, i); i += 1; continue; }
    if (ch === '<' || ch === '>') { push('cmp', ch, i); i += 1; continue; }
    if (ch === '(') { push('lp', ch, i); i += 1; continue; }
    if (ch === ')') { push('rp', ch, i); i += 1; continue; }
    if (ch === ',') { push('comma', ch, i); i += 1; continue; }
    // 明确拒绝危险/未知字符，错误里给位置，方便模型改。
    throw new ExprError('表达式里有不支持的字符 "' + ch + '"（位置 ' + (i + 1) + '）；只允许数字、x/t/theta、函数名和 + - * / ^ ( ) , 比较符', 'EXPR_CHAR');
  }
  push('eof', '', src.length);
  return tokens;
}

class Parser {
  constructor(tokens, variables) {
    this.tokens = tokens;
    this.pos = 0;
    this.variables = variables;
    this.nodes = 0;
    this.depth = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { const t = this.tokens[this.pos]; this.pos += 1; return t; }
  expect(type, what) {
    const t = this.peek();
    if (t.type !== type) throw new ExprError('这里需要 ' + what + '（位置 ' + (t.at + 1) + '）', 'EXPR_SYNTAX');
    return this.next();
  }
  count(node) {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new ExprError('表达式过于复杂（AST 节点超过 ' + MAX_NODES + '）', 'EXPR_TOO_COMPLEX');
    return node;
  }
  parse() {
    const node = this.parseComparison();
    const t = this.peek();
    if (t.type !== 'eof') throw new ExprError('表达式末尾有多余内容（位置 ' + (t.at + 1) + '）', 'EXPR_SYNTAX');
    return node;
  }
  parseComparison() {
    let left = this.parseAdd();
    while (this.peek().type === 'cmp') {
      const op = this.next().value;
      const right = this.parseAdd();
      left = this.count({ k: 'cmp', op, left, right });
    }
    return left;
  }
  parseAdd() {
    let left = this.parseMul();
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.parseMul();
      left = this.count({ k: 'bin', op, left, right });
    }
    return left;
  }
  parseMul() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '*' || t.value === '/')) {
        this.next();
        const right = this.parseUnary();
        left = this.count({ k: 'bin', op: t.value, left, right });
        continue;
      }
      // 隐式乘法：下一个 token 能开始一个 primary 就乘
      if (t.type === 'num' || t.type === 'id' || t.type === 'lp') {
        const right = this.parseUnary();
        left = this.count({ k: 'bin', op: '*', left, right });
        continue;
      }
      return left;
    }
  }
  parseUnary() {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
      this.next();
      if (this.depth > MAX_DEPTH) throw new ExprError('表达式嵌套太深', 'EXPR_TOO_COMPLEX');
      this.depth += 1;
      try {
        const inner = this.parseUnary();
        return this.count({ k: t.value === '-' ? 'neg' : 'pos', a: inner });
      } finally { this.depth -= 1; }
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePrimary();
    if (this.peek().type === 'op' && this.peek().value === '^') {
      this.next();
      const exp = this.parseUnary();
      return this.count({ k: 'bin', op: '^', left: base, right: exp });
    }
    return base;
  }
  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') { this.next(); return this.count({ k: 'num', v: t.value }); }
    if (t.type === 'lp') {
      this.next();
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new ExprError('表达式嵌套太深', 'EXPR_TOO_COMPLEX');
      try {
        const node = this.parseComparison();
        this.expect('rp', '右括号 )');
        return node;
      } finally { this.depth -= 1; }
    }
    if (t.type === 'id') {
      const id = this.next().value;
      if (this.peek().type === 'lp') {
        const def = FUNCTIONS.get(id);
        if (!def) throw new ExprError('未知函数：' + id, 'EXPR_FUNCTION');
        this.next();
        const args = [];
        if (this.peek().type !== 'rp') {
          for (;;) {
            args.push(this.parseComparison());
            if (this.peek().type === 'comma') { this.next(); continue; }
            break;
          }
        }
        this.expect('rp', '函数 ' + id + ' 的右括号 )');
        if (args.length < def.min || args.length > def.max) {
          const want = def.min === def.max ? String(def.min) : (def.max === Infinity ? '至少 ' + def.min : def.min + '–' + def.max);
          throw new ExprError('函数 ' + id + ' 需要 ' + want + ' 个参数，实际给了 ' + args.length + ' 个', 'EXPR_ARITY');
        }
        return this.count({ k: 'call', name: id, args });
      }
      if (FUNCTIONS.has(id)) {
        throw new ExprError('函数 ' + id + ' 需要括号，例如 ' + id + '(x)', 'EXPR_FUNCTION');
      }
      if (CONSTANTS.has(id)) return this.count({ k: 'num', v: CONSTANTS.get(id) });
      if (ALLOWED_VARIABLES.has(id)) {
        if (!this.variables.has(id)) {
          throw new ExprError('变量 ' + id + ' 在当前图里不可用；这里只能用 ' + [...this.variables].join('/'), 'EXPR_VARIABLE');
        }
        return this.count({ k: 'var', name: id });
      }
      throw new ExprError('未知标识符：' + id, 'EXPR_NAME');
    }
    throw new ExprError('这里需要一个数字、变量或函数（位置 ' + (t.at + 1) + '）', 'EXPR_SYNTAX');
  }
}

function evaluate(node, vars) {
  switch (node.k) {
    case 'num': return node.v;
    case 'var': return vars[node.name];
    case 'neg': return -evaluate(node.a, vars);
    case 'pos': return evaluate(node.a, vars);
    case 'bin': {
      const a = evaluate(node.left, vars);
      const b = evaluate(node.right, vars);
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return Math.pow(a, b);
        default: return NaN;
      }
    }
    case 'cmp': {
      const a = evaluate(node.left, vars);
      const b = evaluate(node.right, vars);
      switch (node.op) {
        case '<': return a < b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        default: return 0;
      }
    }
    case 'call': {
      const def = FUNCTIONS.get(node.name);
      if (!def) return NaN;
      if (def.lazy) {
        const cond = evaluate(node.args[0], vars);
        return cond ? evaluate(node.args[1], vars) : evaluate(node.args[2], vars);
      }
      return def.fn(node.args.map((arg) => evaluate(arg, vars)));
    }
    default: return NaN;
  }
}

/**
 * 编译表达式。
 * @param {string} source
 * @param {{variables: string[]|Set<string>}} options
 * @returns {{source:string, variables:string[], ast:object, eval:(vars:Record<string,number>)=>number}}
 */
export function compileExpression(source, { variables = ['x'] } = {}) {
  const vars = new Set((Array.isArray(variables) ? variables : [variables]).map(String));
  for (const v of vars) {
    if (!ALLOWED_VARIABLES.has(v)) throw new ExprError('不支持的变量：' + v, 'EXPR_VARIABLE');
  }
  if (!vars.size) throw new ExprError('至少需要一个变量', 'EXPR_VARIABLE');
  const trimmed = normalizeSource(source);
  // 允许 y= / f(x)= 前缀：模型很自然会带。
  const body = trimmed.replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, '');
  const tokens = tokenize(body);
  const ast = new Parser(tokens, vars).parse();
  return {
    source: body,
    variables: [...vars],
    ast,
    eval: (values) => evaluate(ast, values && typeof values === 'object' ? values : {}),
  };
}

/** 给测试/错误提示用：不编译，只检查一个表达式是否能被接受。 */
export function validateExpression(source, options) {
  compileExpression(source, options);
  return true;
}

export const EXPR_FUNCTION_NAMES = Object.freeze([...FUNCTIONS.keys()]);
