// stellar_pdf 的 MCP 契约：工具存在、三个 action、错误可行动。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')],
  cwd: ROOT,
  stderr: 'pipe',
});
const client = new Client({ name: 'stellar-pdf-probe', version: '0.0.0' });
let pass = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'stellar_pdf');
  await check('工具清单含 stellar_pdf', () => assert.ok(tool));
  await check('action 三个值', () => {
    const en = tool.inputSchema?.properties?.action?.enum || [];
    assert.deepEqual(en.sort(), ['figure', 'outline', 'read']);
  });
  await check('参数覆盖章/页/图', () => {
    const p = tool.inputSchema?.properties || {};
    for (const k of ['chapter', 'page', 'pages', 'figure', 'maxChars']) assert.ok(p[k], k);
  });
  const bad = await client.callTool({ name: 'stellar_pdf', arguments: { key: 'private:0000000000', action: 'outline' } });
  await check('非主人空参数返回可行动错误', () => {
    assert.equal(bad.isError, true);
    const text = (bad.content || []).map((c) => c.text || '').join('\n');
    assert.match(text, /只有主人|主人本人|未配置 ownerQQ/);
    assert.ok(text.includes('下一步：'), text);
  });
} finally {
  try { await client.close(); } catch {}
}
console.log('\n' + pass + '/4 PASS');
if (pass !== 4) process.exitCode = 1;