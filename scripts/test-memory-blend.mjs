
import { blendMemoryBlocks, normalizeMemoryMode, normalizeHybridConfig, memoryModeHint, hybridVectorOptions } from '../src/memory-blend.js';
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { if (cond) { pass++; } else { fail++; console.log('FAIL', name, extra); } };

ok('mode default', normalizeMemoryMode('nonsense') === 'narrative');
ok('mode vector', normalizeMemoryMode('VECTOR') === 'vector');
ok('mode hybrid', normalizeMemoryMode(' hybrid ') === 'hybrid');
ok('hybrid defaults', JSON.stringify(normalizeHybridConfig({})) === JSON.stringify({ enabled:true, topK:3, minScore:0.4, injectMaxChars:400, maxTotalChars:3000 }));
ok('clamp', normalizeHybridConfig({ topK: 99, minScore: 5, injectMaxChars: 99999 }).topK === 10);

const narr = '【记忆卡】\n- 生日 1月1\n- 宣城\n';
const vec = '【想起的旧事】\n· 2026-11-09 医保15号截止\n· 2026-11-09 好友B请辣条\n（这些是可能相关的旧事，不是当前事实；记不清就说记不清，不要编。）';
ok('narrative only', blendMemoryBlocks({ mode:'narrative', narrative:narr, vector:vec }) === narr.trim());
ok('vector only', blendMemoryBlocks({ mode:'vector', narrative:narr, vector:vec }) === vec);
const hyb = blendMemoryBlocks({ mode:'hybrid', narrative:narr, vector:vec });
ok('hybrid has both', hyb.includes('1月1') && hyb.includes('医保'));
ok('hybrid order', hyb.indexOf('1月1') < hyb.indexOf('医保'));
ok('hybrid no vector', blendMemoryBlocks({ mode:'hybrid', narrative:narr, vector:'' }) === narr.trim());
ok('hybrid no narrative', blendMemoryBlocks({ mode:'hybrid', narrative:'', vector:vec }) === vec);
ok('hybrid disabled', blendMemoryBlocks({ mode:'hybrid', narrative:narr, vector:vec, hybrid:{ enabled:false } }) === narr.trim());

// 预算：收紧 maxTotalChars 必须只裁向量侧，且保留尾部说明
const big = '【想起的旧事】\n' + Array.from({length: 30}, (_,i)=>'· 2026-11-09 第' + i + '条旧事，内容稍微长一点用来测试裁剪行为').join('\n') + '\n（这些是可能相关的旧事，不是当前事实；记不清就说记不清，不要编。）';
// maxTotalChars 下限 500（clampInt 500..20000），所以用 500 做预算，向量侧必须被裁
const tight = blendMemoryBlocks({ mode:'hybrid', narrative:narr, vector:big, hybrid:{ maxTotalChars: 500 } });
ok('budget respected', tight.length <= 500, 'len=' + tight.length);
ok('budget actually trimmed', tight.length < narr.trim().length + 2 + big.length, 'len=' + tight.length);
ok('clamp min', normalizeHybridConfig({ maxTotalChars: 10 }).maxTotalChars === 500);
ok('narrative kept', tight.startsWith(narr.trim()));
ok('note kept', tight.includes('不要编'));
ok('hint vector', /向量记忆模式/.test(memoryModeHint('vector')));
ok('hint hybrid', /混合记忆模式/.test(memoryModeHint('hybrid')));
ok('hint narrative empty', memoryModeHint('narrative') === '');
ok('vec opts', JSON.stringify(hybridVectorOptions({})) === JSON.stringify({ topK:3, minScore:0.4, injectMaxChars:400 }));
console.log('pass', pass, 'fail', fail);
