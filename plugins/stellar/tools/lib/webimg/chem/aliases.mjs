// chem/aliases.mjs —— 中文常用名 -> 英文名 / CAS 的本地别名表。
//
// 为什么必须本地：PubChem 的 name 接口不认中文（「阿司匹林」直接 404），
// 而让模型自己把中文翻成英文再猜 CAS，是准确率最不可控的一环。
// 这张表是人工核对的「常用 140 个」；查不到就返回 NEED_IDENTIFIER 让主人补 CAS/英文名，
// 不猜、不拿一个相近的名字顶替。
//
// 维护：只收「常见、CAS 稳定」的物质；新增一行必须同时给出英文名与 CAS。

const TABLE = [
  ['阿司匹林', 'aspirin', '50-78-2'],
  ['对乙酰氨基酚', 'acetaminophen', '103-90-2'],
  ['布洛芬', 'ibuprofen', '15687-27-1'],
  ['萘普生', 'naproxen', '22204-53-1'],
  ['双氯芬酸', 'diclofenac', '15307-86-5'],
  ['吲哚美辛', 'indomethacin', '53-86-1'],
  ['塞来昔布', 'celecoxib', '169590-42-5'],
  ['咖啡因', 'caffeine', '58-08-2'],
  ['茶碱', 'theophylline', '58-55-9'],
  ['尼古丁', 'nicotine', '54-11-5'],
  ['葡萄糖', 'glucose', '50-99-7'],
  ['果糖', 'fructose', '57-48-7'],
  ['蔗糖', 'sucrose', '57-50-1'],
  ['乳糖', 'lactose', '63-42-3'],
  ['麦芽糖', 'maltose', '69-79-4'],
  ['淀粉', 'starch', '9005-25-8'],
  ['纤维素', 'cellulose', '9004-34-6'],
  ['乙醇', 'ethanol', '64-17-5'],
  ['甲醇', 'methanol', '67-56-1'],
  ['异丙醇', 'isopropanol', '67-63-0'],
  ['丙酮', 'acetone', '67-64-1'],
  ['乙醚', 'diethyl ether', '60-29-7'],
  ['乙酸', 'acetic acid', '64-19-7'],
  ['柠檬酸', 'citric acid', '77-92-9'],
  ['乳酸', 'lactic acid', '50-21-5'],
  ['草酸', 'oxalic acid', '144-62-7'],
  ['盐酸', 'hydrochloric acid', '7647-01-0'],
  ['硫酸', 'sulfuric acid', '7664-93-9'],
  ['硝酸', 'nitric acid', '7697-37-2'],
  ['磷酸', 'phosphoric acid', '7664-38-2'],
  ['氢氧化钠', 'sodium hydroxide', '1310-73-2'],
  ['氢氧化钾', 'potassium hydroxide', '1310-58-3'],
  ['氢氧化钙', 'calcium hydroxide', '1305-62-0'],
  ['氨水', 'ammonium hydroxide', '1336-21-6'],
  ['氯化钠', 'sodium chloride', '7647-14-5'],
  ['氯化钾', 'potassium chloride', '7447-40-7'],
  ['氯化钙', 'calcium chloride', '10043-52-4'],
  ['氯化镁', 'magnesium chloride', '7786-30-3'],
  ['硫酸铜', 'copper(II) sulfate', '7758-98-7'],
  ['硫酸亚铁', 'iron(II) sulfate', '7720-78-7'],
  ['硫酸锌', 'zinc sulfate', '7733-02-0'],
  ['碳酸钠', 'sodium carbonate', '497-19-8'],
  ['碳酸氢钠', 'sodium bicarbonate', '144-55-8'],
  ['碳酸钙', 'calcium carbonate', '471-34-1'],
  ['硝酸银', 'silver nitrate', '7761-88-8'],
  ['高锰酸钾', 'potassium permanganate', '7722-64-7'],
  ['重铬酸钾', 'potassium dichromate', '7778-50-9'],
  ['碘', 'iodine', '7553-56-2'],
  ['碘化钾', 'potassium iodide', '7681-11-0'],
  ['过氧化氢', 'hydrogen peroxide', '7722-84-1'],
  ['甲醛', 'formaldehyde', '50-00-0'],
  ['乙醛', 'acetaldehyde', '75-07-0'],
  ['苯甲醛', 'benzaldehyde', '100-52-7'],
  ['苯', 'benzene', '71-43-2'],
  ['甲苯', 'toluene', '108-88-3'],
  ['二甲苯', 'xylene', '1330-20-7'],
  ['苯酚', 'phenol', '108-95-2'],
  ['苯胺', 'aniline', '62-53-3'],
  ['硝基苯', 'nitrobenzene', '98-95-3'],
  ['乙苯', 'ethylbenzene', '100-41-4'],
  ['苯乙烯', 'styrene', '100-42-5'],
  ['乙烯', 'ethylene', '74-85-1'],
  ['丙烯', 'propylene', '115-07-1'],
  ['乙炔', 'acetylene', '74-86-2'],
  ['甲烷', 'methane', '74-82-8'],
  ['丙烷', 'propane', '74-98-6'],
  ['丁烷', 'butane', '106-97-8'],
  ['环己烷', 'cyclohexane', '110-82-7'],
  ['正己烷', 'hexane', '110-54-3'],
  ['二氯甲烷', 'dichloromethane', '75-09-2'],
  ['三氯甲烷', 'chloroform', '67-66-3'],
  ['四氯化碳', 'carbon tetrachloride', '56-23-5'],
  ['乙腈', 'acetonitrile', '75-05-8'],
  ['二甲基亚砜', 'dimethyl sulfoxide', '67-68-5'],
  ['N,N-二甲基甲酰胺', 'N,N-dimethylformamide', '68-12-2'],
  ['四氢呋喃', 'tetrahydrofuran', '109-99-9'],
  ['吡啶', 'pyridine', '110-86-1'],
  ['尿素', 'urea', '57-13-6'],
  ['甘油', 'glycerol', '56-81-5'],
  ['乙二醇', 'ethylene glycol', '107-21-1'],
  ['甘氨酸', 'glycine', '56-40-6'],
  ['丙氨酸', 'alanine', '56-41-7'],
  ['谷氨酸', 'glutamic acid', '56-86-0'],
  ['赖氨酸', 'lysine', '56-87-1'],
  ['色氨酸', 'tryptophan', '73-22-3'],
  ['酪氨酸', 'tyrosine', '60-18-4'],
  ['组氨酸', 'histidine', '71-00-1'],
  ['半胱氨酸', 'cysteine', '52-90-4'],
  ['甲硫氨酸', 'methionine', '63-68-3'],
  ['苯丙氨酸', 'phenylalanine', '63-91-2'],
  ['缬氨酸', 'valine', '72-18-4'],
  ['亮氨酸', 'leucine', '61-90-5'],
  ['异亮氨酸', 'isoleucine', '73-32-5'],
  ['苏氨酸', 'threonine', '72-19-5'],
  ['脯氨酸', 'proline', '147-85-3'],
  ['丝氨酸', 'serine', '56-45-1'],
  ['天冬氨酸', 'aspartic acid', '56-84-8'],
  ['天冬酰胺', 'asparagine', '70-47-3'],
  ['谷氨酰胺', 'glutamine', '56-85-9'],
  ['精氨酸', 'arginine', '74-79-3'],
  ['维生素C', 'ascorbic acid', '50-81-7'],
  ['维生素B1', 'thiamine', '59-43-8'],
  ['维生素B2', 'riboflavin', '83-88-5'],
  ['维生素B6', 'pyridoxine', '65-23-6'],
  ['维生素E', 'alpha-tocopherol', '59-02-9'],
  ['叶酸', 'folic acid', '59-30-3'],
  ['烟酸', 'niacin', '59-67-6'],
  ['泛酸', 'pantothenic acid', '79-83-4'],
  ['生物素', 'biotin', '58-85-5'],
  ['视黄醇', 'retinol', '68-26-8'],
  ['胆固醇', 'cholesterol', '57-88-5'],
  ['睾酮', 'testosterone', '58-22-0'],
  ['雌二醇', 'estradiol', '50-28-2'],
  ['孕酮', 'progesterone', '57-83-0'],
  ['肾上腺素', 'epinephrine', '51-43-4'],
  ['多巴胺', 'dopamine', '51-61-6'],
  ['血清素', 'serotonin', '50-67-9'],
  ['褪黑素', 'melatonin', '73-31-4'],
  ['组胺', 'histamine', '51-45-6'],
  ['肌酐', 'creatinine', '60-27-5'],
  ['尿酸', 'uric acid', '69-93-2'],
  ['乳酸钠', 'sodium lactate', '72-17-3'],
  ['枸橼酸钠', 'sodium citrate', '68-04-2'],
  ['EDTA', 'edetic acid', '60-00-4'],
  ['Tris', 'tromethamine', '77-86-1'],
  ['SDS', 'sodium dodecyl sulfate', '151-21-3'],
  ['吐温20', 'polysorbate 20', '9005-64-5'],
  ['琼脂糖', 'agarose', '9012-36-6'],
  ['丙烯酰胺', 'acrylamide', '79-06-1'],
  ['过硫酸铵', 'ammonium persulfate', '7727-54-0'],
  ['TEMED', 'tetramethylethylenediamine', '110-18-9'],
  ['溴化乙锭', 'ethidium bromide', '1239-45-8'],
  ['考马斯亮蓝', 'Coomassie Brilliant Blue G-250', '6104-58-1'],
]

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s·•,，。;；:：()（）\[\]【】]/g, '')
    .trim()
}

const FORMS = ['缓释片', '肠溶片', '分散片', '咀嚼片', '口崩片', '薄膜衣片', '注射液', '口服液', '滴眼液', '喷雾剂', '软膏', '乳膏', '胶囊', '颗粒', '糖浆', '药片', '片剂', '片', '栓']

export function stripDosageForm(text) {
  let s = norm(text)
  for (const form of FORMS) {
    if (s.endsWith(form) && s.length > form.length) { s = s.slice(0, -form.length); break }
  }
  return s
}

const BY_ZH = new Map()
const BY_EN = new Map()
for (const [zh, en, cas] of TABLE) {
  BY_ZH.set(norm(zh), { zh, nameEn: en, cas })
  BY_EN.set(norm(en), { zh, nameEn: en, cas })
}

export function aliasCount() { return TABLE.length }

export function resolveAlias(name) {
  const raw = norm(name)
  if (!raw) return null
  const direct = BY_ZH.get(raw) || BY_EN.get(raw)
  if (direct) return { ...direct, matchedBy: 'alias' }
  const stripped = stripDosageForm(name)
  const byBase = BY_ZH.get(stripped) || BY_EN.get(stripped)
  if (byBase) return { ...byBase, matchedBy: 'alias-form-stripped' }
  return null
}

export function isCasNumber(text) {
  return /^\d{2,7}-\d{2}-\d$/.test(String(text || '').trim())
}

export function looksLikeChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''))
}

export const CHEMICAL_ALIASES = TABLE.map(([zh, en, cas]) => ({ zh, nameEn: en, cas }))
