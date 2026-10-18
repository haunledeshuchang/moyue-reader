/**
 * 墨阅 MoYue — EPUB 渲染器（基于 epub.js）
 * 主题注入 / 版式同步 / CFI 进度记忆 / 目录
 * 翻页：iframe 跟手滑动 + 滑出→换页→滑入链条动画（带书页阴影与轻微 3D 倾角）
 * 标注：epub.js annotations（CFI 定位，跨页自动重挂）
 */

// epub.js 默认用 XMLHttpRequest，但 Electron 下 XHR 访问自定义协议会挂起，
// 这里提供基于 fetch 的 requestMethod（语义与 epub.js 内部 request 完全一致）
async function fetchRequest(url, type, withCredentials, headers) {
  const res = await fetch(url, {
    credentials: withCredentials ? 'include' : 'same-origin',
    headers: headers || {},
  });
  if (!res.ok) {
    throw { status: res.status, message: res.statusText || '请求失败', stack: new Error().stack };
  }
  if (type === 'binary') return res.arrayBuffer();
  if (type === 'blob') return res.blob();
  const text = await res.text();
  if (type === 'json') return JSON.parse(text);
  // type 未传时按 URL 扩展名推断（与 epub.js 一致）
  const ext = type || (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  if (['xml', 'opf', 'ncx'].includes(ext)) {
    return new DOMParser().parseFromString(text, 'text/xml');
  }
  if (ext === 'xhtml') {
    // 浏览器 DOMParser 不支持 application/xhtml+xml，用 application/xml 等效替代
    return new DOMParser().parseFromString(text, 'application/xml');
  }
  if (ext === 'html' || ext === 'htm') {
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return text;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

import { colorFill } from '../annotations.js';
import { createPageTurn } from '../page-turn.js';

export async function createEpubReader({ mount, url, position, styles, theme, annStore, onProgress, onToc, onSelection, pageMode = 'dual', turnFx = 'slide' }) {
  const book = ePub(url, { requestMethod: fetchRequest });
  await book.opened;

  let currentTheme = theme;
  let currentStyles = styles;

  // 阅读区内的“书页”容器：上下各留一行空白（左右留白交给 epub.js 的 column gap，
  // 这样双页时「外边距」与「中缝间距」严格等距）
  let inner = mount.querySelector('.epub-inner');
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'epub-inner';
    mount.appendChild(inner);
  }
  const vpadOf = () => Math.max(8, Math.round(currentStyles.fontSize * currentStyles.lineHeight));
  const vp0 = vpadOf();
  inner.style.cssText = `position:absolute;left:0;right:0;top:${vp0}px;bottom:${vp0}px;overflow:hidden;`;

  // 等待挂载点完成布局（窗口刚创建时可能为 0 尺寸）
  let rect = mount.getBoundingClientRect();
  for (let i = 0; (rect.width < 40 || rect.height < 40) && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    rect = mount.getBoundingClientRect();
  }

  const wide = (rect.width || 0) >= 720;
  const wantDual = pageMode === 'dual' && wide;
  const wantScroll = pageMode === 'scroll';

  /**
   * 版式几何：与文本渲染器同一套「等比留白」算法。
   *
   * 关键坑：epub.js 的 layout.calculate() 在单页（divisor = 1）下**完全忽略 gap**，
   * 直接令 columnWidth = 舞台宽；若仍用「满宽舞台 + 巨大 padding」伪装左右留白，
   * 内部几何就与真实 DOM 对不上（displayed.total 被算成 2、翻页按整屏宽跳字）。
   * 所以：双页用 gap 撑出中缝（epub.js 会把 gap/2 作为左右内边距），
   * 单页把「舞台」本身收窄到版心宽再水平居中，两种模式下内部几何都严格自洽。
   */
  function geomFor(dual, W) {
    const half = dual ? W / 2 : W;
    const m = Math.max(8, Math.min(currentStyles.margin || 64, Math.round(half * 0.22)));
    const cap = (currentStyles.fontSize || 18) * 42; // 单行最大字宽
    const colW = Math.max(160, Math.round(Math.min(half - 2 * m, cap)));
    if (dual) {
      return { stageW: Math.round(W), left: 0, colW, gap: Math.max(16, Math.round(half - colW)) };
    }
    return { stageW: colW, left: Math.max(0, Math.round((W - colW) / 2)), colW, gap: 0 };
  }

  /** 把舞台摆到计算好的位置（上下各留一行 vp） */
  function applyStage(geo, vp) {
    inner.style.cssText =
      `position:absolute;left:${geo.left}px;top:${vp}px;width:${geo.stageW}px;bottom:${vp}px;overflow:hidden;`;
  }

  const geo0 = wantScroll
    ? { stageW: Math.round(rect.width) || 800, left: 0, colW: Math.round(rect.width) || 800, gap: 0 }
    : geomFor(wantDual, Math.floor(rect.width) || 800);
  applyStage(geo0, vp0);

  // 必须传显式像素尺寸：传 '100%' 时 epub.js 在布局未稳定的窗口里
  // 会把舞台测成内容的自然宽度（实测 19040px），导致分页失效、无法翻页
  const rendition = book.renderTo(inner, {
    width: geo0.stageW,
    height: Math.max(200, Math.floor(rect.height) - 2 * vp0) || 600,
    flow: wantScroll ? 'scrolled-continuous' : 'paginated',
    spread: wantDual ? 'always' : 'never',
    minSpreadWidth: 720,
    gap: geo0.gap,
    allowScriptedContent: false,
    allowPopups: false,
  });

  // 当前模式（须在 relocated 处理前声明，避免 TDZ）
  let curPageMode = pageMode;
  let curTurnFx = turnFx;

  // 「每页字符数」采样：按版式签名分桶，版式一变整桶作废（见 layoutKey）
  let cplKey = '';
  const cplSamples = [];
  let cplLocked = 0; // 采样够数后锁定的每栏字符数（避免读着读着总页数变来变去）
  const chapterBaseCol = new Map(); // spineIndex -> 该章第 1 栏的全书序号（0 起）

  // 窗口尺寸变化时重新分页（保留当前阅读位置），并在宽窄跨越阈值时切换单/双页
  let resizeTimer = null;
  let lastDual = wantDual;

  /**
   * 重新分栏并回到原位置。
   * epub.js 的 resize 在「尺寸未变」时会直接 return，且 clear() 之后不会自己重新渲染，
   * 所以这里先清掉它缓存的舞台尺寸，再手动 display(cfi) 恢复。
   */
  async function relayoutAndRestore(preCfi) {
    const r = inner.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    let cfi = preCfi || lastCfi || null;
    if (!cfi) { try { cfi = rendition.currentLocation()?.start?.cfi; } catch { /* 忽略 */ } }
    try { if (rendition.manager) rendition.manager._stageSize = undefined; } catch { /* 忽略 */ }
    // 必须把 cfi 传给 resize：epub.js 在 RESIZED 事件里会用它重新 display，
    // 否则会在清空视图后回到全书开头
    try { rendition.resize(Math.floor(r.width), Math.floor(r.height), cfi || undefined); } catch { /* 忽略 */ }
    if (!cfi) return;
    // resize 后第一次 display 时新 iframe 还没完成排版，定位会退到本章开头；
    // 等一帧再 display 一次，位置才精确（实测可回到同一处）
    await raf2();
    await wait(140);
    try { await rendition.display(cfi); } catch { /* 忽略 */ }
  }

  /** 同步书页留白（上下各一行）+ 重新计算舞台宽度与分栏 gap */
  function syncPaperBox({ layout = true, cfi = null } = {}) {
    const vp = vpadOf();
    const W = Math.round(mount.clientWidth || 0);
    const H = Math.round(mount.clientHeight || 0);
    if (W < 40 || H < 40) return null;
    const dual = curPageMode === 'dual' && W >= 720;
    const geo = curPageMode === 'scroll' ? { stageW: W, left: 0, colW: W, gap: 0 } : geomFor(dual, W);
    applyStage(geo, vp);
    // 注意：epub.js 的 manager 持有一份 settings 拷贝，必须两处都改，否则分栏不更新
    try {
      rendition.settings.gap = geo.gap;
      if (rendition.manager?.settings) rendition.manager.settings.gap = geo.gap;
    } catch { /* 忽略 */ }
    layoutKey(); // 版式变了，清掉旧的「每页字符数」采样
    if (layout && curPageMode !== 'scroll') relayoutAndRestore(cfi).catch(() => {});
    return { W, H, dual, geo };
  }

  const onWinResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      const W = Math.round(mount.clientWidth || 0);
      const H = Math.round(mount.clientHeight || 0);
      if (W < 40 || H < 40) return;
      lastW = W; lastH = H;
      const wideNow = W >= 720;
      const wantDualNow = curPageMode === 'dual' && wideNow;
      if (wantDualNow !== lastDual) {
        lastDual = wantDualNow;
        try { rendition.spread(wantDualNow ? 'always' : 'never'); } catch { /* 忽略 */ }
        window.__moyueSetDual?.(wantDualNow);
      }
      syncPaperBox({ layout: false });
      let cfi = null;
      try { cfi = rendition.currentLocation()?.start?.cfi; } catch { /* 忽略 */ }
      try { if (rendition.manager) rendition.manager._stageSize = undefined; } catch { /* 忽略 */ }
      const r = inner.getBoundingClientRect();
      try { await rendition.resize(Math.floor(r.width), Math.floor(r.height), cfi || undefined); } catch { /* 忽略 */ }
      const iframe = mount.querySelector('iframe');
      if (iframe) { iframe.style.transition = 'none'; iframe.style.transform = 'translate3d(0,0,0)'; }
    }, 180);
  };
  window.addEventListener('resize', onWinResize);

  // 窗口大小不变、但「阅读舞台」自身变宽变窄时（打开/收起目录侧栏、
  // 打开标注抽屉），epub.js 的舞台是按像素写死的，不会自己跟着缩，
  // 于是右侧内容被推出屏幕、整页看着往右偏。用 ResizeObserver 兜住这类变化。
  let lastW = Math.round(rect.width || 0);
  let lastH = Math.round(rect.height || 0);
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      const W = Math.round(mount.clientWidth || 0);
      const H = Math.round(mount.clientHeight || 0);
      if (W < 40 || H < 40) return;
      if (Math.abs(W - lastW) < 2 && Math.abs(H - lastH) < 2) return;
      lastW = W; lastH = H;
      onWinResize();
    });
    ro.observe(mount);
  }

  // ---------- 主题 ----------
  function buildThemeCss(t, s) {
    const bg = t.vars['--reader-bg'];
    const fg = t.vars['--reader-text'];
    const accent = t.vars['--accent'];
    return {
      body: {
        background: `${bg} !important`,
        color: `${fg} !important`,
        'font-family': `${s.fontFamily} !important`,
        'line-height': `${s.lineHeight} !important`,
        // 左右留白由 column gap 提供，这里不再叠加，避免双页时中缝被撑开
        padding: '0 !important',
        margin: '0 !important',
        'text-align': 'justify',
      },
      'p, div, li, blockquote, dd, dt': {
        color: `${fg} !important`,
        'line-height': 'inherit !important',
      },
      p: {
        'text-align': 'justify',
        'word-break': 'normal',
        'line-break': 'strict',
        'hyphens': 'auto',
      },
      'h1, h2, h3, h4, h5, h6': { color: `${fg} !important`, 'line-height': '1.45 !important' },
      a: { color: `${accent} !important` },
      img: { '-webkit-user-drag': 'none !important' },
      '::selection': { background: `${accent} !important`, color: `${t.vars['--accent-text']} !important` },
    };
  }

  function applyTheme() {
    rendition.themes.register('moyue', buildThemeCss(currentTheme, currentStyles));
    rendition.themes.select('moyue');
    rendition.themes.fontSize(currentStyles.fontSize + 'px');
  }
  applyTheme();

  // ---------- 进度 ----------
  let locationsReady = false;
  let lastCfi = null; // 最近一次阅读位置（切模式时视图会被清空，用它兜底）
  book.locations.generate(1200).then(() => {
    locationsReady = true;
    refreshProgress();
  }).catch(() => {});

  function percentFromCfi(cfi) {
    if (locationsReady) {
      try { return book.locations.percentageFromCfi(cfi); } catch { /* fallthrough */ }
    }
    try { return rendition.location.start.index / book.spine.length; } catch { return 0; }
  }

  // epub.js 的 locations.length 在部分版本是方法而非数字，需兼容
  function locTotal() {
    const L = book.locations;
    if (!L) return 0;
    const len = L.length;
    if (typeof len === 'function') { try { return len.call(L) || 0; } catch { return 0; } }
    return len || 0;
  }

  // ---------- 全书总页码 ----------
  // 目标：左下角显示「第 276 / 556 页」这样的全书页码（而不是本章页码）。
  //
  // 注意 epub.js 的 displayed 单位是「栏」而不是「页」：columnWidth 在单/双页下
  // 相同（都是版心宽），所以同一个章节单页是 26 栏、双页也是 26 栏，
  // 跨页数 = 栏数 / 2。全书页码必须据此换算，否则双页会显示成单页的两倍。
  //
  // 做法：实测当前版式「一栏能排多少字符」→ 估出全书栏数 → 按模式换算成页数；
  // 当前页用「本章已排栏数 + 全书此前字符数 / 每栏字符数」精确定位。
  const LOCATION_CHARS = 1200; // 与 book.locations.generate(1200) 的粒度对应

  /** 版式签名：模式 / 视口宽高 / 字号 / 行距任一变化，旧采样即作废 */
  function layoutKey() {
    const W = Math.round(mount.clientWidth || 0);
    const H = Math.round(mount.clientHeight || 0);
    const k = [
      curPageMode,
      W >= 720 ? 'w' : 'n',
      W, H,
      Math.round((currentStyles.fontSize || 0) * 10),
      Math.round((currentStyles.lineHeight || 0) * 100),
      Math.round(currentStyles.margin || 0),
    ].join('|');
    if (k !== cplKey) { cplKey = k; cplSamples.length = 0; cplLocked = 0; chapterBaseCol.clear(); }
    return k;
  }

  function isDualNow() {
    const w = mount.clientWidth || 0;
    return curPageMode === 'dual' && w >= 720;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  /** 每栏可容纳的字符数（同一版式下单/双页一致，因为版心宽相同） */
  function sampleLeafChars(loc) {
    // 滚动模式没有「栏」的概念，采样会得出天文数字，必须排除
    if (curPageMode === 'scroll') return;
    layoutKey();
    const d = loc?.start?.displayed;
    if (!d || !d.total) return;
    const doc = rendition.getContents?.()[0]?.document;
    const chars = doc?.body ? (doc.body.textContent || '').replace(/\s+/g, '').length : 0;
    const cpl = chars / d.total;
    // 合理的每栏字符数区间，挡掉测量未完成（cpl 极小/极大）的脏样本
    if (chars > 300 && cpl > 60 && cpl < 8000) {
      cplSamples.push(cpl);
      if (cplSamples.length > 9) cplSamples.shift();
      // 攒到 3 个有效样本就锁定：不同章节的密度（标题、插图、对话页）差别不小，
      // 若让采样一直参与中位数，总页数会在阅读过程中来回跳，观感很差
      if (!cplLocked && cplSamples.length >= 3) cplLocked = median(cplSamples);
    }
  }

  /** 当前的每栏字符数估计（锁定后不再变） */
  function perColNow() {
    return cplLocked || median(cplSamples);
  }

  /**
   * 算出「当前栏」在全书中的序号（0 起）。
   *
   * 不能直接用 locations 索引：它是 1200 字符一格的粗粒度，一格跨 2~3 栏，
   * 每翻一页索引就跳 3，页码会变成 +2/+3。
   * 也不能只用 chapter 内的 displayed.page：那是章节相对的。
   *
   * 所以要「章节基准栏 + 章内栏号」：第一次进入某章时，用 locations 索引反推
   * 该章第 1 栏在全书的位置并缓存；此后每次翻页只让章内栏号 +1（双页 +2），
   * 页码就严格 +1 了。
   */
  function columnIndexOf(loc, pct, perCol, totalCols) {
    const d = loc?.start?.displayed;
    const spineIdx = loc?.start?.index ?? 0;
    if (!d || !d.page) return Math.max(0, Math.round(pct * totalCols) || 0);
    const page = d.page;
    if (!chapterBaseCol.has(spineIdx)) {
      let locIdx = null;
      try { locIdx = book.locations.locationFromCfi(loc.start.cfi); } catch { /* 忽略 */ }
      let base;
      if (Number.isFinite(locIdx) && perCol) {
        base = Math.round((locIdx * LOCATION_CHARS) / perCol) - (page - 1);
      } else {
        base = Math.round(pct * totalCols) - (page - 1);
      }
      // 基准必须随章节单调不减，防止某次估偏导致页码倒退
      for (const [k, v] of chapterBaseCol) if (k < spineIdx && v > base) base = v;
      chapterBaseCol.set(spineIdx, Math.max(0, base));
    }
    return chapterBaseCol.get(spineIdx) + (page - 1);
  }

  function globalLabel(loc, pct) {
    if (!locationsReady) return null;
    layoutKey();
    const perCol = perColNow(); // 每栏字符数
    const totalChars = locTotal() * LOCATION_CHARS;
    if (!perCol || !totalChars) return null;

    const perPage = isDualNow() ? 2 : 1; // 一个跨页含 2 栏
    const totalCols = totalChars / perCol;
    const total = Math.max(1, Math.round(totalCols / perPage));
    const col = columnIndexOf(loc, pct, perCol, totalCols);
    const cur = Math.max(1, Math.min(total, Math.floor(col / perPage) + 1));
    return `第 ${cur} / ${total} 页`;
  }

  function pageLabelFromLoc(loc, pct) {
    // 滚动模式没有「页」的概念，跟文本渲染器保持一致
    if (curPageMode === 'scroll') return '滚动';
    const g = globalLabel(loc, pct);
    if (g) return g;
    // 兜底：索引未就绪时显示本章页码
    const d = loc?.start?.displayed;
    if (d && d.total) return `第 ${d.page} / ${d.total} 页`;
    const total = locTotal();
    const cur = total ? Math.max(1, Math.min(total, Math.round(pct * total))) : 0;
    return total ? `第 ${cur} / ${total} 页` : '—';
  }

  rendition.on('relocated', (loc) => {
    const cfi = loc.start.cfi;
    lastCfi = cfi;
    sampleLeafChars(loc);
    const pct = percentFromCfi(cfi);
    onProgress?.({
      cfi,
      percent: pct,
      chapterTitle: currentChapterTitle(),
      pageLabel: pageLabelFromLoc(loc, pct),
      locator: { cfi },
      spineIndex: loc.start.index,
    });
  });

  /** locations 生成完成后页码才能算全书（否则只有本章页码），完成时刷新一次 */
  function refreshProgress() {
    try {
      const loc = rendition.currentLocation();
      if (!loc?.start?.cfi) return;
      sampleLeafChars(loc);
      const pct = percentFromCfi(loc.start.cfi);
      onProgress?.({
        cfi: loc.start.cfi,
        percent: pct,
        chapterTitle: currentChapterTitle(),
        pageLabel: pageLabelFromLoc(loc, pct),
        locator: { cfi: loc.start.cfi },
        spineIndex: loc.start.index,
      });
    } catch { /* 忽略 */ }
  }

  function currentChapterTitle() {
    try {
      const href = rendition.currentLocation()?.start?.href || '';
      if (!href) return '';
      const list = tocFlat();
      const bare = (u) => (u || '').split('#')[0].split('/').pop();
      const file = bare(href);
      // 1) 精确 href（含片段）→ 2) 同文件且片段相关 → 3) 同文件名
      let item = list.find((t) => t.href === href);
      if (!item) {
        const frag = (href.split('#')[1] || '');
        item = list.find((t) => bare(t.href) === file && frag && (t.href || '').includes(frag));
      }
      if (!item) item = list.find((t) => bare(t.href) === file);
      if (!item) return '';
      // 部分 EPUB 目录标签夹带正文首句，提取其中的章节号
      const label = item.label || '';
      const m = label.match(/(CHAPTER\s+[IVXLC]+\.?|第\s*[0-9一二三四五六七八九十百零]+\s*[章回节卷部篇])/i);
      return m ? m[0] : label;
    } catch { return ''; }
  }

  // ---------- 目录 ----------
  function tocFlat() {
    const out = [];
    const walk = (items, depth) => {
      for (const it of items || []) {
        out.push({ label: it.label?.trim() || '(未命名)', href: it.href, depth });
        if (it.subitems?.length) walk(it.subitems, depth + 1);
      }
    };
    walk(book.navigation?.toc, 0);
    return out;
  }
  const toc = tocFlat();
  if (toc.length) {
    onToc?.(toc.map((t) => ({ label: t.label, target: t.href, depth: t.depth })));
  }

  // 调试钩子（本地阅读器，无安全顾虑）
  try { window.__moyueRendition = rendition; } catch { /* 忽略 */ }

  // ---------- 初始位置 ----------
  if (position?.cfi) {
    await rendition.display(position.cfi).catch(() => rendition.display());
  } else {
    await rendition.display();
  }
  // 双页模式：显示中缝书脊
  window.__moyueSetDual?.(wantDual);

  // ---------- 翻页：iframe 跟手 + 链条动画 ----------
  let turning = false;

  function iframeEl() { return mount.querySelector('iframe'); }

  function currentAt(dir) {
    try {
      const loc = rendition.currentLocation();
      return dir === 'next' ? !!loc?.atEnd : !!loc?.atStart;
    } catch { return false; }
  }

  // ---------- 翻页动画 ----------
  // 参考 WPS PDF：位移连续、速度不断档。滑出用「收到尾段仍在走」的曲线，
  // 滑入用「接住原速再减速」的曲线，接缝处用轻微淡出遮住换页的那一帧。
  const TURN_OUT = 150;
  const TURN_IN = 175;
  const EASE_OUT = 'cubic-bezier(.42,.02,.82,.42)';
  const EASE_IN = 'cubic-bezier(.12,.52,.28,1)';

  async function animatedTurn(dir) {
    if (turning) return;
    if (currentAt(dir)) return;
    turning = true;
    try {
      const w = mount.clientWidth || 800;
      const travel = Math.max(220, Math.round(w * 0.55));
      const out = dir === 'next' ? -travel : travel;
      let iframe = iframeEl();

      if (curTurnFx === 'none') {
        try { await (dir === 'next' ? rendition.next() : rendition.prev()); } catch { /* 忽略 */ }
        iframe = iframeEl();
        if (iframe) { iframe.style.transition = 'none'; iframe.style.transform = 'translate3d(0,0,0)'; iframe.style.opacity = '1'; iframe.style.boxShadow = ''; }
        return;
      }

      if (curTurnFx === 'fade') {
        if (iframe) { iframe.style.transition = 'opacity .15s linear'; iframe.style.opacity = '0'; }
        await wait(155);
        try { await (dir === 'next' ? rendition.next() : rendition.prev()); } catch { /* 忽略 */ }
        iframe = iframeEl();
        if (iframe) {
          iframe.style.transition = 'none';
          iframe.style.transform = 'translate3d(0,0,0)';
          iframe.style.opacity = '0';
          await raf2();
          iframe.style.transition = 'opacity .2s ease';
          iframe.style.opacity = '1';
        }
        await wait(220);
        return;
      }

      // slide（默认）
      if (iframe) {
        iframe.style.willChange = 'transform, opacity';
        iframe.style.transition = `transform ${TURN_OUT}ms ${EASE_OUT}, opacity ${TURN_OUT}ms linear`;
        iframe.style.transform = `translate3d(${out}px,0,0)`;
        iframe.style.opacity = '0.25';
        iframe.style.boxShadow = dir === 'next'
          ? '-14px 0 32px rgba(0,0,0,.24)'
          : '14px 0 32px rgba(0,0,0,.24)';
      }
      await wait(TURN_OUT);
      try { await (dir === 'next' ? rendition.next() : rendition.prev()); } catch { /* 忽略 */ }
      iframe = iframeEl();
      if (iframe) {
        iframe.style.transition = 'none';
        iframe.style.transform = `translate3d(${-out}px,0,0)`;
        iframe.style.opacity = '0.25';
        await raf2();
        iframe.style.transition = `transform ${TURN_IN}ms ${EASE_IN}, opacity ${TURN_IN}ms linear`;
        iframe.style.transform = 'translate3d(0,0,0)';
        iframe.style.opacity = '1';
      }
      await wait(TURN_IN + 30);
      iframe = iframeEl();
      if (iframe) { iframe.style.boxShadow = ''; iframe.style.willChange = ''; }
    } finally {
      turning = false;
    }
  }

  // ---------- 长按选择（iframe 内坐标，选词 + 拖动扩展） ----------
  let lpAnchor = null;
  function iframeDoc() { return iframeEl()?.contentDocument || null; }

  function caretAt(x, y) {
    const doc = iframeDoc();
    if (!doc) return null;
    let r = null;
    try { r = doc.caretRangeFromPoint(x, y); } catch { return null; }
    if (!r) return null;
    const body = doc.body;
    if (!body || !body.contains(r.startContainer)) return null;
    return r;
  }

  const WORD_RE = /[\w\u4e00-\u9fa5\u3040-\u30ff]/;
  function expandWord(range) {
    const node = range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent || '';
    let s = range.startOffset, e = s;
    while (s > 0 && WORD_RE.test(text[s - 1])) s--;
    while (e < text.length && WORD_RE.test(text[e])) e++;
    if (e <= s) return null;
    const r = node.ownerDocument.createRange();
    r.setStart(node, s);
    r.setEnd(node, e);
    return r;
  }

  function onEpubLongPress(x, y) {
    const doc = iframeDoc();
    const win = doc?.defaultView;
    if (!doc || !win) return;
    const caret = caretAt(x, y);
    if (!caret) return;
    const r = expandWord(caret);
    if (!r) return;
    const sel = win.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    lpAnchor = { node: r.startContainer, offset: r.startOffset };
  }

  function onEpubLongPressMove(x, y) {
    if (!lpAnchor) return;
    const win = iframeDoc()?.defaultView;
    if (!win) return;
    const caret = caretAt(x, y);
    if (!caret) return;
    try { win.getSelection().setBaseAndExtent(lpAnchor.node, lpAnchor.offset, caret.startContainer, caret.startOffset); } catch { /* 忽略 */ }
  }

  function onEpubLongPressEnd() {
    lpAnchor = null;
    // iframe 的 mouseup 由 epub.js 原生 'selected' 事件接管，自动弹标注工具栏
  }

  // ---------- 翻页手势引擎（只负责长按选词与箭头浮现，不再接管拖拽翻页） ----------
  const engine = createPageTurn({
    viewport: mount,
    canGo: (dir) => !currentAt(dir),
    enabled: () => !turning && curPageMode !== 'scroll',
    onTurn(dir) { animatedTurn(dir); },
    onLongPress: onEpubLongPress,
    onLongPressMove: onEpubLongPressMove,
    onLongPressEnd: onEpubLongPressEnd,
    // iframe 内的鼠标坐标需换算回主窗口坐标（epub.js 把多 spread 铺在超宽 iframe 里）
    onHover: (x, y) => {
      const f = iframeEl();
      if (f) { const r = f.getBoundingClientRect(); window.__moyueHover?.(r.left + x, r.top + y); }
      else window.__moyueHover?.(x, y);
    },
  });

  // iframe 不向父文档冒泡指针事件：每次内容渲染后把引擎挂到新文档
  /** 让电子书读起来更像纸书：首行缩进 / 中西文间距 / 标点挤压（仅在出版方未设置时） */
  function tuneTypography() {
    for (const c of rendition.getContents()) {
      try {
        const doc = c?.document;
        const body = doc?.body;
        if (!body) continue;
        if (!body.dataset.moyueType) {
          body.dataset.moyueType = '1';
          const st = doc.createElement('style');
          // 中西混排自动间距 + 行首标点挤压：Chromium 新版原生支持，旧版自动忽略
          st.textContent = 'html{text-spacing-trim:space-first;text-autospace:normal;}p{text-align:justify;}';
          doc.head?.appendChild(st);
        }
        if (!body.dataset.moyueIndent) {
          body.dataset.moyueIndent = '1';
          const ps = body.querySelectorAll('p');
          if (ps.length) {
            const cs = doc.defaultView.getComputedStyle(ps[Math.min(1, ps.length - 1)]);
            const indent = parseFloat(cs.textIndent) || 0;
            const mb = parseFloat(cs.marginBottom) || 0;
            // 出版方既没做首行缩进、段间也没留白 → 按中文纸书的缩进式排版
            if (indent < 1 && mb < 4) {
              const st2 = doc.createElement('style');
              st2.textContent = 'p{text-indent:2em;}';
              doc.head?.appendChild(st2);
            }
          }
        }
      } catch { /* 忽略 */ }
    }
  }

  const attachEngine = () => {
    for (const c of rendition.getContents()) {
      if (c?.document) engine.attachDocument(c.document);
    }
    tuneTypography();
  };
  rendition.on('rendered', attachEngine);
  rendition.on('displayed', attachEngine);
  attachEngine();

  // ---------- 标注（高亮 / 批注） ----------
  async function applyStoredAnnotations() {
    const anns = await annStore.load();
    for (const a of anns) {
      if (a.loc?.cfi) applyAnnotation(a);
    }
  }

  function applyAnnotation(ann) {
    if (!ann.loc?.cfi) return;
    try {
      rendition.annotations.highlight(
        ann.loc.cfi,
        { moyueId: ann.id },
        null,
        'hl-' + ann.color,
        { fill: ann.fill || colorFill(ann.color), 'fill-opacity': '1', 'mix-blend-mode': 'normal' },
      );
    } catch { /* CFI 失效时静默跳过 */ }
  }

  function removeAnnotation(ann) {
    if (!ann.loc?.cfi) return;
    try { rendition.annotations.remove(ann.loc.cfi, 'highlight'); } catch { /* 忽略 */ }
  }

  // 选中文本 → 浮动标注工具栏
  rendition.on('selected', (cfiRange, contents) => {
    const sel = contents.window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text.trim()) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const off = iframeEl()?.getBoundingClientRect();
    onSelection?.({
      format: 'epub',
      cfi: cfiRange,
      text: text.slice(0, 300),
      rect: {
        left: (off?.left || 0) + r.left,
        top: (off?.top || 0) + r.top,
        width: r.width,
        height: r.height,
      },
    });
  });

  applyStoredAnnotations();

  return {
    format: 'epub',
    meta: () => ({
      title: book.packaging?.metadata?.title || book.metadata?.title || '',
      author: book.packaging?.metadata?.creator || '',
    }),
    toc,
    async goTo(target) {
      if (typeof target === 'string') await rendition.display(target);
      else if (target?.cfi) await rendition.display(target.cfi);
    },
    next() { return animatedTurn('next'); },
    prev() { return animatedTurn('prev'); },
    turnPage(dir) { return animatedTurn(dir); },
    setTheme(t) { currentTheme = t; applyTheme(); },
    setStyles(s) {
      currentStyles = s;
      applyTheme();
      // 字号/边距变化会改变分栏 gap，需要重新排版（保留当前位置）
      syncPaperBox();
    },
    setTurnFx(fx) { curTurnFx = fx || 'slide'; },
    async setMode(mode) {
      const prevMode = curPageMode;
      // 先记下当前位置：epub.js 的 currentLocation() 内部会 updateLayout()，
      // 一旦舞台尺寸变了再取位置，就会被打回本章开头
      let cfi = null;
      try { cfi = rendition.currentLocation()?.start?.cfi || lastCfi; } catch { cfi = lastCfi; }

      curPageMode = mode;
      const wide = (mount.clientWidth || 0) >= 720;
      const wantDual = mode === 'dual' && wide;
      const wantScroll = mode === 'scroll';
      const wasScroll = prevMode === 'scroll';
      window.__moyueSetDual?.(wantDual);

      // 重新计算舞台宽度 / 上下留白 / 分栏 gap（不触发排版）
      syncPaperBox({ layout: false });
      const iframe = iframeEl();
      if (iframe) { iframe.style.transition = 'none'; iframe.style.transform = 'translate3d(0,0,0)'; iframe.style.opacity = '1'; iframe.style.boxShadow = ''; }

      try { rendition.spread(wantDual ? 'always' : 'never'); } catch { /* 忽略 */ }

      if (wantScroll || wasScroll) {
        // 滚动 ⇄ 分页：flow 必须换，视图会重建，按 cfi 复位
        try { rendition.flow(wantScroll ? 'scrolled-continuous' : 'paginated'); } catch { /* 忽略 */ }
        try { if (rendition.manager) rendition.manager._stageSize = undefined; } catch { /* 忽略 */ }
        const r = inner.getBoundingClientRect();
        try { rendition.resize(Math.floor(r.width), Math.floor(r.height), cfi || undefined); } catch { /* 忽略 */ }
        if (cfi) {
          await raf2();
          await wait(160);
          try { await rendition.display(cfi); } catch { /* 忽略 */ }
        }
      } else {
        // 单页 ⇄ 双页：舞台宽度变了，走 resize + 二次 display（可精确回到原处）
        await relayoutAndRestore(cfi);
      }

      // display(cfi) 落在同一个位置时 epub.js 不会再发 relocated，
      // 页码（每页字符数变了，全书总页数也要跟着变）必须手动重算一次
      await wait(90);
      refreshProgress();
    },
    async getState() {
      const loc = rendition.currentLocation();
      const pct = loc?.start?.cfi ? percentFromCfi(loc.start.cfi) : 0;
      return {
        cfi: loc?.start?.cfi || null,
        percent: pct,
        chapterTitle: currentChapterTitle(),
        pageLabel: pageLabelFromLoc(loc, pct),
      };
    },
    applyAnnotation,
    removeAnnotation,
    async goToAnnotation(ann) {
      if (ann.loc?.cfi) await rendition.display(ann.loc.cfi).catch(() => {});
    },
    clearSelection() {
      iframeEl()?.contentWindow?.getSelection()?.removeAllRanges();
    },
    destroy() {
      window.removeEventListener('resize', onWinResize);
      try { ro?.disconnect(); } catch { /* 忽略 */ }
      clearTimeout(resizeTimer);
      engine.destroy();
      try { rendition.destroy(); } catch {}
      try { book.destroy(); } catch {}
    },
  };
}
