// 化学结构式单测：中文别名、查询顺序、PubChem 解析与缓存。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAlias, isCasNumber, stripDosageForm, aliasCount } from '../plugins/stellar/tools/lib/webimg/chem/aliases.mjs';
import { structureQueries, resolveCids, getStructure } from '../plugins/stellar/tools/lib/webimg/chem/pubchem.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webimg-chem-'));
process.env.DSH_HOME = home;

let pass = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => body };
}

await check('中文别名与 CAS', () => {
  assert.ok(aliasCount() >= 100);
  const a = resolveAlias('阿司匹林肠溶片');
  assert.equal(a.cas, '50-78-2'); assert.equal(a.nameEn, 'aspirin');
  assert.equal(stripDosageForm('阿司匹林肠溶片'), '阿司匹林');
  assert.equal(isCasNumber('50-78-2'), true);
  assert.equal(resolveAlias('不存在的药名xyz'), null);
});

await check('structureQueries 先 CAS/别名，再非中文原名', () => {
  const q = structureQueries({ name: '阿司匹林' });
  assert.equal(q[0].value, '50-78-2');
  assert.ok(q.some((x) => x.field === 'name' && x.value === 'aspirin'));
  assert.ok(!q.some((x) => x.value === '阿司匹林'));
  const q2 = structureQueries({ cas: '50-78-2', smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O' });
  assert.equal(q2[0].field, 'smiles');
});

await check('resolveCids 解析 CID 列表', async () => {
  const calls = [];
  const mock = async (url) => { calls.push(url); return response({ IdentifierList: { CID: [2244, 9999] } }); };
  const r = await resolveCids({ name: '阿司匹林' }, { fetchImpl: mock });
  assert.equal(r.ok, true); assert.deepEqual(r.cids, [2244, 9999]);
  assert.match(calls[0], /compound\/name\/50-78-2\/cids/);
});

await check('resolveCids 404 后回退下一个候选', async () => {
  let n = 0;
  const mock = async () => { n += 1; return n === 1 ? response({}, 404) : response({ IdentifierList: { CID: [2244] } }); };
  const r = await resolveCids({ name: '阿司匹林' }, { fetchImpl: mock });
  assert.equal(r.ok, true); assert.deepEqual(r.cids, [2244]); assert.equal(n, 2);
});

await check('resolveCids 全查不到返回 NEED_IDENTIFIER', async () => {
  const r = await resolveCids({ name: '不存在的中文药名' }, { fetchImpl: async () => response({}, 404) });
  assert.equal(r.ok, false); assert.equal(r.code, 'NEED_IDENTIFIER');
});

await check('getStructure 下载 1000px PNG 并缓存', async () => {
  let n = 0;
  const mock = async (url) => { n += 1; return /\/cids\//.test(url) ? response({ IdentifierList: { CID: [2244] } }) : response(png(1000, 1000)); };
  const r = await getStructure({ name: '阿司匹林' }, { fetchImpl: mock, useCache: false });
  assert.equal(r.ok, true); assert.equal(r.cid, 2244); assert.equal(r.width, 1000); assert.equal(r.cached, false);
  assert.ok(fs.existsSync(r.file));
  const r2 = await getStructure({ name: '阿司匹林' }, { fetchImpl: mock, useCache: true });
  assert.equal(r2.ok, true); assert.equal(r2.cached, true);
});

console.log('\n' + pass + '/6 PASS');
if (pass !== 6) process.exitCode = 1;
fs.rmSync(home, { recursive: true, force: true });
