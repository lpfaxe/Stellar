// 绘图工具的统一错误类型：code 给程序判断，hint 给人下一步。
export class DiagramError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'DiagramError';
    this.code = code;
    this.hint = hint;
  }
}
