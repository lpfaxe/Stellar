// 找图排序单测：标题相关度、可信来源、尺寸/比例过滤。
import assert from 'node:assert/strict';
import { queryTerms, preRank, rankDownloaded, acceptableImage, isTrustedProductHost, isTrustedPhotoHost, hostOf } from '../plugins/stellar/tools/lib/webimg/rank.mjs';

let pass = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

check('queryTerms 拆中英文并去停用词', () => {
  assert.deepEqual(queryTerms('雪山 小镇 风景'), ['雪山', '小镇', '风景']);
  assert.ok(queryTerms('aspirin 100mg 药盒').includes('aspirin'));
  assert.ok(!queryTerms('高清 图片').includes('高清'));
});

check('preRank 相关标题排在无关大图前', () => {
  const rows = [
    { url: 'https://img.example.com/big.jpg', page: 'https://blog.csdn.net/x', title: '数据可视化错误类型' },
    { url: 'https://img.example.com/snow.jpg', page: 'https://news.example.com/x', title: '雪山下的瑞士小镇' }
  ];
  const out = preRank(rows, { query: '雪山 小镇 风景' });
  assert.equal(out[0].title, '雪山下的瑞士小镇');
  assert.ok(out[0].preScore > out[1].preScore);
});

check('preRank 可信来源加分、坏来源减分', () => {
  const rows = [
    { url: 'https://mm.bing.net/x.jpg', page: 'https://mm.bing.net/x', title: '测试' },
    { url: 'https://img.example.com/x.jpg', page: 'https://www.nmpa.gov.cn/x', title: '测试' }
  ];
  const out = preRank(rows, { query: '测试', trustedHost: isTrustedProductHost });
  assert.equal(out[0].page, 'https://www.nmpa.gov.cn/x');
});

check('rankDownloaded 小相关图胜过大无关图', () => {
  const rows = [
    { file: 'a', width: 3000, height: 2000, bytes: 900000, title: '医院门诊流线设计', page: 'https://blog.csdn.net/x' },
    { file: 'b', width: 1080, height: 1350, bytes: 200000, title: '雪山下的瑞士小镇', page: 'https://news.example.com/x' }
  ];
  const out = rankDownloaded(rows, { query: '雪山 小镇 风景' });
  assert.equal(out[0].file, 'b');
});

check('acceptableImage 拒绝缩略图/极端比例', () => {
  assert.equal(acceptableImage({ width: 200, height: 200, bytes: 50000 }).ok, false);
  assert.equal(acceptableImage({ width: 1000, height: 200, bytes: 50000 }).ok, false);
  assert.equal(acceptableImage({ width: 1000, height: 1000, bytes: 50000 }).ok, true);
});

check('可信来源与 hostOf', () => {
  assert.equal(hostOf('https://item.jd.com/1'), 'item.jd.com');
  assert.equal(isTrustedProductHost('www.nmpa.gov.cn'), true);
  assert.equal(isTrustedPhotoHost('upload.wikimedia.org'), true);
  assert.equal(isTrustedProductHost('blog.csdn.net'), false);
});

console.log('\n' + pass + '/6 PASS');
if (pass !== 6) process.exitCode = 1;
