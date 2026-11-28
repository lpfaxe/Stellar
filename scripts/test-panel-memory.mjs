/**
 * 控制台「记忆」工作区（2026-11-27 重组）的数据契约。
 *
 * 钉住四件事：
 *  1. 概览必须带 regions/pages —— 旧版只读统计，面板拿不到记忆区和主体页；
 *  2. 记忆区按区统计话题/主体/页，数字来自实时 SQL，不是前端猜的；
 *  3. 主体页读取要带 subject/region 名，坏 JSON 的 links/sources 不能抛；
 *  4. 话题列表支持 region 过滤，切区不会把别的区混进来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-panel-memory-'));
const memDir = path.join(tmp, 'stellar', 'characters', 'deepseek', 'memory');
fs.mkdirSync(memDir, { recursive: true });
fs.mkdirSync(path.join(tmp, 'stellar', 'state'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'stellar', 'characters', 'current.json'), JSON.stringify({ id: 'deepseek', name: '测试角色' }), 'utf8');
process.env.DSH_HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.STELLAR_DATA_DIR = path.join(tmp, 'stellar');

const schema = fs.readFileSync(path.join(ROOT, 'src', 'memory-db-schema.sql'), 'utf8');
const file = path.join(memDir, 'memory.db');
const db = new DatabaseSync(file);
db.exec(schema);
const now = Date.now();
const day = new Date(now).toISOString().slice(0, 10);
for (const [code, name, desc, sort] of [
  ['region_01', 'QQ聊天', 'QQ 私聊与群聊里发生过的事', 10],
  ['region_02', '好友爱看', 'QQ 空间好友爱看里刷到的内容', 20],
  ['region_03', 'B站', 'B站视频、评论、动态里看到的内容', 30],
  ['region_04', '小镇', '鱼缸小镇里发生的事', 40],
  ['region_05', '未归类', '暂时推不出属于哪个区的旧记忆', 90],
]) db.prepare('INSERT INTO memory_region(code,name,description,sort,enabled,created_at) VALUES(?,?,?,?,1,?)').run(code, name, desc, sort, now);
db.prepare('INSERT INTO memory_subject(id,region_id,kind,external_id,name,aliases,privacy,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('su_test', 'region_01', 'user', 'owner:3025145051', '柳畔微风', '["主人"]', 'private', now, now);
db.prepare('INSERT INTO topic(id,owner_id,conversation_key,day_key,title,summary,tier,importance,facets,sentiment,msg_count,started_at,ended_at,created_at,scope,region_id,subject_id,title_source,dreamed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('tp_test', '3025145051', 'private:3025145051', day, '记忆页测试话题', '摘要', 'daily', 0, '[]', '', 2, now - 1000, now, now, 'direct', 'region_01', 'su_test', 'dream', now);
db.prepare('INSERT INTO memory_page(id,region_id,subject_id,title,body,links,sources,privacy,version,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('pg_test', 'region_01', 'su_test', '关于主人的记忆页', '她现在更愿意先看结论。', '["另一个页面"]', '[{"kind":"topic","id":"tp_test"}]', 'private', 2, now, now, 'dream');
db.close();

const mod = await import(pathToFileURL(path.join(ROOT, '..', 'stellar-manager', 'lib', 'memory-db.js')).href);

let bad = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log('  OK   ' + name + (extra ? ' — ' + extra : ''));
  else { bad++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const ov = mod.buildMemoryDb();
ok(ov.ok === true, '概览读取成功');
ok(ov.stats.pages === 1, '概览带记忆页计数', String(ov.stats.pages));
ok(ov.stats.subjects === 1, '概览带主体计数', String(ov.stats.subjects));
ok(Array.isArray(ov.regions) && ov.regions.length === 5, '五个记忆区', String(ov.regions.length));
const r1 = ov.regions.find((r) => r.code === 'region_01');
ok(r1 && r1.name === 'QQ聊天' && r1.topics === 1 && r1.subjects === 1 && r1.pages === 1, 'QQ 区实时统计', r1 ? JSON.stringify(r1) : 'missing');
ok(ov.pages.length === 1 && ov.pages[0].title === '关于主人的记忆页', '主体页标题');
ok(ov.pages[0].subjectName === '柳畔微风' && ov.pages[0].regionName === 'QQ聊天', '主体页带人和区');
ok(Array.isArray(ov.pages[0].links) && ov.pages[0].links[0] === '另一个页面', 'links JSON 已解析');
ok(Array.isArray(ov.pages[0].sources) && ov.pages[0].sources[0].id === 'tp_test', 'sources JSON 已解析');

const inRegion = mod.listTopics({ region: 'region_01', limit: 10 });
ok(inRegion.total === 1 && inRegion.items[0].regionName === 'QQ聊天', '按区过滤命中');
ok(inRegion.items[0].titleSource === 'dream', '标题来源透出');
const other = mod.listTopics({ region: 'region_03', limit: 10 });
ok(other.total === 0 && other.items.length === 0, '别的区不串');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? '\n' + bad + ' FAILED' : '\n0 FAILED');
process.exitCode = bad ? 1 : 0;
