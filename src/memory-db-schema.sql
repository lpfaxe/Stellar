-- 记忆库 schema（memory-db.js 打开连接时执行；全部 IF NOT EXISTS，可重复跑）
-- 设计：见 src/memory-db.js 顶部注释（表结构的来由与不变量）

-- ① 缓冲：所有聊天先落盘（唯一高频写入表，只 INSERT + 定期 DELETE）
CREATE TABLE IF NOT EXISTS cache_msg (
  id INTEGER PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  speaker_id TEXT NOT NULL DEFAULT '',
  speaker_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL DEFAULT '',
  quote_id INTEGER,
  at INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  process_state TEXT NOT NULL DEFAULT 'new',
  keep INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cache_day ON cache_msg(day_key, process_state);
CREATE INDEX IF NOT EXISTS idx_cache_owner ON cache_msg(owner_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_cache_conv ON cache_msg(conversation_key, at DESC);

-- ② 话题：一段有头有尾的对话（切分产物）
CREATE TABLE IF NOT EXISTS topic (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'daily',
  importance INTEGER NOT NULL DEFAULT 0,
  facets TEXT NOT NULL DEFAULT '[]',
  sentiment TEXT NOT NULL DEFAULT '',
  msg_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  promoted_at INTEGER,
  promote_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_cat ON topic(owner_id, tier, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_day ON topic(day_key, tier);

-- ③ 话题正文：important 话题在这里永久保存（不依赖 cache_msg）
CREATE TABLE IF NOT EXISTS topic_msg (
  id INTEGER PRIMARY KEY,
  topic_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  speaker_id TEXT NOT NULL DEFAULT '',
  speaker_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE(topic_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_tmsg_topic ON topic_msg(topic_id, seq);

-- ④ 零碎记忆：一句话事实/偏好/忌讳
CREATE TABLE IF NOT EXISTS fragment (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  text TEXT NOT NULL,
  facet TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 1,
  tier TEXT NOT NULL DEFAULT 'daily',
  topic_id TEXT,
  at INTEGER NOT NULL,
  promoted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_frag_owner ON fragment(owner_id, tier, at DESC);
CREATE INDEX IF NOT EXISTS idx_frag_day ON fragment(day_key, tier);

-- ⑤ 人物侧写（≤50 字，注入最前面）
CREATE TABLE IF NOT EXISTS profile (
  owner_id TEXT PRIMARY KEY,
  persona TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'auto',
  confidence INTEGER NOT NULL DEFAULT 0,
  msg_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  edited_by TEXT NOT NULL DEFAULT ''
);

-- ⑥ 角色风格参考切片（模块三）
CREATE TABLE IF NOT EXISTS style_slice (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  part TEXT NOT NULL,
  kind TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  mood TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_style_kind ON style_slice(kind, enabled);

-- ⑦ 全文检索：search_doc 是唯一真相，search_fts 由触发器同步（external content）
CREATE TABLE IF NOT EXISTS search_doc (
  id INTEGER PRIMARY KEY,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  body TEXT NOT NULL,
  bigrams TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_owner ON search_doc(owner_id);
CREATE INDEX IF NOT EXISTS idx_search_ref ON search_doc(ref_type, ref_id);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(body, content='search_doc', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS search_doc_ai AFTER INSERT ON search_doc BEGIN
  INSERT INTO search_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_doc_ad AFTER DELETE ON search_doc BEGIN
  INSERT INTO search_fts(search_fts, rowid, body) VALUES('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_doc_au AFTER UPDATE ON search_doc BEGIN
  INSERT INTO search_fts(search_fts, rowid, body) VALUES('delete', old.id, old.body);
  INSERT INTO search_fts(rowid, body) VALUES (new.id, new.body);
END;

-- ⑧ 任务台账（后台任务幂等 + 可观测）
CREATE TABLE IF NOT EXISTS job_state (
  name TEXT PRIMARY KEY,
  day_key TEXT NOT NULL DEFAULT '',
  cursor TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'idle',
  last_run_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  stats TEXT NOT NULL DEFAULT '{}'
);

-- ⑨ 元信息（schema 版本 / 新机制启用日）
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- ⑩ 见闻区（2026-11-13 主人要求）：B站 / QQ好友爱看 两个独立区，不按话题分类。
--   她自己看完后写一条精简总结进来（≤200 字），供「今天在b站看了什么」这类问题优先检索。
--   owner_id 固定 'self'：见闻是「她自己看到的」，不属于某个对话对象，检索不按会话 owner 过滤。
CREATE TABLE IF NOT EXISTS zone_note (
  id INTEGER PRIMARY KEY,
  zone TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT 'self',
  day_key TEXT NOT NULL,
  text TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'tool',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zone_at ON zone_note(zone, at DESC);
CREATE INDEX IF NOT EXISTS idx_zone_day ON zone_note(zone, day_key);

-- ⑪ 人物事实（2026-11-13 主人要求：重要记忆不再只靠话题，生日这类私人信息单独存、权重高）
--   为什么单独一张表：
--    · 事实的来源不止对话（主人可在面板直接注入、她可自己写），而且不该被两天窗口删掉；
--    · 同一件事会反复提到（「我生日1月1」说了三遍），必须按 (owner, kind, label) 去重而不是堆行；
--    · 隐私要能分级：谁能看到这条事实由 privacy 决定，不靠名字里有没有「生日」猜。
--   privacy: normal（她自己在群里也能用）/ private（只在跟本人的对话里用）/ secret（只本人私聊 + 面板）
CREATE TABLE IF NOT EXISTS fact (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  privacy TEXT NOT NULL DEFAULT 'private',
  weight INTEGER NOT NULL DEFAULT 3,
  source TEXT NOT NULL DEFAULT 'manual',
  day_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, kind, label)
);
CREATE INDEX IF NOT EXISTS idx_fact_owner ON fact(owner_id, weight DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_kind ON fact(kind, updated_at DESC);
