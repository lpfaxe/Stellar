// 合并转发里的文档能不能被读到（2026-11-20）。
// 断点原本在三处：forward.js 的 file 段只留名字、桥接不登记、MCP 挡在 ownerOnly 外面。
// 这个用例锁住前两处，第三处（MCP 门控）用静态断言钉住关键分支。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatForwardResponse } from '../src/forward.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MCP = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');

const NODES = [
  {
    type: 'node',
    data: {
      name: '测试员A', uin: '1000000003', time: 1763600000,
      content: [
        { type: 'text', data: { text: '这是我整理的季度报告，你帮我看看结论' } },
        { type: 'file', data: { name: '季度报告.docx', file_id: 'FID-DOCX-1', size: 20480, file_hash: 'HASH1' } }
      ]
    }
  },
  {
    type: 'node',
    data: {
      name: '示例好友', uin: '1000000004', time: 1763600060,
      content: [
        { type: 'text', data: { text: '还有个表' } },
        { type: 'file', data: { name: '预算.xlsx', file_id: 'FID-XLSX-1', size: 8192 } }
      ]
    }
  }
];

// ── 1) 纯函数：文件段要被收集出来，正文仍保留 [文件 …] 提示 ──────────────
{
  const out = formatForwardResponse({ messages: NODES });
  assert.equal(out.messages.length, 2, '两条节点');
  const first = out.messages[0];
  assert.equal(first.files?.length, 1, '第一条带一个文件');
  assert.equal(first.files[0].name, '季度报告.docx');
  assert.equal(first.files[0].fileId, 'FID-DOCX-1');
  assert.equal(first.files[0].size, 20480);
  assert.equal(first.files[0].fileHash, 'HASH1');
  assert.match(first.text, /\[文件/, '正文里仍要有 [文件 …] 占位');
  assert.equal(out.messages[1].files[0].name, '预算.xlsx');
  // 没有文件的节点不硬塞空数组（省 token，也免得下游把 undefined 当有文件）
  const plain = formatForwardResponse({ messages: [{ type: 'node', data: { name: 'A', content: [{ type: 'text', data: { text: 'hi' } }] } }] });
  assert.equal('files' in plain.messages[0], false, '没有文件时不要带 files 字段');
  console.log('  ok 1/5 文件段被收集 + 正文占位保留');
}

// ── 2) 桥接读转发：附件点名 + 登记 forwardFiles + 落盘 ──────────────────
{
  const h = await bridgeHarness({ forwards: { 'fwd-1': NODES } });
  try {
    const block = await h.forwardDigestBlock('group:456', ['fwd-1']);
    assert.match(block.text, /合并转发的聊天记录 fwd-1/, '要有转发块标题');
    assert.match(block.text, /附件：季度报告\.docx/, '附件要在正文里点名');
    assert.match(block.text, /这条转发里有 2 个文件/, '要点出文件总数');
    assert.match(block.text, /stellar_file_read\(key=本会话, forwardId="fwd-1"/, '要给出怎么读的指引');
    const st = h.getSocialV2State('group:456');
    assert.equal(st.forwardFiles.length, 2, '两个文件都登记了');
    assert.equal(st.forwardFiles[0].name, '季度报告.docx');
    assert.equal(st.forwardFiles[0].forwardId, 'fwd-1');
    assert.equal(st.forwardFiles[0].fileId, 'FID-DOCX-1');
    // MCP 是另一个进程，读的是磁盘上那份 → 必须真的落盘
    const disk = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
    const files = disk.conversations['group:456']?.forwardFiles ?? [];
    assert.equal(files.length, 2, 'forwardFiles 要写进 social-v2.json');
    assert.ok(files.some((f) => f.name === '预算.xlsx' && f.fileId === 'FID-XLSX-1'));
    console.log('  ok 2/5 读转发时登记附件并落盘');
  } finally { await h.close(); }
}

// ── 3) 同一份转发读第二次不再重复贴正文（原有行为不能被这次改动破坏）────
{
  const h = await bridgeHarness({ forwards: { 'fwd-2': NODES } });
  try {
    await h.forwardDigestBlock('group:456', ['fwd-2']);
    const again = await h.forwardDigestBlock('group:456', ['fwd-2']);
    assert.match(again.text, /之前已经贴过/, '第二次要提示已贴过');
    console.log('  ok 3/5 重复读取仍去重');
  } finally { await h.close(); }
}

// ── 4) 没文件时不能凭空造 hint ───────────────────────────────────────
{
  const h = await bridgeHarness({ forwards: { 'fwd-3': [{ type: 'node', data: { name: 'A', content: [{ type: 'text', data: { text: '纯文字' } }] } }] } });
  try {
    const block = await h.forwardDigestBlock('group:456', ['fwd-3']);
    assert.ok(!/这条转发里有 \d+ 个文件/.test(block.text), '没有文件就不要提文件');
    const st = h.getSocialV2State('group:456');
    assert.equal(st.forwardFiles.length, 0, '没有文件就不该登记');
    console.log('  ok 4/5 无文件时不制造提示');
  } finally { await h.close(); }
}

// ── 5) MCP 侧门控：非主人只读转发里的文件，下载走通用 get_file ───────────
{
  assert.match(MCP, /forwardId: z\.string\(\)/, 'stellar_file_read 要有 forwardId 参数');
  assert.match(MCP, /fileId: z\.string\(\)/, 'stellar_file_read 要有 fileId 参数');
  assert.match(MCP, /fromForward !== true/, '非主人读非转发文件必须被拒');
  assert.match(MCP, /ident\.key !== keyStr/, '非主人必须用会话令牌确认是自己的会话');
  assert.match(MCP, /onebot\('get_file'/, '群里的文件要走通用 get_file 取下载地址');
  assert.match(MCP, /allowOwnerFallback: isOwner/, '非主人不能回退到主人私聊的取址接口');
  assert.match(MCP, /conv\.forwardFiles/, 'findFileEntry 要能查到转发文件');
  assert.ok(MCP.includes("server.tool(\n  'stellar_file_read'") || MCP.includes("'stellar_file_read'"), '工具仍注册');
  console.log('  ok 5/5 MCP 门控与取址分支');
}

console.log('test-forward-files: ALL PASS (5 groups)');