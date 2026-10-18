/**
 * 墨阅 MoYue — 阅读器总控
 * 按格式路由渲染器；统一主题 / 版式 / 目录 / 书签 / 进度记忆 / 快捷键
 * 荧光笔标注 / 阅读批注 / 翻页箭头 / 常驻控制栏
 */
import { THEMES, applyTheme, nextTheme, FONT_FAMILIES } from './themes.js';
import { createTextReader, sanitizeMobiHtml } from './renderers/text-renderer.js';
import { createEpubReader } from './renderers/epub-renderer.js';
import { createPdfReader } from './renderers/pdf-renderer.js';
import { decodeTxt, splitChapters, textToHtml } from './parsers/txt-parser.js';
import { parseMobi } from './parsers/mobi-parser.js';
import { createAnnotationStore, HL_COLOR_MAP, colorFill } from './annotations.js';
import { createSelectionToolbar } from './selection-toolbar.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  book: null,
  settings: null,
  eff: null,
  theme: 'day',
  renderer: null,
  toc: [],
  tocOpen: false,
  panelTab: 'toc',
  saveTimer: null,
  annStore: null,
};

// ---------- 工具 ----------
function showToast(msg, ms = 1800) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;bottom:44px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:8px 16px;border-radius:99px;font-size:12px;z-index:99;box-shadow:0 4px 14px rgba(0,0,0,.25)';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.remove(), ms);
}

function showError(text) {
  $('#loading').hidden = true;
  $('#errorBox').hidden = false;
  $('#errorText').textContent = text;
}

function updateStatus({ chapterTitle, pageLabel, percent } = {}) {
  if (chapterTitle !== undefined) $('#statusChapter').textContent = chapterTitle || '—';
  if (pageLabel !== undefined) $('#statusPage').textContent = pageLabel;
  if (percent !== undefined) {
    $('#statusPercent').textContent = Math.round(percent * 100) + '%';
  }
}

// ---------- 进度保存 ----------
function scheduleSave(progress) {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    if (!state.book) return;
    await moyue.updateBook(state.book.id, {
      progress,
      lastOpenedAt: Date.now(),
    });
  }, 1200);
}

async function saveNow() {
  if (!state.renderer || !state.book) return;
  clearTimeout(state.saveTimer);
  try {
    const s = await state.renderer.getState();
    const progress = {
      percent: s.percent ?? 0,
      locator: s.cfi ? { cfi: s.cfi } : s.page ? { page: s.page } : { chapterIndex: s.chapterIndex, pageIndex: s.pageIndex, scrollTop: s.scrollTop || 0 },
      label: s.chapterTitle || '',
    };
    await moyue.updateBook(state.book.id, { progress, lastOpenedAt: Date.now() });
  } catch { /* 忽略 */ }
}

// ---------- 主题 ----------
function setTheme(key, { persist = true } = {}) {
  state.theme = key;
  applyTheme(key);
  $('#themeIcon').textContent = THEMES[key].icon;
  $('#statusTheme').textContent = THEMES[key].name;
  state.renderer?.setTheme(THEMES[key]);
  if (persist && state.book) {
    moyue.updateSettings({ theme: key });
  }
}

// ---------- 版式 ----------
function applyEffSettings() {
  const s = state.eff;
  $('#fontSizeLabel').textContent = s.fontSize + 'px';
  $('#marginLabel').textContent = s.margin + 'px';
  $('#marginRange').value = s.margin;
  $('#fontMinus').disabled = s.fontSize <= 13;
  $('#fontPlus').disabled = s.fontSize >= 30;
  for (const btn of $('#lineHeightSeg').children) btn.classList.toggle('active', +btn.dataset.v === s.lineHeight);
  for (const btn of $('#fontFamilySeg').children) btn.classList.toggle('active', btn.dataset.v === s.fontFamily);
  // PDF 天生单页横向（无对开），高亮“单页”更符合实际
  const pmActive = (state.book?.format === 'pdf' && s.pageMode === 'dual') ? 'single' : s.pageMode;
  for (const btn of $('#pageModeSeg').children) btn.classList.toggle('active', btn.dataset.v === pmActive);
  for (const btn of $('#turnFxSeg').children) btn.classList.toggle('active', btn.dataset.v === (s.turnFx || 'slide'));
  state.renderer?.setStyles({
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    fontFamily: FONT_FAMILIES[s.fontFamily] || FONT_FAMILIES.system,
    margin: s.margin,
  });
}

// 双页（书脊）视觉：由渲染器按真实布局（含窄屏自动回退）控制显隐
function setDualVisual(on) { $('#spine').classList.toggle('show', !!on); }
window.__moyueSetDual = setDualVisual;

async function updateEff(patch) {
  state.eff = { ...state.eff, ...patch };
  applyEffSettings();
  await moyue.updateSettings(patch);
  if (state.book) {
    await moyue.updateBook(state.book.id, { settings: { ...state.eff } });
  }
}

// ---------- 目录面板 ----------
function renderToc() {
  const list = $('#tocList');
  list.innerHTML = '';
  if (!state.toc.length) {
    list.innerHTML = '<div class="panel-empty">这本书没有可用的目录</div>';
    return;
  }
  for (const item of state.toc) {
    const div = document.createElement('div');
    div.className = 'panel-item';
    div.dataset.target = typeof item.target === 'number' ? String(item.target) : (item.target ?? '');
    div.textContent = item.label;
    if (item.depth) div.style.paddingLeft = 12 + item.depth * 14 + 'px';
    div.addEventListener('click', () => {
      state.renderer?.goTo(item.target);
      if (window.innerWidth < 720) toggleSidePanel(false);
    });
    list.appendChild(div);
  }
}

function markCurrentToc(target) {
  const items = $('#tocList').children;
  for (const it of items) {
    it.classList.toggle('current', it.dataset.target === String(target));
  }
}

function toggleSidePanel(force) {
  const panel = $('#sidePanel');
  const open = force !== undefined ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  state.tocOpen = open;
  $('#btnToc').classList.toggle('active', open);
  if (open) showPanelTab('toc');
}

function showPanelTab(tab) {
  state.panelTab = tab;
  $('#tabToc').classList.toggle('active', tab === 'toc');
  $('#tabMarks').classList.toggle('active', tab === 'marks');
  $('#tocList').hidden = tab !== 'toc';
  $('#markList').hidden = tab !== 'marks';
  if (tab === 'marks') renderBookmarks();
}

// ---------- 书签 ----------
function renderBookmarks() {
  const list = $('#markList');
  list.innerHTML = '';
  const marks = state.book?.bookmarks || [];
  if (!marks.length) {
    list.innerHTML = '<div class="panel-empty">还没有书签<br/>阅读时按 Ctrl+B 或点击顶栏书签按钮添加</div>';
    return;
  }
  for (const m of marks) {
    const div = document.createElement('div');
    div.className = 'panel-item';
    div.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = m.label || '书签';
    const meta = document.createElement('span');
    meta.className = 'mark-meta';
    meta.textContent = `${Math.round((m.percent || 0) * 100)}% · ${new Date(m.createdAt).toLocaleDateString('zh-CN')}`;
    div.appendChild(label);
    div.appendChild(meta);
    const del = document.createElement('button');
    del.className = 'card-action-btn';
    del.style.cssText = 'position:absolute;right:8px;top:8px;width:22px;height:22px;opacity:.6';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    div.style.position = 'relative';
    div.appendChild(del);
    div.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      state.renderer?.goTo(m.locator);
      if (window.innerWidth < 720) toggleSidePanel(false);
    });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.book.bookmarks = (state.book.bookmarks || []).filter((x) => x.id !== m.id);
      await moyue.updateBook(state.book.id, { bookmarks: state.book.bookmarks });
      renderBookmarks();
    });
    list.appendChild(div);
  }
}

async function addBookmark() {
  if (!state.renderer || !state.book) return;
  const s = await state.renderer.getState();
  const mark = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: s.chapterTitle || (s.page ? `第 ${s.page} 页` : '书签'),
    percent: s.percent ?? 0,
    locator: s.cfi ? { cfi: s.cfi } : s.page ? { page: s.page } : { chapterIndex: s.chapterIndex, pageIndex: s.pageIndex },
    createdAt: Date.now(),
  };
  state.book.bookmarks = [...(state.book.bookmarks || []), mark];
  await moyue.updateBook(state.book.id, { bookmarks: state.book.bookmarks });
  showToast('已添加书签');
}

// ---------- 标注（荧光笔 / 批注） ----------
let pendingSelection = null;

const selToolbar = createSelectionToolbar({
  onApplyColor: (color, ctx) => commitAnnotation(ctx, color, ''),
  onAnnotate: (color, note, ctx) => commitAnnotation(ctx, color, note),
});

function handleSelection(ctx) {
  pendingSelection = ctx;
  selToolbar.show(ctx);
}

async function commitAnnotation(ctx, color, note) {
  if (!ctx || !state.annStore) return;
  const loc = ctx.format === 'epub'
    ? { cfi: ctx.cfi }
    : ctx.format === 'pdf'
      ? { page: ctx.page, start: ctx.start, end: ctx.end }
      : { chapter: ctx.chapter, start: ctx.start, end: ctx.end };
  const ann = await state.annStore.add({
    type: note ? 'note' : 'highlight',
    color,
    text: ctx.text || '',
    note: note || '',
    loc,
  });
  state.renderer?.applyAnnotation(ann);
  state.renderer?.clearSelection();
  pendingSelection = null;
  showToast(note ? '批注已保存' : '已标注重点');
  renderAnnList();
}

// 顶栏荧光笔面板
function toggleHlPalette(force) {
  const p = $('#hlPalette');
  const open = force !== undefined ? force : p.hidden;
  p.hidden = !open;
  $('#btnHighlight').classList.toggle('active', open);
  for (const dot of p.querySelectorAll('.hl-dot')) {
    dot.classList.toggle('active', dot.dataset.color === (pendingSelection?.color || 'yellow'));
  }
}

$('#btnHighlight').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleHlPalette();
});
$('#hlPalette').addEventListener('click', (e) => {
  const dot = e.target.closest('.hl-dot');
  if (!dot) return;
  const color = dot.dataset.color;
  // 优先使用最近一次选中；文本格式允许实时读取当前选区
  let ctx = pendingSelection;
  if (!ctx && state.renderer?.getSelectionContext) {
    ctx = state.renderer.getSelectionContext();
  }
  if (!ctx) {
    showToast('请先选中要标注的文字');
    return;
  }
  commitAnnotation(ctx, color, '');
  toggleHlPalette(false);
});
$('#hlManage').addEventListener('click', () => {
  toggleHlPalette(false);
  toggleAnnPanel(true);
});
// 点击空白关闭面板
document.addEventListener('pointerdown', (e) => {
  if (!$('#hlPalette').hidden && !e.target.closest('#hlPalette') && !e.target.closest('#btnHighlight')) {
    toggleHlPalette(false);
  }
  if (!$('#typePanel').hidden && !e.target.closest('#typePanel') && !e.target.closest('#btnType')) {
    $('#typePanel').hidden = true;
  }
}, true);

// 标注抽屉
function toggleAnnPanel(force) {
  const p = $('#annPanel');
  const open = force !== undefined ? force : p.classList.contains('hidden');
  p.classList.toggle('hidden', !open);
  $('#btnNotes').classList.toggle('active', open);
  if (open) renderAnnList();
}
$('#btnNotes').addEventListener('click', () => toggleAnnPanel());
$('#annClose').addEventListener('click', () => toggleAnnPanel(false));
$('#annExport').addEventListener('click', exportAnnotations);

function annLocLabel(ann) {
  const book = state.book;
  if (ann.loc.cfi) return 'EPUB';
  if (ann.loc.page !== undefined) return `第 ${ann.loc.page} 页`;
  const ch = book?.title ? '' : '';
  const title = state.toc[ann.loc.chapter]?.label || `第 ${ann.loc.chapter + 1} 章`;
  return title;
}

function renderAnnList() {
  const list = $('#annList');
  const anns = state.annStore?.all() || [];
  list.innerHTML = '';
  if (!anns.length) {
    list.innerHTML = '<div class="panel-empty">还没有标注<br/>选中文字后，用浮动工具栏或顶栏荧光笔标注重点</div>';
    return;
  }
  for (const ann of anns) {
    const item = document.createElement('div');
    item.className = 'ann-item';

    const top = document.createElement('div');
    top.className = 'ann-item-top';
    const chip = document.createElement('span');
    chip.className = 'ann-chip';
    chip.style.background = (HL_COLOR_MAP[ann.color] || HL_COLOR_MAP.yellow).dot;
    const type = document.createElement('span');
    type.className = 'ann-type';
    type.textContent = ann.type === 'note' ? '批注' : '标注';
    const loc = document.createElement('span');
    loc.className = 'ann-loc';
    loc.textContent = annLocLabel(ann);
    top.appendChild(chip);
    top.appendChild(type);
    top.appendChild(loc);
    item.appendChild(top);

    if (ann.text) {
      const text = document.createElement('div');
      text.className = 'ann-text';
      text.textContent = ann.text;
      item.appendChild(text);
    }
    if (ann.note) {
      const note = document.createElement('div');
      note.className = 'ann-note';
      note.textContent = ann.note;
      item.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'ann-actions';
    const jump = document.createElement('button');
    jump.className = 'ann-act';
    jump.textContent = '跳转';
    jump.addEventListener('click', (e) => {
      e.stopPropagation();
      state.renderer?.goToAnnotation(ann);
    });
    const edit = document.createElement('button');
    edit.className = 'ann-act';
    edit.textContent = ann.note ? '改批注' : '加批注';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      startEdit(item, ann);
    });
    const del = document.createElement('button');
    del.className = 'ann-act danger';
    del.textContent = '删除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await state.annStore.remove(ann.id);
      state.renderer?.removeAnnotation(ann);
      renderAnnList();
      showToast('已删除');
    });
    actions.appendChild(jump);
    actions.appendChild(edit);
    actions.appendChild(del);
    item.appendChild(actions);

    item.addEventListener('click', () => state.renderer?.goToAnnotation(ann));
    list.appendChild(item);
  }
}

function startEdit(item, ann) {
  // 隐藏原内容，替换为编辑区
  const old = item.querySelector('.ann-note');
  const editor = document.createElement('textarea');
  editor.className = 'ann-edit';
  editor.rows = 3;
  editor.value = ann.note || '';
  if (old) old.replaceWith(editor);
  else item.insertBefore(editor, item.querySelector('.ann-actions'));
  editor.focus();
  const actions = item.querySelector('.ann-actions');
  actions.innerHTML = '';
  const cancel = document.createElement('button');
  cancel.className = 'ann-act';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => renderAnnList());
  const save = document.createElement('button');
  save.className = 'ann-act';
  save.textContent = '保存';
  save.addEventListener('click', async () => {
    const note = editor.value.trim();
    await state.annStore.update(ann.id, { note, type: note ? 'note' : 'highlight' });
    renderAnnList();
    showToast('已更新');
  });
  actions.appendChild(cancel);
  actions.appendChild(save);
}

async function exportAnnotations() {
  const anns = state.annStore?.all() || [];
  if (!anns.length) { showToast('还没有标注可导出'); return; }
  const title = state.book?.title || '未命名';
  const lines = [`# 《${title}》标注与批注`, '', `> 共 ${anns.length} 条 · 导出于 ${new Date().toLocaleString('zh-CN')}`, ''];
  for (const ann of anns) {
    const colorName = (HL_COLOR_MAP[ann.color] || HL_COLOR_MAP.yellow).name;
    lines.push(`## ${annLocLabel(ann)}`);
    lines.push(`- 【${colorName}】${ann.text || '（位置标注）'}`);
    if (ann.note) lines.push(`  > ${ann.note.replace(/\n/g, '\n  > ')}`);
    lines.push('');
  }
  try {
    const path = await moyue.exportAnnotations(state.book.id, lines.join('\n'));
    showToast('已导出：' + path, 3200);
  } catch {
    showToast('导出失败');
  }
}

// ---------- 翻页箭头（WPS 风格：贴边浮现） ----------
const arrowPrev = $('#arrowPrev');
const arrowNext = $('#arrowNext');
let arrowHideTimer = null;

// 同时支持两种调用：
//  - 主文档 mousemove 事件（e 为 MouseEvent，含 clientX/clientY/target）
//  - 翻页引擎/ EPUB iframe 转发来的数值坐标（clientX, clientY, target?）
// EPUB 内容在 iframe 内，鼠标事件不会冒泡到主文档，必须由 iframe 内监听把坐标换算回主窗口后转发
function refreshArrows(clientX, clientY, target) {
  if (clientX && typeof clientX === 'object') {
    target = clientX.target;
    clientY = clientX.clientY;
    clientX = clientX.clientX;
  }
  if (clientX == null || clientY == null) return;
  const stage = $('#stage').getBoundingClientRect();
  const inStageY = clientY >= stage.top && clientY <= stage.bottom;
  const nearL = inStageY && clientX >= stage.left && clientX < stage.left + 150;
  const nearR = inStageY && clientX <= stage.right && clientX > stage.right - 150;
  const onArrow = target?.closest?.('.page-arrow');
  arrowPrev.classList.toggle('show', nearL || (onArrow === arrowPrev));
  arrowNext.classList.toggle('show', nearR || (onArrow === arrowNext));
  clearTimeout(arrowHideTimer);
  if (nearL || nearR || onArrow) {
    arrowHideTimer = setTimeout(() => {
      arrowPrev.classList.remove('show');
      arrowNext.classList.remove('show');
    }, 1800);
  }
}
document.addEventListener('mousemove', (e) => refreshArrows(e));
window.__moyueHover = refreshArrows; // 供 EPUB iframe 内 mousemove 转发调用
arrowPrev.addEventListener('click', () => state.renderer?.turnPage('prev'));
arrowNext.addEventListener('click', () => state.renderer?.turnPage('next'));

// ---------- MOBI 分章 ----------
// 章节标题识别：结构化 h1-h3，或文本匹配章节模式的 P/FONT 标签
const CHAPTER_PATTERN = /^(chapter\s+[\divxlcdm]+|第\s*[\divxlcdm一二三四五六七八九十百千零]+\s*[章节回卷]|序[言曲]?|楔子|尾声|番外|preface|prologue|epilogue|foreword|afterword|contents|appendix|bibliography)/i;

function isChapterHeadingNode(node) {
  if (!node || node.nodeType !== 1) return false;
  if (/^h[1-3]$/i.test(node.tagName)) return node.textContent.trim().length > 0;
  if (/^(p|font|div|center)$/i.test(node.tagName)) {
    const t = (node.textContent || '').trim();
    return t.length > 0 && t.length <= 40 && CHAPTER_PATTERN.test(t);
  }
  return false;
}

function mobiToChapters(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const chapters = [];
  let current = null;
  const pushCurrent = () => { if (current && current.nodes.length) chapters.push(current); };
  for (const node of [...doc.body.children]) {
    const heading = isChapterHeadingNode(node);
    if (heading) {
      pushCurrent();
      current = { title: node.textContent.trim().slice(0, 60), nodes: [node] };
    } else {
      if (!current) current = { title: '卷首', nodes: [] };
      current.nodes.push(node);
    }
  }
  pushCurrent();
  if (!chapters.length) return [{ title: '全文', html: '<p>（无可显示内容）</p>' }];
  return chapters.map((c) => ({
    title: c.title,
    html: `<h2 class="chapter-title">${c.title}</h2>` + c.nodes.map((n) => n.outerHTML).join(''),
  }));
}

// ---------- 主流程 ----------
async function init() {
  const params = new URLSearchParams(location.search);
  const bookId = params.get('book');
  if (!bookId) { showError('缺少图书参数'); return; }

  const { books, settings } = await moyue.getLibrary();
  state.settings = settings;
  const book = books.find((b) => b.id === bookId);
  if (!book) { showError('这本书不在书架中（可能已被移除）'); return; }
  state.book = book;

  $('#bookTitle').textContent = book.title || book.fileName;
  document.title = `${book.title || '墨阅'} · 墨阅`;

  // 生效设置：全局 + 本书覆盖
  state.eff = {
    theme: settings.theme, fontSize: settings.fontSize, lineHeight: settings.lineHeight,
    fontFamily: settings.fontFamily, margin: settings.margin, pageMode: settings.pageMode,
    turnFx: settings.turnFx || 'slide',
    ...(book.settings || {}),
  };
  // 兼容旧版设置：paginated → dual
  if (state.eff.pageMode === 'paginated') state.eff.pageMode = 'dual';

  // 标注仓库
  state.annStore = createAnnotationStore(bookId);
  await state.annStore.load();

  // ---------- UI 事件 ----------
  $('#btnBack').addEventListener('click', async () => { await saveNow(); moyue.focusShelf(); window.close(); });
  $('#btnToc').addEventListener('click', () => toggleSidePanel());
  $('#btnTheme').addEventListener('click', () => setTheme(nextTheme(state.theme)));
  $('#btnType').addEventListener('click', () => { $('#typePanel').hidden = !$('#typePanel').hidden; });
  $('#btnBookmark').addEventListener('click', addBookmark);
  $('#btnFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });
  $('#errorBack').addEventListener('click', () => { moyue.focusShelf(); window.close(); });

  $('#tabToc').addEventListener('click', () => showPanelTab('toc'));
  $('#tabMarks').addEventListener('click', () => showPanelTab('marks'));

  $('#fontMinus').addEventListener('click', () => updateEff({ fontSize: Math.max(13, state.eff.fontSize - 1) }));
  $('#fontPlus').addEventListener('click', () => updateEff({ fontSize: Math.min(30, state.eff.fontSize + 1) }));
  $('#lineHeightSeg').addEventListener('click', (e) => {
    if (e.target.dataset.v) updateEff({ lineHeight: +e.target.dataset.v });
  });
  $('#fontFamilySeg').addEventListener('click', (e) => {
    if (e.target.dataset.v) updateEff({ fontFamily: e.target.dataset.v });
  });
  $('#marginRange').addEventListener('change', (e) => updateEff({ margin: +e.target.value }));
  $('#marginRange').addEventListener('input', (e) => { $('#marginLabel').textContent = e.target.value + 'px'; });
  $('#pageModeSeg').addEventListener('click', (e) => {
    if (!e.target.dataset.v) return;
    updateEff({ pageMode: e.target.dataset.v });
    state.renderer?.setMode?.(state.eff.pageMode);
  });
  $('#turnFxSeg').addEventListener('click', (e) => {
    if (!e.target.dataset.v) return;
    updateEff({ turnFx: e.target.dataset.v });
    state.renderer?.setTurnFx?.(state.eff.turnFx);
  });

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ':
        e.preventDefault(); state.renderer?.turnPage('next'); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        e.preventDefault(); state.renderer?.turnPage('prev'); break;
      case 't': case 'T': toggleSidePanel(); break;
      case 'm': case 'M': setTheme(nextTheme(state.theme)); break;
      case 'f': case 'F': $('#typePanel').hidden = !$('#typePanel').hidden; break;
      case 'h': case 'H': toggleHlPalette(); break;
      case 'n': case 'N': toggleAnnPanel(); break;
      case 'b': case 'B':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); addBookmark(); }
        break;
      case 'Escape':
        if (!$('#typePanel').hidden) { $('#typePanel').hidden = true; }
        else if (!$('#hlPalette').hidden) { toggleHlPalette(false); }
        else if (!$('#annPanel').classList.contains('hidden')) { toggleAnnPanel(false); }
        else if (state.tocOpen) toggleSidePanel(false);
        else { saveNow(); moyue.focusShelf(); window.close(); }
        break;
      case 'F11':
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
        break;
    }
  });

  // 时钟
  const tick = () => {
    const d = new Date();
    $('#statusClock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 20000);

  // 关闭前保存
  window.addEventListener('beforeunload', () => { saveNow(); });

  // ---------- 按格式打开 ----------
  setTheme(state.eff.theme, { persist: false });
  applyEffSettings();

  try {
    if (book.format === 'epub') {
      await openEpub(book);
    } else if (book.format === 'pdf') {
      await openPdf(book);
    } else if (book.format === 'mobi') {
      await openMobi(book);
    } else {
      await openTxt(book);
    }
  } catch (e) {
    console.error(e);
    showError(e.message || '打开失败，文件可能已损坏或格式不受支持');
  }
}

async function openEpub(book) {
  $('#epubView').hidden = false;
  const renderer = await createEpubReader({
    mount: $('#epubView'),
    url: moyue.bookUrl(book.id, book.format),
    position: book.progress?.locator || {},
    styles: {
      fontSize: state.eff.fontSize, lineHeight: state.eff.lineHeight,
      fontFamily: FONT_FAMILIES[state.eff.fontFamily] || FONT_FAMILIES.system, margin: state.eff.margin,
    },
    theme: THEMES[state.theme],
    pageMode: state.eff.pageMode,
    turnFx: state.eff.turnFx,
    annStore: state.annStore,
    onProgress: (p) => { updateStatus(p); scheduleSave({ percent: p.percent, locator: p.locator, label: p.chapterTitle }); },
    onToc: (toc) => { state.toc = toc; renderToc(); },
    onSelection: handleSelection,
  });
  state.renderer = renderer;
  afterOpen(renderer);
}

async function openPdf(book) {
  $('#pdfView').hidden = false;
  const renderer = await createPdfReader({
    mount: $('#pdfView'),
    url: moyue.bookUrl(book.id, book.format),
    position: book.progress?.locator || {},
    annStore: state.annStore,
    onProgress: (p) => { updateStatus(p); scheduleSave({ percent: p.percent, locator: p.locator, label: p.chapterTitle }); },
    onToc: (toc) => { state.toc = toc; renderToc(); },
    onSelection: handleSelection,
    onReady: () => { $('#loading').hidden = true; },
  });
  state.renderer = renderer;
  if (state.eff.pageMode === 'scroll') renderer.setMode?.('scroll');
  afterOpen(renderer);
  $('#loading').hidden = true;
}

async function openTxt(book) {
  const buffer = await moyue.readBookBuffer(book.id);
  const { text, encoding } = decodeTxt(new Uint8Array(buffer));
  if (!text.trim()) throw new Error('文本文件为空或无法解码');
  const chapters = splitChapters(text);
  const chapterData = chapters.map((c) => ({
    title: c.title,
    html: `<h2 class="chapter-title">${c.title}</h2>` + textToHtml(text.slice(c.start, c.end)),
  }));
  if (chapterData.length > 1 && book.title && /\.txt$/i.test(book.fileName || '')) {
    await moyue.updateBook(book.id, { title: book.title.replace(/\.txt$/i, '') });
    $('#bookTitle').textContent = book.title.replace(/\.txt$/i, '');
  }
  $('#textView').hidden = false;
  $('#textContent').classList.add('cjk-indent');
  await openTextCommon(book, chapterData, book.progress?.locator || {});
  if (encoding.startsWith('gb')) showToast(`已自动识别编码：${encoding.toUpperCase()}`);
}

async function openMobi(book) {
  const buffer = await moyue.readBookBuffer(book.id);
  const result = parseMobi(new Uint8Array(buffer));
  if (result.warnings.length) console.warn('MOBI 解析警告:', result.warnings);
  const chapters = mobiToChapters(sanitizeMobiHtml(result.rawHtml, result.images));
  if (result.meta.title && result.meta.title !== book.title) {
    await moyue.updateBook(book.id, { title: result.meta.title, author: result.meta.author || book.author });
    $('#bookTitle').textContent = result.meta.title;
  }
  $('#textView').hidden = false;
  await openTextCommon(book, chapters, book.progress?.locator || {});
  if (result.isK8) showToast('AZW3(KF8) 格式解析成功');
}

async function openTextCommon(book, chapters, locator) {
  const renderer = createTextReader({
    mount: $('#textView'),
    stage: $('#stage'),
    annStore: state.annStore,
    onProgress: (p) => {
      updateStatus(p);
      scheduleSave({ percent: p.percent, locator: p.locator, label: p.chapterTitle });
      markCurrentToc(p.chapterIndex);
    },
    onChapterChange: (title) => { $('#statusChapter').textContent = title; },
    onToc: (toc) => { state.toc = toc; renderToc(); },
    onSelection: handleSelection,
    onSelectionDrag: () => selToolbar.hide(),
  });
  renderer.setStyles({
    fontSize: state.eff.fontSize, lineHeight: state.eff.lineHeight,
    fontFamily: FONT_FAMILIES[state.eff.fontFamily] || FONT_FAMILIES.system, margin: state.eff.margin,
  });
  if (state.eff.pageMode === 'scroll') renderer.setMode('scroll');
  else if (state.eff.pageMode === 'dual') renderer.setMode('dual');
  else renderer.setMode('single');
  if (state.eff.turnFx) renderer.setTurnFx?.(state.eff.turnFx);
  renderer.load(chapters, locator);
  state.renderer = renderer;
  afterOpen(renderer);
}

function afterOpen(renderer) {
  $('#loading').hidden = true;
  // 初始状态刷新
  setTimeout(async () => {
    try {
      const s = await renderer.getState();
      updateStatus({ chapterTitle: s.chapterTitle, pageLabel: s.pageLabel, percent: s.percent });
      if (s.chapterTitle) markCurrentToc(s.chapterIndex ?? s.page);
    } catch { /* 忽略 */ }
  }, 600);
  renderer.setStyles && applyEffSettings();
}

init();
// 调试钩子（本地阅读器，无安全顾虑）
window.__moyueReader = state;
