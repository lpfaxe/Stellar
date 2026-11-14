// stellar_file_read 的两道闸：本地路径白名单 + URL 只许公网。
//
// 为什么单独一个模块：这两条规则要能被回归脚本直接 import 测（MCP 那个文件只能靠 vm
// 整体加载，vm 里的 dynamic import 还要 --experimental-vm-modules，太重）。
//
// 修前（2026-11-13 前）：path 只要 isAbsolute 就直接采信（能读 ~/.dsh/.credentials.yaml），
// url 直接 fetch（实测能打到 127.0.0.1:3300/api/status 拿到含明文口令的 200）。
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 明文密钥类文件一律不给读：读进上下文就可能被复述出去。
export const FILE_READ_DENY_RE = /^(?:\.credentials.*|credentials\.json|panel-token.*|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.env.*|.*\.env)$/i;

/** 允许读的根：DSH 工作区、stellar 仓库、~/.dsh/stellar、系统临时目录。 */
export function fileReadRoots({ workspaceRoot, stellarRoot, dshHome }) {
  const roots = [];
  const push = (label, dir) => {
    try { roots.push({ label, dir: fsSync.realpathSync(dir) }); } catch { /* 不存在就跳过 */ }
  };
  push('工作区', workspaceRoot);
  push('stellar', stellarRoot);
  push('DSH', path.join(dshHome, 'stellar'));
  push('临时目录', os.tmpdir());
  return roots;
}

export function insideRoot(real, dir) {
  const rel = path.relative(dir, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 把用户给的 path 解析成真实路径；不在白名单里就抛（错误文案要可行动）。 */
export function assertReadableLocalPath(wantedPath, { workspaceRoot, stellarRoot, dshHome }) {
  const raw = String(wantedPath || '').trim();
  if (!raw) throw new Error('path 是空的');
  const abs = path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot, raw);
  let real;
  try { real = fsSync.realpathSync(abs); } catch { throw new Error('读不到这个路径：' + raw); }
  const name = path.basename(real);
  if (FILE_READ_DENY_RE.test(name)) throw new Error('这个文件是密钥/凭据，不能读：' + name);
  const roots = fileReadRoots({ workspaceRoot, stellarRoot, dshHome });
  if (!roots.some(({ dir }) => insideRoot(real, dir))) {
    throw new Error(
      '这个路径不在可读范围内：' + real + '\n' +
      '只能读这几个目录里的文件：' + roots.map((r) => r.dir).join('、') + '\n' +
      '要读别处的文件，先让主人把它发到 QQ 里，再用 messageId 读。'
    );
  }
  return real;
}

/** 内网/本机地址判定（字面量）。 */
export function isPrivateAddress(ip) {
  const v = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!v) return true;
  if (v === '::1' || v === '::' || v === '0.0.0.0') return true;
  if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;   // 链路本地 / ULA
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;             // 云厂商 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
  return false;
}

/** 只放行公网 http(s)：字面量 + DNS 解析结果都查（防「公网域名解析到 127.0.0.1」）。 */
export async function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '').trim()); } catch { throw new Error('url 不是合法地址：' + rawUrl); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http(s) 链接');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('url 没有主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不能读本机/内网地址：' + host);
  }
  if (isPrivateAddress(host)) throw new Error('不能读本机/内网地址：' + host);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const dns = await import('node:dns/promises');
    let addrs = [];
    try { addrs = await dns.lookup(host, { all: true }); } catch { addrs = []; }
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad) throw new Error('这个域名指向内网地址（' + bad.address + '），不能读');
  }
  return u.toString();
}
