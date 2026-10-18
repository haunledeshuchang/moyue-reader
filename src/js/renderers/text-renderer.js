/**
 * 墨阅 MoYue — 文本渲染器（TXT / MOBI 共用）
 * CSS 多列分页 + 翻页手势引擎（拖拽跟手 / 越界橡皮筋 / 跨章预渲染滑移）
 * + 荧光笔高亮（文本流偏移定位）/ 批注跳转
 */
import { createPageTurn } from '../page-turn.js';
import { wrapTextRange, textFlowOffset, colorFill } from '../annotations.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// 翻页动画：与 CSS --ease-turn 保持一致
const TURN_MS = 320;
const TURN_EASE = 'cubic-bezier(.22,.61,.36,1)';

export function createTextReader({ mount, stage, annStore, onProgress, onChapterChange, onToc, onSelection, onSelectionDrag }) {
  const content = mount.querySelector('#textContent');

  // 跨章拖拽的“背面页”层：常驻但不可见（visibility 保持可测量），用 .on 显示
  const peek = document.createElement('div');
  peek.className = 'text-peek';
  mount.appendChild(peek);

  const state = {
    chapters: [],          // [{title, html}]
    chapterIndex: 0,
    pageIndex: 0,
    pageCount: 1,
    scrollMode: false,
    dualMode: false,       // 用户选择是否双页（书）
    effectiveDual: false,  // 实际是否双页（窄屏自动回退单页）
    turnFx: 'slide',
    destroyed: false,
    turning: false,
    // 版式（由 setStyles 注入，布局度量需要）
    fontSizePx: 18,
    lineHeightVal: 1.8,
    marginPx: 64,
    metrics: null,
    // 全书页码索引：pageOffsets[i] = 第 i 章之前的“叶”数，totalLeaves = 全书叶数
    pageOffsets: null,
    totalLeaves: 0,
    indexSig: '',
    indexBuilding: false,
  };

  // ---------- 布局 ----------
  // 版式度量。双页：每半屏一页，文字列与「中缝虚线」和「外侧边界」距离相等
  //（中缝两侧合计 2m，外侧 m），中间留白可用于旁批；单页：整页居中。
  function computeMetrics() {
    const W = Math.max(160, stage.clientWidth || 1);
    const H = Math.max(160, stage.clientHeight || 1);
    const dual = state.dualMode && !state.scrollMode && W >= 720;
    const fs = state.fontSizePx || 18;
    const lh = state.lineHeightVal || 1.8;
    const half = dual ? W / 2 : W;
    const margin = Math.max(8, Math.min(state.marginPx || 64, Math.round(half * 0.22)));
    const cap = fs * 42; // 单行最大字宽，避免超宽行读起来累
    let colW = Math.min(half - 2 * margin, cap);
    const minW = Math.min(dual ? 300 : 360, half - 24);
    if (colW < minW) colW = Math.max(160, Math.min(minW, half - 24));
    const gap = dual ? Math.max(16, half - colW) : Math.max(32, margin * 2);
    const stride = dual ? 2 * (colW + gap) : colW + gap;
    const offset = dual ? (half - colW) / 2 : (W - colW) / 2;
    const vpad = Math.max(8, Math.round(fs * lh)); // 上下各留一行空白
    return { W, H, dual, margin, colW, gap, stride, offset, vpad, contentH: Math.max(80, H - 2 * vpad) };
  }

  const stride = () => (state.metrics ? state.metrics.stride : (stage.clientWidth || 1));

  function isWideEnough() { return (stage.clientWidth || 0) >= 720; }
  function effectiveDual() { return state.dualMode && !state.scrollMode && isWideEnough(); }

  function layoutInto(el) {
    const mm = computeMetrics();
    state.metrics = mm;
    state.effectiveDual = mm.dual;
    el.style.columnWidth = mm.colW + 'px';
    el.style.columnGap = mm.gap + 'px';
    el.style.columnFill = 'auto';
    el.style.height = mm.contentH + 'px';
    el.style.padding = '0';
    // 关键：CSS 多列会把列宽“拉伸”到填满容器，必须显式给出宽度，
    // 否则列宽变成 (容器+gap)/n−gap，文字会顶到中缝和右边界。
    el.style.width = (mm.dual ? 2 * mm.colW + mm.gap : mm.colW) + 'px';
    el.style.top = mm.vpad + 'px';
    window.__moyueSetDual?.(mm.dual);
  }

  // 返回“翻页步数”：双页模式返回跨页数（2 叶 = 1 步），单页返回叶数
  function computePagesFor(el) {
    const mm = state.metrics;
    if (!mm) return 1;
    const per = mm.colW + mm.gap;
    const leaves = Math.max(1, Math.round((el.scrollWidth + mm.gap) / per));
    return state.effectiveDual ? Math.max(1, Math.ceil(leaves / 2)) : leaves;
  }

  function computePages() {
    if (state.scrollMode) { state.pageCount = 1; return; }
    state.pageCount = computePagesFor(content);
  }

  function applyColumnLayout() {
    if (state.scrollMode) return;
    layoutInto(content);
  }

  // ---------- 全书页码索引（左下角显示“总页码”，而非本章页码） ----------
  function layoutSig() {
    const mm = state.metrics;
    if (!mm) return '';
    return [mm.colW, mm.gap, mm.contentH, state.fontSizePx, state.lineHeightVal].join('|');
  }

  let indexPending = false;
  let indexTimer = null;

  function scheduleIndex(delay = 320) {
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => { buildPageIndex(); }, delay);
  }

  async function buildPageIndex() {
    if (state.scrollMode || !state.chapters.length || !state.metrics || state.destroyed) return;
    const sig = layoutSig();
    if (state.indexSig === sig && state.pageOffsets) return;
    if (state.indexBuilding) { indexPending = true; return; }
    state.indexBuilding = true;
    const mm = state.metrics;
    const per = mm.colW + mm.gap;
    const el = document.createElement('div');
    el.className = 'text-measure';
    mount.appendChild(el);
    el.style.columnWidth = mm.colW + 'px';
    el.style.columnGap = mm.gap + 'px';
    el.style.columnFill = 'auto';
    el.style.height = mm.contentH + 'px';
    el.style.width = (mm.dual ? 2 * mm.colW + mm.gap : mm.colW) + 'px';
    const offsets = [0];
    let acc = 0;
    let mark = performance.now();
    for (let i = 0; i < state.chapters.length; i++) {
      if (state.destroyed) { el.remove(); state.indexBuilding = false; return; }
      // 版式变了（窗口缩放 / 字号改变）→ 放弃本次，稍后用新度量重算
      if (layoutSig() !== sig) { el.remove(); state.indexBuilding = false; indexPending = true; break; }
      el.innerHTML = state.chapters[i].html;
      acc += Math.max(1, Math.round((el.scrollWidth + mm.gap) / per));
      offsets.push(acc);
      // 时间片让位：每 12ms 交还主线程，避免测全书时卡住翻页
      if (performance.now() - mark > 12) {
        await new Promise((r) => setTimeout(r, 0));
        mark = performance.now();
      }
    }
    el.remove();
    state.indexBuilding = false;
    if (state.destroyed) return;
    if (layoutSig() === sig) {
      state.pageOffsets = offsets;
      state.totalLeaves = Math.max(1, acc);
      state.indexSig = sig;
      emitProgress();
    }
    if (indexPending) { indexPending = false; buildPageIndex(); }
  }

  function globalLeaf() {
    const off = state.pageOffsets?.[state.chapterIndex] || 0;
    return off + state.pageIndex * (state.effectiveDual ? 2 : 1);
  }

  function setTranslate(x) {
    content.style.transform = `translate3d(${x}px,0,0)`;
  }

  function baseTranslate() {
    const mm = state.metrics;
    if (!mm) return 0;
    return mm.offset - state.pageIndex * mm.stride;
  }

  function goToPage(page, { silent = false } = {}) {
    if (state.scrollMode) { state.pageIndex = 0; return; }
    const max = Math.max(0, state.pageCount - 1);
    state.pageIndex = Math.min(Math.max(0, page), max);
    setTranslate(baseTranslate());
    if (!silent) emitProgress();
    warmPeek();
  }

  /** 程序化翻页（箭头 / 键盘 / 轻点）的平滑动画：滑动 / 淡入 / 无 */
  async function animateTo(page) {
    if (state.scrollMode) { state.pageIndex = 0; emitProgress(); return; }
    const max = Math.max(0, state.pageCount - 1);
    page = Math.min(Math.max(0, page), max);
    if (page === state.pageIndex) return;
    state.pageIndex = page;
    const fx = state.turnFx;
    if (fx === 'none') {
      setTranslate(baseTranslate());
      emitProgress();
      return;
    }
    if (fx === 'fade') {
      content.style.transition = 'opacity .16s ease';
      content.style.opacity = '0';
      await wait(160);
      setTranslate(baseTranslate());
      await raf2();
      content.style.transition = 'opacity .2s ease';
      content.style.opacity = '1';
      emitProgress();
      return;
    }
    // slide（默认，参考 Moon+ / WPS 的整页滑动手感：整条书页一起平移）
    content.style.transition = `transform ${TURN_MS}ms ${TURN_EASE}`;
    setTranslate(baseTranslate());
    await wait(TURN_MS + 10);
    content.style.transition = '';
    emitProgress();
  }

  function currentPageLabel() {
    if (state.scrollMode) return '滚动';
    // 索引就绪 → 全书总页码（如 第 276/556 页），与 WPS PDF 一致
    if (state.pageOffsets && state.totalLeaves > 1) {
      const total = state.totalLeaves;
      const leaf = globalLeaf();
      if (state.effectiveDual) {
        // 双页：一次翻一屏，编号按“屏”计 —— 每次翻页严格 +1
        const spreads = Math.max(1, Math.ceil(total / 2));
        const cur = Math.min(spreads, Math.floor(leaf / 2) + 1);
        return `第 ${cur} / ${spreads} 页`;
      }
      return `第 ${Math.min(total, leaf + 1)} / ${total} 页`;
    }
    return `第 ${state.pageIndex + 1} / ${state.pageCount} 页`;
  }

  function emitProgress() {
    const chapter = state.chapters[state.chapterIndex];
    onProgress?.({
      chapterIndex: state.chapterIndex,
      chapterTitle: chapter?.title || '',
      pageIndex: state.pageIndex,
      pageCount: state.pageCount,
      pageLabel: currentPageLabel(),
      percent: chapterPercent(),
      locator: { chapterIndex: state.chapterIndex, pageIndex: state.pageIndex },
    });
  }

  function chapterPercent() {
    if (!state.chapters.length) return 0;
    if (state.pageOffsets && state.totalLeaves > 1) {
      return Math.min(1, (Math.min(state.totalLeaves, globalLeaf() + 1)) / state.totalLeaves);
    }
    const per = 1 / state.chapters.length;
    const within = state.scrollMode
      ? (content.scrollTop / Math.max(1, content.scrollHeight - content.clientHeight))
      : (state.pageCount <= 1 ? 0 : state.pageIndex / Math.max(1, state.pageCount - 1));
    return Math.min(1, state.chapterIndex * per + within * per);
  }

  // ---------- 章节渲染 ----------
  function renderChapterInto(el, index) {
    el.innerHTML = state.chapters[index].html;
    applyChapterHighlights(el, index);
    layoutInto(el);
  }

  function renderChapter(index, page = 0) {
    const ch = state.chapters[index];
    if (!ch) return;
    state.chapterIndex = index;
    renderChapterInto(content, index);
    content.style.transition = 'none';
    setTranslate(0);
    state.pageIndex = 0;
    applyColumnLayout();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (state.destroyed) return;
        computePages();
        goToPage(page);
        onChapterChange?.(ch.title, index);
      });
    });
  }

  // ---------- 高亮 ----------
  function applyChapterHighlights(el, index) {
    if (!annStore) return;
    for (const a of annStore.forChapter(index)) {
      wrapTextRange(el, a.loc.start, a.loc.end, { fill: colorFill(a.color), id: a.id });
    }
  }

  // ---------- 跨章滑移（翻页引擎 + 程序化共用） ----------
  let dragDir = null;
  let peekReady = false;
  let peekFor = null;   // {dir, index} 当前 peek 渲染的章节
  let peekPending = false;
  let lastDx = 0;

  function peekPages() { return computePagesFor(peek); }

  function peekStartX(dir, pages) {
    const tp = dir === 'next' ? 0 : pages - 1;
    return dir === 'next' ? stride() : -(tp * stride()) - stride();
  }

  function peekInX(dir, pages) {
    const tp = dir === 'next' ? 0 : pages - 1;
    return dir === 'next' ? 0 : -(tp * stride());
  }

  function moveVisual(dx) {
    lastDx = dx;
    setTranslate(baseTranslate() + dx);
    if (peekReady && dragDir) {
      const pages = peekPages();
      peek.style.transform = `translate3d(${peekStartX(dragDir, pages) + dx}px,0,0)`;
    }
  }

  /** 预渲染邻章到 peek 层；show=false 时仅预热（隐藏但可测量） */
  function preparePeek(dir, index, show) {
    if (peekReady && peekFor && peekFor.index === index) {
      if (show) peek.classList.add('on');
      return;
    }
    if (peekPending) return;
    peekPending = true;
    peekFor = { dir, index };
    renderChapterInto(peek, index);
    // 布局后测量页数并摆到屏幕外起点（双 rAF 等列布局稳定）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      peekPending = false;
      if (state.destroyed) return;
      const pages = peekPages();
      peek.style.transition = 'none';
      peek.style.transform = `translate3d(${peekStartX(dir, pages)}px,0,0)`;
      peekReady = true;
      if (show && dragDir) peek.classList.add('on');
      moveVisual(lastDx); // 拖拽可能已在进行，立即同步
    }));
  }

  function hidePeek() {
    peek.classList.remove('on');
    peekReady = false;
    peekFor = null;
    dragDir = null;
    peek.innerHTML = '';
  }

  /** 停在章节首/末页时预热邻章，保证跨章拖拽第一帧就有背面页 */
  function warmPeek() {
    if (state.scrollMode || state.turning || peekPending) return;
    if (state.pageIndex >= state.pageCount - 1 && state.chapterIndex < state.chapters.length - 1) {
      preparePeek('next', state.chapterIndex + 1, false);
    } else if (state.pageIndex === 0 && state.chapterIndex > 0) {
      preparePeek('prev', state.chapterIndex - 1, false);
    }
  }

  async function completeChapterTurn(dir) {
    state.turning = true;
    const idx = state.chapterIndex + (dir === 'next' ? 1 : -1);
    const fx = state.turnFx;

    if (fx === 'none') {
      // 无动画：直接换章落位
      state.chapterIndex = idx;
      content.innerHTML = state.chapters[idx].html;
      applyChapterHighlights(content, idx);
      layoutInto(content);
      await raf2();
      if (state.destroyed) return;
      computePages();
      state.pageIndex = dir === 'next' ? 0 : state.pageCount - 1;
      content.style.transition = 'none';
      setTranslate(baseTranslate());
      hidePeek();
      await raf2();
      content.style.transition = '';
      state.turning = false;
      emitProgress();
      onChapterChange?.(state.chapters[idx].title, idx);
      return;
    }

    if (fx === 'fade') {
      // 淡入：原位淡出 → 换章 → 淡入
      content.style.transition = 'opacity .16s ease';
      content.style.opacity = '0';
      await wait(170);
      state.chapterIndex = idx;
      content.innerHTML = state.chapters[idx].html;
      applyChapterHighlights(content, idx);
      layoutInto(content);
      await raf2();
      if (state.destroyed) return;
      computePages();
      state.pageIndex = dir === 'next' ? 0 : state.pageCount - 1;
      content.style.transition = 'none';
      setTranslate(baseTranslate());
      hidePeek();
      await raf2();
      content.style.transition = 'opacity .22s ease';
      content.style.opacity = '1';
      state.turning = false;
      emitProgress();
      onChapterChange?.(state.chapters[idx].title, idx);
      return;
    }

    // slide（默认）：当前页滑出 + 邻章滑入，链条连续，速度不断档
    const pages = peekPages();
    const dur = TURN_MS;
    const ease = TURN_EASE;
    content.style.transition = `transform ${dur}ms ${ease}`;
    peek.style.transition = `transform ${dur}ms ${ease}`;
    setTranslate(baseTranslate() + (dir === 'next' ? -stride() : stride()));
    peek.style.transform = `translate3d(${peekInX(dir, pages)}px,0,0)`;
    await wait(dur);

    // 换章：主带内容与 peek 视觉一致，直接落位（无缝）
    state.chapterIndex = idx;
    content.innerHTML = state.chapters[idx].html;
    applyChapterHighlights(content, idx);
    layoutInto(content);
    await raf2();
    if (state.destroyed) return;
    computePages();
    const landPage = dir === 'next' ? 0 : state.pageCount - 1;
    state.pageIndex = landPage;
    content.style.transition = 'none';
    setTranslate(baseTranslate());
    hidePeek();
    await raf2();
    content.style.transition = '';
    state.turning = false;
    emitProgress();
    onChapterChange?.(state.chapters[idx].title, idx);
  }

  async function waitPeekReady(timeout = 500) {
    const t0 = Date.now();
    while (!peekReady && Date.now() - t0 < timeout) await wait(30);
    return peekReady;
  }

  function atBookStart() { return state.chapterIndex === 0 && state.pageIndex === 0; }
  function atBookEnd() {
    return state.chapterIndex >= state.chapters.length - 1 && state.pageIndex >= state.pageCount - 1;
  }
  function canGoBook(dir) {
    if (state.scrollMode) return true;
    return dir === 'next' ? !atBookEnd() : !atBookStart();
  }

  /** 程序化翻页（箭头 / 键盘 / 轻点） */
  async function turnPage(dir) {
    if (state.scrollMode) {
      content.scrollTop += (dir === 'next' ? 1 : -1) * (stage.clientHeight || 1) * 0.92;
      emitProgress();
      return;
    }
    if (state.turning) return;
    if (dir === 'next') {
      if (state.pageIndex < state.pageCount - 1) { await animateTo(state.pageIndex + 1); return; }
      if (state.chapterIndex < state.chapters.length - 1) {
        state.turning = true;
        dragDir = 'next';
        preparePeek('next', state.chapterIndex + 1, true);
        await raf2();
        if (await waitPeekReady()) await completeChapterTurn('next');
        else { hidePeek(); renderChapter(state.chapterIndex + 1, 0); state.turning = false; }
      }
    } else {
      if (state.pageIndex > 0) { await animateTo(state.pageIndex - 1); return; }
      if (state.chapterIndex > 0) {
        state.turning = true;
        dragDir = 'prev';
        preparePeek('prev', state.chapterIndex - 1, true);
        await raf2();
        if (await waitPeekReady()) await completeChapterTurn('prev');
        else { hidePeek(); renderChapter(state.chapterIndex - 1, 0); state.turning = false; }
      }
    }
  }

  // ---------- 长按选择（Word 式：选词 → 拖动扩展） ----------
  const WORD_RE = /[\w\u4e00-\u9fa5\u3040-\u30ff]/;

  function caretAt(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); range.collapse(true); }
    }
    if (!range || !content.contains(range.startContainer)) return null;
    return range;
  }

  function expandWord(range) {
    const node = range.startContainer;
    if (!node || node.nodeType !== 3) return null;
    const text = node.nodeValue;
    let s = range.startOffset;
    let e = s;
    while (s > 0 && WORD_RE.test(text[s - 1])) s--;
    while (e < text.length && WORD_RE.test(text[e])) e++;
    if (e <= s) return null;
    const r = document.createRange();
    r.setStart(node, s);
    r.setEnd(node, e);
    return r;
  }

  let lpAnchor = null;

  function onLongPress(x, y) {
    const caret = caretAt(x, y);
    if (!caret) return;
    const r = expandWord(caret);
    if (!r) return;
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    lpAnchor = { node: r.startContainer, offset: r.startOffset };
    const ctx = getSelectionContext();
    if (ctx) onSelection?.(ctx);
  }

  function onLongPressMove(x, y) {
    if (!lpAnchor) return;
    const caret = caretAt(x, y);
    if (!caret) return;
    const sel = document.getSelection();
    try { sel.setBaseAndExtent(lpAnchor.node, lpAnchor.offset, caret.startContainer, caret.startOffset); } catch { /* 忽略 */ }
    onSelectionDrag?.();
  }

  function onLongPressEnd() {
    const ctx = getSelectionContext();
    if (ctx) onSelection?.(ctx);
    lpAnchor = null;
  }

  // ---------- 翻页引擎 ----------
  const engine = createPageTurn({
    viewport: mount,
    canGo: (dir) => canGoBook(dir),
    canMove: (dir) => canGoBook(dir),
    enabled: () => !state.scrollMode && !state.turning && !state.destroyed,
    onDragStart(dir) {
      dragDir = dir;
      lastDx = 0;
      document.getSelection()?.removeAllRanges();
      content.style.transition = 'none';
      const atEdge = dir === 'next' ? state.pageIndex >= state.pageCount - 1 : state.pageIndex === 0;
      const hasNeighbor = dir === 'next'
        ? state.chapterIndex < state.chapters.length - 1
        : state.chapterIndex > 0;
      if (atEdge && hasNeighbor) {
        preparePeek(dir, state.chapterIndex + (dir === 'next' ? 1 : -1), true);
      }
    },
    onDragMove(raw, dir, damped) { moveVisual(damped); },
    async onDragEnd(raw, vx, dir, confirmed) {
      if (state.scrollMode) return;
      if (!confirmed) {
        // 回弹
        content.style.transition = 'transform .34s cubic-bezier(.2,.8,.3,1)';
        if (peekReady) {
          const pages = peekPages();
          peek.style.transition = 'transform .34s cubic-bezier(.2,.8,.3,1)';
          peek.style.transform = `translate3d(${peekStartX(dir, pages)}px,0,0)`;
        }
        setTranslate(baseTranslate());
        const hadPeek = peekReady;
        dragDir = null;
        if (hadPeek) setTimeout(() => { if (!dragDir && !state.turning) hidePeek(); }, 360);
        return;
      }
      if (peekReady) {
        await completeChapterTurn(dir);
      } else {
        const atEdge = dir === 'next' ? state.pageIndex >= state.pageCount - 1 : state.pageIndex === 0;
        const hasNeighbor = dir === 'next'
          ? state.chapterIndex < state.chapters.length - 1
          : state.chapterIndex > 0;
        if (atEdge && hasNeighbor) {
          // peek 尚未就绪（刚越界就松手）→ 等待或降级直接换章
          state.turning = true;
          if (await waitPeekReady()) await completeChapterTurn(dir);
          else { hidePeek(); renderChapter(state.chapterIndex + (dir === 'next' ? 1 : -1), 0); state.turning = false; }
        } else {
          // 章内确认翻页：从拖拽位置平滑滑到目标页（不再瞬移）
          animateTo(state.pageIndex + (dir === 'next' ? 1 : -1));
          dragDir = null;
        }
      }
    },
    onTurn(dir) { turnPage(dir); },
    onLongPress,
    onLongPressMove,
    onLongPressEnd,
    onHover: (x, y) => window.__moyueHover?.(x, y),
  });

  // ---------- 版式 ----------
  function setStyles(styles) {
    state.fontSizePx = styles.fontSize;
    state.lineHeightVal = styles.lineHeight;
    state.marginPx = styles.margin;
    const root = document.documentElement;
    root.style.setProperty('--reader-font-size', styles.fontSize + 'px');
    root.style.setProperty('--reader-line-height', String(styles.lineHeight));
    root.style.setProperty('--reader-font-family', styles.fontFamily);
    root.style.setProperty('--reader-margin', styles.margin + 'px');
    root.style.setProperty('--reader-vpad', Math.round(styles.fontSize * styles.lineHeight) + 'px');
    if (!state.scrollMode) {
      applyColumnLayout();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        computePages();
        goToPage(state.pageIndex, { silent: true });
        scheduleIndex(240);
      }));
    }
  }

  function setMode(mode) {
    hidePeek();
    const leafBefore = state.scrollMode ? 0 : (state.effectiveDual ? state.pageIndex * 2 : state.pageIndex);
    state.scrollMode = mode === 'scroll';
    state.dualMode = mode === 'dual';
    mount.classList.toggle('scroll-mode', state.scrollMode);
    if (state.scrollMode) {
      content.style.transition = '';
      content.style.transform = 'none';
      content.style.opacity = '1';
      content.style.columnWidth = 'auto';
      content.style.columnGap = '0';
      content.style.width = '100%';
      content.style.height = '100%';
      content.style.top = '0';
      content.scrollTop = 0;
      computePages();
      emitProgress();
      window.__moyueSetDual?.(false);
      return;
    }
    // 单页 / 双页：按“叶”近似保留阅读位置
    applyColumnLayout();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      computePages();
      const target = state.effectiveDual
        ? Math.min(state.pageCount - 1, Math.max(0, Math.floor(leafBefore / 2)))
        : Math.min(state.pageCount - 1, Math.max(0, leafBefore));
      goToPage(target, { silent: true });
      emitProgress();
      scheduleIndex(240);
    }));
  }

  function setTurnFx(fx) { state.turnFx = fx || 'slide'; }

  // ---------- 选中 → 标注上下文 ----------
  function getSelectionContext() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;
    const text = range.toString();
    if (!text.trim()) return null;
    const a = textFlowOffset(content, range.startContainer, range.startOffset);
    const b = textFlowOffset(content, range.endContainer, range.endOffset);
    const rect = range.getBoundingClientRect();
    return {
      format: 'text',
      chapter: state.chapterIndex,
      start: Math.min(a, b),
      end: Math.max(a, b),
      text: text.slice(0, 300),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }

  function clearSelection() { document.getSelection()?.removeAllRanges(); }

  // ---------- 对外 API ----------
  const api = {
    format: 'text',
    load(chapters, position = {}) {
      state.chapters = chapters;
      state.pageOffsets = null;
      state.totalLeaves = 0;
      state.indexSig = '';
      renderChapter(position.chapterIndex || 0, position.pageIndex || 0);
      onToc?.(chapters.map((c, i) => ({ label: c.title, target: i })));
      scheduleIndex(500);
    },
    next() { return turnPage('next'); },
    prev() { return turnPage('prev'); },
    turnPage,
    goTo(target) {
      if (typeof target === 'number') renderChapter(target, 0);
      else if (target?.chapterIndex !== undefined) renderChapter(target.chapterIndex, target.pageIndex || 0);
    },
    goToChapter(index, page = 0) { renderChapter(index, page); },
    nextChapter() { return turnPage('next'); },
    prevChapter() { return turnPage('prev'); },
    getState() {
      return {
        chapterIndex: state.chapterIndex,
        pageIndex: state.pageIndex,
        scrollTop: state.scrollMode ? content.scrollTop : 0,
        chapterTitle: state.chapters[state.chapterIndex]?.title || '',
        pageCount: state.pageCount,
        pageLabel: currentPageLabel(),
      };
    },
    setStyles,
    setMode,
    setTurnFx,
    getSelectionContext,
    clearSelection,
    getContentElement: () => content,
    /** 新建标注后重绘当前章（保持页位置） */
    applyAnnotation(ann) {
      if (ann.loc?.chapter === state.chapterIndex) renderChapter(state.chapterIndex, state.pageIndex);
    },
    removeAnnotation(ann) {
      if (ann.loc?.chapter === state.chapterIndex) renderChapter(state.chapterIndex, state.pageIndex);
    },
    async goToAnnotation(ann) {
      if (!ann.loc) return;
      if (ann.loc.chapter !== state.chapterIndex) {
        renderChapter(ann.loc.chapter, 0);
        await raf2();
        await raf2();
      }
      const mark = content.querySelector(`mark[data-ann="${ann.id}"]`);
      if (!mark) return;
      const mm = state.metrics;
      if (!mm) return;
      // 高亮相对当前页的水平位移 / 每步位移 = 需要翻几步
      const cRect = content.getBoundingClientRect();
      const mRect = mark.getBoundingClientRect();
      const steps = Math.round((mRect.left - cRect.left) / mm.stride);
      goToPage(state.pageIndex + steps);
    },
    refresh() {
      applyColumnLayout();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        computePages();
        goToPage(state.pageIndex, { silent: true });
        scheduleIndex(240);
      }));
    },
    destroy() {
      state.destroyed = true;
      clearTimeout(indexTimer);
      engine.destroy();
    },
  };

  // 滚动模式进度
  mount.addEventListener('scroll', () => {
    if (state.scrollMode) emitProgress();
  }, { passive: true });

  // 选中结束 → 弹出标注工具栏（由 reader 统一展示）
  mount.addEventListener('mouseup', () => {
    if (state.scrollMode) return;
    setTimeout(() => {
      const ctx = getSelectionContext();
      if (ctx) onSelection?.(ctx);
    }, 10);
  });

  // 窗口尺寸变化：保持阅读比例，并重算全书页码
  const ro = new ResizeObserver(() => {
    if (state.destroyed) return;
    if (state.scrollMode) { computePages(); return; }
    const oldPages = state.pageCount;
    applyColumnLayout();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      computePages();
      const ratio = oldPages > 1 ? state.pageIndex / (oldPages - 1) : 0;
      goToPage(Math.round(ratio * (state.pageCount - 1)), { silent: true });
      emitProgress();
      scheduleIndex(400);
    }));
  });
  ro.observe(stage);

  return api;
}

/** MOBI HTML 消毒：Kindle 私有标记清理 + 图片 recindex 替换为 data URL */
export function sanitizeMobiHtml(rawHtml, images) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  // 移除 Kindle 私有/无用节点
  doc.querySelectorAll('guide, metadata, link, style, script').forEach((n) => n.remove());
  // 图片：recindex → data URL
  doc.querySelectorAll('img').forEach((img) => {
    const rec = img.getAttribute('recindex');
    if (rec !== null && images.has(+rec)) {
      const im = images.get(+rec);
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < im.data.length; i += chunk) {
        bin += String.fromCharCode(...im.data.subarray(i, i + chunk));
      }
      img.setAttribute('src', `data:${im.mediaType};base64,${btoa(bin)}`);
    } else {
      img.remove();
    }
  });
  // mbp: 私有标签处理。
  // 背景：HTML 解析器把自闭合的 <mbp:pagebreak/> 当作未闭合开标签，导致后续全部内容
  // 成为其子节点（实测单本 82 万字符的书被吞掉 98%）。
  // 正确做法：把标签替换为无害分隔标记，同时**保留其子内容**——
  // 注意 replaceWith/remove 会连子内容一起删掉，必须先把子节点搬出来。
  const replaceKeepChildren = (n, marker) => {
    const parent = n.parentNode;
    if (!parent) return;
    parent.insertBefore(marker, n);
    while (n.firstChild) parent.insertBefore(n.firstChild, n); // 按原顺序搬到 marker 之后
    parent.removeChild(n);
  };
  doc.querySelectorAll('mbp\\:pagebreak').forEach((n) => {
    const hr = doc.createElement('hr');
    hr.className = 'mobi-pagebreak';
    replaceKeepChildren(n, hr);
  });
  doc.querySelectorAll('mbp\\:frameset, mbp\\:magnification').forEach((n) => {
    replaceKeepChildren(n, doc.createElement('span'));
  });
  // filepos 链接（无法跳转，降级为纯文本）
  doc.querySelectorAll('a[filepos]').forEach((a) => {
    const span = doc.createElement('span');
    span.textContent = a.textContent;
    a.replaceWith(span);
  });
  // 清理危险属性
  doc.querySelectorAll('*').forEach((n) => {
    for (const attr of [...n.attributes]) {
      if (attr.name.startsWith('on')) n.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML;
}
