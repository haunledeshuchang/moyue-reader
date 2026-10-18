/**
 * 墨阅 MoYue — PDF 渲染器（基于 pdf.js）
 * 连续滚动 + 懒渲染 + 缩放 + 大纲目录 + 页码进度
 * 文本层：透明可选中文字覆盖在画布上，支撑荧光笔高亮与批注（页内文本流偏移定位）
 */

import { wrapTextRange, textFlowOffset, colorFill } from '../annotations.js';

export async function createPdfReader({ mount, url, position, annStore, onProgress, onToc, onReady, onSelection }) {
  const pdfjs = await import('/src/vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/src/vendor/pdf.worker.mjs';

  // 自定义协议需整文件读取：pdf.js 的 url 参数走 XHR/ fetch 都可能受协议限制，
  // 且 Range 请求我们的协议处理器不支持，直接传 ArrayBuffer 最稳
  const res = await fetch(url);
  if (!res.ok) throw new Error('无法读取 PDF 文件（HTTP ' + res.status + '）');
  const data = await res.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const pagesEl = mount.querySelector('#pdfPages');
  const zoomLabel = mount.querySelector('#pdfZoomLabel');

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const slots = [];      // 每页整屏槽位（横向翻页时占满一屏并居中）
  const wraps = [];      // 每页紧贴画布的容器（canvas + 文本层，保证文本层与画布对齐）
  const canvases = [];
  const layers = [];     // 每页文本层根元素
  const renderedPages = new Set();
  let baseScale = 1;
  let zoomFactor = 1;
  let currentPageNum = 1;

  // ---------- 画布 + 文本层预创建 ----------
  for (let i = 1; i <= doc.numPages; i++) {
    const slot = document.createElement('div');
    slot.className = 'pdf-slot';
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.dataset.page = String(i);
    const c = document.createElement('canvas');
    c.className = 'pdf-page';
    const layer = document.createElement('div');
    layer.className = 'pdf-text-layer';
    wrap.appendChild(c);
    wrap.appendChild(layer);
    slot.appendChild(wrap);
    pagesEl.appendChild(slot);
    canvases.push(c);
    layers.push(layer);
    wraps.push(wrap);
    slots.push(slot);
  }

  async function computeBaseScale() {
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    // 默认“整页适配”：同时受宽、高约束，保证一屏内能看到完整一页（横向翻页不裁切）
    const availW = Math.max(160, (mount.clientWidth || window.innerWidth) - 96);
    const availH = Math.max(160, (mount.clientHeight || window.innerHeight) - 40);
    baseScale = Math.min(availW / vp.width, availH / vp.height);
    page.cleanup();
  }

  // ---------- 文本层（经典定位算法：逐 item 绝对定位 span） ----------
  async function renderTextLayer(page, num, vp) {
    const layer = layers[num - 1];
    if (!layer) return;
    layer.innerHTML = '';
    const tc = await page.getTextContent();
    const m = vp.transform;          // 视口变换矩阵（含 Y 轴翻转：屏上自上而下）
    const [a, b, c, d, e, f] = m;
    const frag = document.createDocumentFragment();
    for (const item of tc.items) {
      const tx = item.transform;
      if (!tx || !item.str) continue;
      const x = tx[4], y = tx[5];
      // 合并视口变换，得到屏上坐标
      const screenX = a * x + c * y + e;
      const screenY = b * x + d * y + f;
      const fs = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 10;
      const fontHeight = fs * Math.hypot(a, b);
      const span = document.createElement('span');
      span.style.left = screenX + 'px';
      span.style.top = (screenY - fontHeight * 0.8) + 'px';
      span.style.fontSize = fontHeight + 'px';
      span.style.fontFamily = '"Helvetica Neue", Arial, "Microsoft YaHei", sans-serif';
      span.textContent = item.str;
      frag.appendChild(span);
    }
    layer.appendChild(frag);
    // 重放该页既有高亮
    for (const a of (annStore ? annStore.forPage(num) : [])) {
      wrapTextRange(layer, a.loc.start, a.loc.end, { fill: colorFill(a.color), id: a.id });
    }
  }

  async function renderPage(num) {
    if (renderedPages.has(num)) return;
    renderedPages.add(num);
    const canvas = canvases[num - 1];
    try {
      const page = await doc.getPage(num);
      const vp = page.getViewport({ scale: baseScale * zoomFactor });
      canvas.width = Math.max(1, Math.floor(vp.width * dpr));
      canvas.height = Math.max(1, Math.floor(vp.height * dpr));
      canvas.style.width = Math.floor(vp.width) + 'px';
      canvas.style.height = Math.floor(vp.height) + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      // 文本层与画布同尺寸覆盖
      layers[num - 1].style.width = Math.floor(vp.width) + 'px';
      layers[num - 1].style.height = Math.floor(vp.height) + 'px';
      await renderTextLayer(page, num, vp);
      page.cleanup();
    } catch (e) {
      console.warn('PDF 页渲染失败', num, e.message);
      renderedPages.delete(num);
    }
  }

  let orientation = 'horizontal'; // 'horizontal'（左右翻页） | 'vertical'（纵向滚动）

  // 横向：每页占满一个“整屏槽位”并居中（一次只显示一页，像书页）；
  // 纵向：页面纵向堆叠。scroll-snap 挂在滚动容器 mount 上实现“翻一页”手感
  function layoutPages() {
    const horizontal = orientation === 'horizontal';
    const vw = mount.clientWidth || 800;
    const vh = mount.clientHeight || 600;
    pagesEl.style.display = 'flex';
    pagesEl.style.flexDirection = horizontal ? 'row' : 'column';
    pagesEl.style.flexWrap = 'nowrap';
    pagesEl.style.padding = horizontal ? '0' : '24px 0';
    pagesEl.style.gap = horizontal ? '0' : '24px';
    pagesEl.style.alignItems = horizontal ? 'stretch' : 'center';
    slots.forEach((slot) => {
      if (horizontal) {
        slot.style.flex = `0 0 ${vw}px`;
        slot.style.width = vw + 'px';
        slot.style.height = vh + 'px';
        slot.style.display = 'flex';
        slot.style.alignItems = 'center';
        slot.style.justifyContent = 'center';
        slot.style.scrollSnapAlign = 'start';
      } else {
        slot.style.flex = '0 0 auto';
        slot.style.width = '';
        slot.style.height = '';
        slot.style.display = 'block';
        slot.style.scrollSnapAlign = 'center';
      }
    });
    mount.style.scrollSnapType = horizontal ? 'x mandatory' : 'y mandatory';
    mount.style.overflowX = horizontal ? 'auto' : 'hidden';
    mount.style.overflowY = horizontal ? 'hidden' : 'auto';
  }

  function renderVisible() {
    const mr = mount.getBoundingClientRect();
    const horizontal = orientation === 'horizontal';
    const visibleStart = horizontal ? mr.left : mr.top;
    const visibleEnd = horizontal ? mr.right : mr.bottom;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const page = +c.closest('.pdf-page-wrap')?.dataset.page;
      if (!page) continue;
      const a = horizontal ? r.left : r.top;
      const b = horizontal ? r.right : r.bottom;
      if (b > visibleStart - 900 && a < visibleEnd + 900) renderPage(page);
    }
  }

  // ---------- 滚动进度 ----------
  let rafPending = false;
  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderVisible();
      const mr = mount.getBoundingClientRect();
      const horizontal = orientation === 'horizontal';
      const mid = horizontal ? mr.left + mr.width / 2 : mr.top + mr.height / 2;
      let best = 1, bestDist = Infinity;
      for (let i = 0; i < canvases.length; i++) {
        const r = canvases[i].getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const center = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
        const dist = Math.abs(center - mid);
        if (dist < bestDist) { bestDist = dist; best = i + 1; }
      }
      if (best !== currentPageNum) {
        currentPageNum = best;
        emitProgress();
      }
    });
  }

  function emitProgress() {
    onProgress?.({
      percent: currentPageNum / doc.numPages,
      chapterTitle: '',
      pageIndex: currentPageNum - 1,
      pageCount: doc.numPages,
      pageLabel: `第 ${currentPageNum} / ${doc.numPages} 页`,
      locator: { page: currentPageNum },
    });
  }

  // ---------- 翻页（平滑滚动到相邻页，左右方向） ----------
  function scrollToPage(num, smooth = true) {
    const horizontal = orientation === 'horizontal';
    const el = horizontal ? slots[num - 1] : wraps[num - 1];
    if (!el) return;
    el.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      inline: horizontal ? 'start' : 'start',
      block: horizontal ? 'nearest' : 'start',
    });
  }

  function turnPage(dir) {
    const target = currentPageNum + (dir === 'next' ? 1 : -1);
    if (target < 1 || target > doc.numPages) return;
    currentPageNum = target;
    scrollToPage(target);
    renderVisible();
    emitProgress();
  }

  // ---------- 缩放 ----------
  function setZoom(f) {
    zoomFactor = Math.min(4, Math.max(0.3, f));
    renderedPages.clear();
    for (let i = 0; i < canvases.length; i++) {
      canvases[i].width = 0; canvases[i].height = 0;
      canvases[i].style.width = ''; canvases[i].style.height = '';
      layers[i].innerHTML = '';
      layers[i].style.width = ''; layers[i].style.height = '';
    }
    requestAnimationFrame(() => {
      renderVisible();
      updateZoomLabel();
    });
  }

  function updateZoomLabel() {
    if (zoomLabel) zoomLabel.textContent = Math.round(baseScale * zoomFactor * 100) + '%';
  }

  mount.querySelector('#pdfZoomIn')?.addEventListener('click', () => setZoom(zoomFactor * 1.2));
  mount.querySelector('#pdfZoomOut')?.addEventListener('click', () => setZoom(zoomFactor / 1.2));
  mount.querySelector('#pdfFitWidth')?.addEventListener('click', () => setZoom(1));

  // ---------- 选中 → 标注 ----------
  mount.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const startLayer = range.startContainer.nodeType === 1
        ? range.startContainer.closest('.pdf-text-layer')
        : range.startContainer.parentElement?.closest('.pdf-text-layer');
      const endLayer = range.endContainer.nodeType === 1
        ? range.endContainer.closest('.pdf-text-layer')
        : range.endContainer.parentElement?.closest('.pdf-text-layer');
      if (!startLayer || startLayer !== endLayer) return; // 仅支持单页内选择
      const text = range.toString();
      if (!text.trim()) return;
      const page = +startLayer.parentElement.dataset.page;
      const a = textFlowOffset(startLayer, range.startContainer, range.startOffset);
      const b = textFlowOffset(startLayer, range.endContainer, range.endOffset);
      const rect = range.getBoundingClientRect();
      onSelection?.({
        format: 'pdf',
        page,
        start: Math.min(a, b),
        end: Math.max(a, b),
        text: text.slice(0, 300),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      });
    }, 10);
  });

  // ---------- 大纲 ----------
  async function loadOutline() {
    const tree = await doc.getOutline().catch(() => null);
    if (!tree?.length) return;
    const flat = [];
    async function walk(items, depth) {
      for (const it of items) {
        let page = null;
        try {
          const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
          if (dest) page = (await doc.getPageIndex(dest[0])) + 1;
        } catch { /* 忽略无法解析的目标 */ }
        flat.push({ label: (it.title || '').trim() || '(未命名)', page, depth });
        if (it.items?.length) await walk(it.items, depth + 1);
      }
    }
    await walk(tree, 0);
    if (flat.length) {
      onToc?.(flat.map((t) => ({ label: t.label, target: t.page ?? null, depth: t.depth })));
    }
  }

  // ---------- 初始化 ----------
  await computeBaseScale();
  updateZoomLabel();
  layoutPages();
  mount.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    renderedPages.clear();
    for (let i = 0; i < canvases.length; i++) {
      canvases[i].width = 0; canvases[i].height = 0;
      canvases[i].style.width = ''; canvases[i].style.height = '';
      layers[i].innerHTML = '';
      layers[i].style.width = ''; layers[i].style.height = '';
    }
    computeBaseScale().then(() => { renderVisible(); updateZoomLabel(); scrollToPage(currentPageNum, false); });
  });

  await renderPage(1);
  renderVisible();
  await loadOutline();

  // 恢复位置
  if (position?.page && position.page > 1 && canvases[position.page - 1]) {
    requestAnimationFrame(() => {
      scrollToPage(position.page, false);
      renderVisible();
    });
  }

  onReady?.();

  const meta = await doc.getMetadata().catch(() => null);

  return {
    format: 'pdf',
    meta: () => ({ title: (meta?.info?.Title || '').trim(), author: (meta?.info?.Author || '').trim() }),
    async goTo(target) {
      if (typeof target === 'number' && canvases[target - 1]) {
        currentPageNum = target;
        scrollToPage(target);
        renderVisible();
        emitProgress();
      } else if (target?.page && canvases[target.page - 1]) {
        currentPageNum = target.page;
        scrollToPage(target.page);
        renderVisible();
        emitProgress();
      }
    },
    next() { turnPage('next'); },
    prev() { turnPage('prev'); },
    turnPage,
    setTheme() { /* PDF 页面保持纸面白，仅界面跟随主题 */ },
    setStyles() { /* 版式设置对 PDF 不适用 */ },
    async getState() {
      return {
        page: currentPageNum,
        percent: currentPageNum / doc.numPages,
        chapterTitle: '',
        pageIndex: currentPageNum - 1,
        pageCount: doc.numPages,
        pageLabel: `第 ${currentPageNum} / ${doc.numPages} 页`,
      };
    },
    setZoom,
    setMode(mode) {
      orientation = mode === 'scroll' ? 'vertical' : 'horizontal';
      layoutPages();
      requestAnimationFrame(() => scrollToPage(currentPageNum, false));
    },
    applyAnnotation(ann) {
      const layer = layers[ann.loc.page - 1];
      if (layer) wrapTextRange(layer, ann.loc.start, ann.loc.end, { fill: colorFill(ann.color), id: ann.id });
    },
    removeAnnotation(ann) {
      const layer = layers[ann.loc.page - 1];
      const m = layer?.querySelector(`mark[data-ann="${ann.id}"]`);
      if (m) m.replaceWith(...m.childNodes);
    },
    async goToAnnotation(ann) {
      const el = canvases[ann.loc.page - 1];
      if (!el) return;
      currentPageNum = ann.loc.page;
      scrollToPage(ann.loc.page);
      renderVisible();
      emitProgress();
      setTimeout(() => {
        const m = layers[ann.loc.page - 1]?.querySelector(`mark[data-ann="${ann.id}"]`);
        m?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 500);
    },
    clearSelection() { document.getSelection()?.removeAllRanges(); },
    destroy() {
      mount.removeEventListener('scroll', onScroll);
      try { doc.cleanup(); } catch {}
    },
  };
}
