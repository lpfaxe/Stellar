// 找图搜索层单测：Bing m= 属性解析、百度 acjson 解析。
import assert from 'node:assert/strict';
import { parseBingResults, decodeEntities } from '../plugins/stellar/tools/lib/webimg/search-bing.mjs';
import { parseBaiduResults } from '../plugins/stellar/tools/lib/webimg/search-baidu.mjs';

let pass = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

check('decodeEntities 只解五个基础实体', () => {
  assert.equal(decodeEntities('a&quot;b&amp;c&#39;d&lt;e&gt;f'), 'a"b&c\'d<e>f');
});

check('parseBingResults 取 murl/purl/turl/t 并跳过 svg/gif/重复', () => {
  const one = JSON.stringify({ murl: 'https://img.example.com/a.jpg', purl: 'https://page.example.com/1', turl: 'https://thumb.example.com/a.jpg', t: '雪山 风景' }).replace(/"/g, '&quot;');
  const gif = JSON.stringify({ murl: 'https://img.example.com/b.gif', purl: 'https://page.example.com/2', t: 'gif' }).replace(/"/g, '&quot;');
  const dup = JSON.stringify({ murl: 'https://img.example.com/a.jpg', purl: 'https://page.example.com/3', t: 'dup' }).replace(/"/g, '&quot;');
  const html = '<a m="' + one + '"></a><a m="' + gif + '"></a><a m="' + dup + '"></a>';
  const out = parseBingResults(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://img.example.com/a.jpg');
  assert.equal(out[0].page, 'https://page.example.com/1');
  assert.equal(out[0].title, '雪山 风景');
});

check('parseBaiduResults 优先 replaceUrl 原图与真实尺寸', () => {
  const payload = { data: [
    { replaceUrl: [{ ObjURL: 'https://q5.example.com/original.jpg', FromURL: 'https://news.example.com/a' }], middleURL: 'https://img.example.com/mid.jpg', thumbURL: 'https://img.example.com/thumb.jpg', fromPageTitleEnc: '雪山下的瑞士小镇', width: 1080, height: 1920 },
    { replaceUrl: [{ ObjURL: 'https://q5.example.com/b.gif' }], middleURL: 'https://img.example.com/b.gif', fromPageTitle: 'gif', width: 300, height: 300 },
    { replaceUrl: [{ ObjURL: 'https://q5.example.com/original.jpg' }], middleURL: 'https://img.example.com/dup.jpg', fromPageTitle: 'dup', width: 100, height: 100 }
  ] };
  const out = parseBaiduResults(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://q5.example.com/original.jpg');
  assert.equal(out[0].page, 'https://news.example.com/a');
  assert.equal(out[0].width, 1080);
  assert.equal(out[0].height, 1920);
  assert.equal(out[0].title, '雪山下的瑞士小镇');
});

console.log('\n' + pass + '/3 PASS');
if (pass !== 3) process.exitCode = 1;
