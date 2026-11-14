import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-approvals-'));
process.env.STELLAR_APPROVALS_FILE = path.join(dir, 'approvals.json');
const a = await import('../src/approvals.js');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('PASS', name); }

const rec = a.createApproval({
  key: 'group:123456',
  requester: { key: 'group:123456', userId: '10001', nickname: '群友甲', groupId: '123456' },
  action: 'qzone_post',
  args: { text: '今天天气不错', right: 4, imagePath: '' },
  summary: '群友甲想发一条说说',
});
ok('create returns pending id', () => {
  assert.match(rec.requestId, /^apr_/);
  assert.equal(rec.status, 'pending');
  assert.equal(rec.argsHash, a.hashArgs(rec.args));
  assert.ok(rec.expiresAt - rec.createdAt === 30 * 60 * 1000);
});
ok('list pending has one', () => {
  const list = a.listApprovals({ status: 'pending' });
  assert.equal(list.length, 1);
  assert.equal(list[0].requestId, rec.requestId);
});
ok('approve once', () => {
  const r = a.approveApproval(rec.requestId, 'owner-qq');
  assert.equal(r.ok, true);
  assert.equal(a.getApproval(rec.requestId).status, 'approved');
});
ok('duplicate approve rejected', () => {
  const r = a.approveApproval(rec.requestId, 'owner-qq');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'duplicate');
  assert.equal(a.getApproval(rec.requestId).status, 'approved');
});
ok('claim exactly once', () => {
  const first = a.claimApproval(rec.requestId);
  assert.equal(first.ok, true);
  assert.equal(a.getApproval(rec.requestId).status, 'executing');
  const second = a.claimApproval(rec.requestId);
  assert.equal(second.ok, false);
});
ok('finish executed', () => {
  a.finishApproval(rec.requestId, { ok: true, result: 'tid=abc' });
  const got = a.getApproval(rec.requestId);
  assert.equal(got.status, 'executed');
  assert.equal(got.result, 'tid=abc');
});
ok('tamper detection', () => {
  const copy = { ...a.getApproval(rec.requestId) };
  copy.args = { ...copy.args, text: '被改过的正文' };
  assert.equal(a.verifyApproval(copy), false);
});
ok('reject pending', () => {
  const r2 = a.createApproval({ key: 'group:1', action: 'bili_comment', args: { message: 'hi' } });
  const rej = a.rejectApproval(r2.requestId, 'owner-console');
  assert.equal(rej.ok, true);
  assert.equal(a.getApproval(r2.requestId).status, 'rejected');
  assert.equal(a.approveApproval(r2.requestId).ok, false);
});
ok('image approval is consumed once', () => {
  const now = Date.now();
  const img = a.createApproval({ key: 'group:9', action: 'image_generate', args: { prompt: '橘猫' } }, now);
  assert.equal(a.hasPendingImage('group:9'), true);
  assert.equal(a.approveApproval(img.requestId, 'owner', now + 1000).ok, true);
  assert.equal(a.hasPendingImage('group:9'), false);
  const got = a.takeApprovedImage('group:9', now + 2000);
  assert.equal(got?.requestId, img.requestId);
  assert.equal(a.getApproval(img.requestId).status, 'executing');
  assert.equal(a.takeApprovedImage('group:9', now + 3000), null);
});
ok('image approval wake is marked once', () => {
  const now = Date.now();
  const img = a.createApproval({ key: 'group:10', action: 'image_generate', args: { prompt: '月亮' } }, now);
  a.approveApproval(img.requestId, 'owner', now + 1000);
  assert.equal(a.markApprovalWoken(img.requestId, now + 2000), true);
  assert.equal(a.markApprovalWoken(img.requestId, now + 3000), false);
});
ok('stale executing is recovered as failed', () => {
  const now = Date.now();
  const x = a.createApproval({ key: 'group:11', action: 'qzone_post', args: { text: 'x' } }, now);
  a.approveApproval(x.requestId, 'owner', now + 1000);
  a.claimApproval(x.requestId, now + 2000);
  const n = a.recoverStaleExecutions(now + 20 * 60 * 1000);
  assert.ok(n >= 1);
  assert.equal(a.getApproval(x.requestId).status, 'failed');
});
ok('expiry marks pending expired', () => {
  const r3 = a.createApproval({ key: 'group:2', action: 'image_generate', args: { prompt: '猫' }, ttlMs: 60_000 }, 1000);
  a.expireApprovals(1000 + 61_000);
  assert.equal(a.getApproval(r3.requestId).status, 'expired');
});
ok('approved but unconsumed expires', () => {
  const r4 = a.createApproval({ key: 'group:3', action: 'image_generate', args: { prompt: '狗' } }, 5000);
  a.approveApproval(r4.requestId, 'owner', 6000);
  a.expireApprovals(5000 + 30 * 60 * 1000 + 1);
  assert.equal(a.getApproval(r4.requestId).status, 'expired');
});
ok('private approval records targetQQ and targetSession', () => {
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ 'private:1000000005': 'session-alt' }));
  const r = a.createApproval({
    key: 'private:1000000005',
    requester: { key: 'private:1000000005', userId: '1000000005', nickname: '小号' },
    action: 'image_generate',
    args: { prompt: '月亮' },
  });
  assert.equal(r.targetKind, 'private');
  assert.equal(r.targetQQ, '1000000005');
  assert.equal(r.targetSession, 'session-alt');
});

ok('requester overrides mismatched owner key', () => {
  const r = a.createApproval({
    key: 'private:1000000001',
    requester: { key: 'private:1000000005', userId: '1000000005', nickname: '小号' },
    action: 'image_generate',
    args: { prompt: '串 key' },
  });
  assert.equal(r.targetQQ, '1000000005');
});

ok('group approval records targetGroup', () => {
  const r = a.createApproval({
    key: 'group:778899',
    requester: { key: 'group:778899', userId: '10001', groupId: '778899' },
    action: 'qzone_post',
    args: { text: 'hi' },
  });
  assert.equal(r.targetKind, 'group');
  assert.equal(r.targetGroup, '778899');
  assert.equal(r.targetQQ, '');
});

ok('audit file written', () => {
  const text = fs.readFileSync(a.APPROVALS_AUDIT, 'utf8');
  assert.match(text, /"event":"created"/);
  assert.match(text, /"event":"duplicate-approve"/);
});
ok('enabled by default', () => {
  assert.equal(a.approvalsEnabled(), true);
});
ok('disabled switch blocks new approvals', () => {
  process.env.STELLAR_APPROVALS_ENABLED = '0';
  assert.equal(a.approvalsEnabled(), false);
  assert.throws(() => a.createApproval({ key: 'group:1', action: 'bili_post', args: { text: 'x' } }), /审批已关闭/);
  delete process.env.STELLAR_APPROVALS_ENABLED;
  assert.equal(a.approvalsEnabled(), true);
});
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + passed + '/' + passed + ' approval tests passed');
