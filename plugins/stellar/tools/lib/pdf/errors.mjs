// PDF 子系统统一错误：code 给程序看，hint 给人看。
export class PdfError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'PdfError';
    this.code = code;
    this.hint = hint;
  }
}
