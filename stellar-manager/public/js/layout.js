/* 排版：紧凑模式 + 卡片折叠 + 小按钮卡片（2026-11-11）。
 * 主人原话：「功能太多太挤了，麻烦把部分ui做成mini的，滚动条类的不要一直长到底」，
 * 后来又补：「把一些功能默认成一个小按钮，点击才会进入界面查看」。
 * 这里只管不涉及数据的事：
 *   1) body.compact —— 卡片内边距/字号收小，一屏多放几行；
 *   2) section.is-collapsed —— 卡片只留标题，点标题切换；
 *   3) section.is-mini —— 低频查看型卡片默认收成一颗小按钮，点开浮成整屏（is-open），
 *      再点标题「✕ 收起」、点背景或按 ESC 关掉。
 *      节点原地留着不搬家 —— 各模块的 el() 才找得到它（挪进别的容器会丢事件/丢绑定）。
 * 长列表的限高内滚在 style.css 里（max-height + overflow:auto），不需要 JS。
 * 状态都记在 localStorage，刷新后保持你上次的样子。
 */
var LAYOUT_KEY = 'stellar.layout';
var LAYOUT = { compact: false, collapsed: {}, mini: {} };
/* 默认收成小按钮的卡：都是「偶尔翻一眼」的查看型；天天要点的（设置、通讯录、计划、动态）保持常显。
 * 想改默认：把 id 加/减到这里；用户手动点过开关后，以 localStorage 里记的为准。 */
/* 2026-11-13：记忆页现在是「记忆库 + 话题目录 + 零碎」三张卡，都不能收成小条；
 * fragCard / styleCard 是「偶尔翻一眼」的，跟上面同一梯队但要保持展开（零碎的说明文字是给人看的）。 */
var MINI_DEFAULT = ['logCard', 'opsCard', 'bioCard', 'taskCard', 'outboxCard', 'accessCard'];
var layoutSheet = null;

function layoutLoad() {
  try {
    var raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    LAYOUT.compact = saved && saved.compact === true;
    LAYOUT.collapsed = (saved && saved.collapsed && typeof saved.collapsed === 'object') ? saved.collapsed : {};
    LAYOUT.mini = (saved && saved.mini && typeof saved.mini === 'object') ? saved.mini : {};
  } catch (e) {}
}

function layoutSave() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(LAYOUT)); } catch (e) {}
}

function layoutIsMini(id) {
  if (!id) return false;
  if (Object.prototype.hasOwnProperty.call(LAYOUT.mini, id)) return LAYOUT.mini[id] === true;
  return MINI_DEFAULT.indexOf(id) >= 0;
}

function layoutSyncButtons() {
  var dense = document.getElementById('ltDense');
  if (dense) dense.classList.toggle('on', LAYOUT.compact === true);
  var cards = document.querySelectorAll('main > section.card');
  var collapsedCount = 0;
  cards.forEach(function (card) { if (card.classList.contains('is-collapsed')) collapsedCount += 1; });
  var all = document.getElementById('ltCollapse');
  if (all) {
    var allOff = cards.length > 0 && collapsedCount === cards.length;
    all.classList.toggle('on', allOff);
    all.textContent = allOff ? '全展开' : '全收起';
  }
}

/* 2026-11-12：桌面一次只看一页之后，像「运行日志」这种整页四张卡全在 MINI_DEFAULT 里的页，
 * 打开就只剩四条 44px 的按钮条 —— 那页等于空的。所以：**当当前页所有卡都会是小条时，这一页整体展开**。
 * 只影响渲染，不写进 localStorage：主人手动点过的小条状态不会因为切了一次页就被抹掉。 */
function layoutTabAllMini() {
  var active = Array.prototype.filter.call(
    document.querySelectorAll('main > section.card'),
    function (card) { return card.classList.contains('active') && card.id; }
  );
  if (!active.length) return false;
  return active.every(function (card) { return layoutIsMini(card.id); });
}

function layoutApply() {
  document.body.classList.toggle('compact', LAYOUT.compact === true);
  var wholeMini = layoutTabAllMini();
  document.querySelectorAll('main > section.card').forEach(function (card) {
    var id = card.id || '';
    if (!id) return;
    card.classList.toggle('is-collapsed', LAYOUT.collapsed[id] === true && !card.classList.contains('is-open'));
    /* 浮层打开时不能再套 is-mini（那会把正文 display:none 掉） */
    card.classList.toggle('is-mini', !card.classList.contains('is-open') && layoutIsMini(id) && !wholeMini);
  });
  layoutSyncButtons();
}

function layoutToggleCard(card) {
  var id = card && card.id;
  if (!id) return;
  var next = !card.classList.contains('is-collapsed');
  card.classList.toggle('is-collapsed', next);
  if (next) LAYOUT.collapsed[id] = true;
  else delete LAYOUT.collapsed[id];
  layoutSave();
  layoutSyncButtons();
}

/* ── 小按钮卡片：点开 = 整屏浮层 ─────────────────────────────────────────── */
function layoutOpenSheet(card) {
  if (!card || card.classList.contains('is-open')) return;
  if (!layoutSheet) {
    layoutSheet = document.createElement('div');
    layoutSheet.className = 'sheet-backdrop';
    layoutSheet.addEventListener('click', layoutCloseSheet);
    document.body.appendChild(layoutSheet);
  }
  layoutSheet.style.display = 'block';
  document.body.classList.add('has-sheet');
  /* 关键：把 is-mini / is-collapsed 摘掉再开 —— 靠 CSS 覆盖 display 会把 .row 的 flex 一起弄丢 */
  card.dataset.sheetWasMini = '1';
  card.classList.remove('is-mini');
  card.classList.remove('is-collapsed');
  card.classList.add('is-open');
  card.scrollTop = 0;
}

function layoutCloseSheet() {
  var open = document.querySelector('main > section.card.is-open');
  if (open) {
    open.classList.remove('is-open');
    delete open.dataset.sheetWasMini;
    open.classList.toggle('is-mini', layoutIsMini(open.id || ''));
    open.classList.toggle('is-collapsed', LAYOUT.collapsed[open.id] === true);
  }
  if (layoutSheet) layoutSheet.style.display = 'none';
  document.body.classList.remove('has-sheet');
}

/* 点标题：小按钮卡 → 打开浮层；其它卡 → 折叠/展开（标题里的按钮/链接不触发） */
function layoutBindCards() {
  document.querySelectorAll('main > section.card').forEach(function (card) {
    var h2 = card.querySelector(':scope > h2');
    if (!h2 || h2.dataset.layoutBound === '1') return;
    h2.dataset.layoutBound = '1';
    h2.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('button, a, input, select, span.msg')) return;
      if (card.classList.contains('is-open')) { layoutCloseSheet(); return; }
      if (card.classList.contains('is-mini')) { layoutOpenSheet(card); return; }
      layoutToggleCard(card);
    });
  });
  /* 每张小按钮卡右上角加一颗「常显」开关 —— 谁不想收就让它一直展开 */
  document.querySelectorAll('main > section.card').forEach(function (card) {
    var id = card.id || '';
    if (!id || MINI_DEFAULT.indexOf(id) < 0) return;
    var h2 = card.querySelector(':scope > h2');
    if (!h2 || h2.querySelector('.card-dock')) return;
    var dock = document.createElement('button');
    dock.type = 'button';
    dock.className = 'card-dock';
    dock.title = '这颗按钮卡：点一下改成常显/收起';
    dock.textContent = '⇱';
    dock.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var now = layoutIsMini(id);
      LAYOUT.mini[id] = !now;
      layoutSave();
      layoutApply();
    });
    h2.appendChild(dock);
  });
}

document.addEventListener('DOMContentLoaded', function () {
  layoutLoad();
  layoutApply();
  layoutBindCards();
  var dense = document.getElementById('ltDense');
  if (dense) dense.addEventListener('click', function () {
    LAYOUT.compact = !LAYOUT.compact;
    layoutSave();
    layoutApply();
  });
  var all = document.getElementById('ltCollapse');
  if (all) all.addEventListener('click', function () {
    var cards = document.querySelectorAll('main > section.card');
    var collapsedCount = 0;
    cards.forEach(function (card) { if (card.classList.contains('is-collapsed')) collapsedCount += 1; });
    var collapseAll = collapsedCount !== cards.length;
    cards.forEach(function (card) {
      if (!card.id) return;
      if (card.classList.contains('is-open')) return;
      card.classList.toggle('is-collapsed', collapseAll);
      if (collapseAll) LAYOUT.collapsed[card.id] = true;
      else delete LAYOUT.collapsed[card.id];
    });
    layoutSave();
    layoutSyncButtons();
  });
  /* ESC 关浮层；切标签时也关掉，免得浮层留在别的页上 */
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') layoutCloseSheet();
  });
  document.querySelectorAll('#tabbar button').forEach(function (b) {
    b.addEventListener('click', function () { layoutCloseSheet(); });
  });
});