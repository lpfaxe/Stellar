// stellar_web_image 的 MCP 契约：三模式与 chemical 子字段。
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
const client = new Client({ name: 'stellar-web-image-probe', version: '0.0.0' });
let pass = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'stellar_web_image');
  await check('工具清单含 stellar_web_image', () => assert.ok(tool));
  await check('mode 覆盖 auto/structure/product/photo', () => {
    const en = tool.inputSchema?.properties?.mode?.enum || [];
    assert.deepEqual(en.sort(), ['auto', 'photo', 'product', 'structure']);
  });
  await check('chemical 子字段含 name/cas/strength/manufacturer', () => {
    const p = tool.inputSchema?.properties?.chemical?.properties || {};
    for (const k of ['name', 'nameEn', 'cas', 'smiles', 'manufacturer', 'brand', 'strength', 'dosageForm']) assert.ok(p[k], k);
  });
  await check('描述写明结构式不要用生图', () => {
    assert.match(String(tool.description || ''), /结构式|PubChem/);
  });
  await check('action 覆盖 search/list/del/clear/path/pick', () => {
    const en = tool.inputSchema?.properties?.action?.enum || [];
    for (const k of ['search', 'list', 'del', 'clear', 'path', 'pick']) assert.ok(en.includes(k), k);
  });
  await check('schema 有 preload/session/picks', () => {
    const p = tool.inputSchema?.properties || {};
    assert.ok(p.preload, 'preload');
    assert.ok(p.session, 'session');
    assert.ok(p.picks, 'picks');
    assert.match(String(p.preload.description || ''), /30|100/);
  });
  await check('描述写明预加载/联系表/只有 pick 占额度', () => {
    const d = String(tool.description || '');
    assert.match(d, /预加载|preload/);
    assert.match(d, /联系表/);
    assert.match(d, /pick/);
  });
} finally {
  try { await client.close(); } catch {}
}
console.log('\n' + pass + '/7 PASS');
if (pass !== 7) process.exitCode = 1;
