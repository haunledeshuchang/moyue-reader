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

import { colorFill, HL_COLORS } from '../annotations.js';
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
  let destroyed = false;

  // 全书页码索引：按当前版式把每个 spine 章节离屏真实排版一遍，量出每章栏数。
  // （旧实现用「每栏字符数」估算，扉页这种短章会估得离谱，放大字号后重新采样
  //   又让总页数整本书级地漂移，所以整块换成真实测量。）
  const bookIdx = { sig: '', offsets: null, total: 0 };
  let idxBuilding = false;
  let idxPending = false;
  let idxTimer = null;

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
    layoutKey(); // 版式变了，清掉旧的「全书页码索引」
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
    const fam = s.fontFamily;
    return {
      body: {
        background: `${bg} !important`,
        color: `${fg} !important`,
        'font-family': `${fam} !important`,
        'line-height': `${s.lineHeight} !important`,
        // 左右留白由 column gap 提供，这里不再叠加，避免双页时中缝被撑开
        padding: '0 !important',
        margin: '0 !important',
        'text-align': 'justify',
      },
      // 字体必须下到「每一个文本元素」上，只写 body 会被书内 CSS 的直接声明吃掉：
      // 实测《cis股票交易术》给 p 写了 font-family:汉仪旗黑50S，而 body 上的
      // font-family 只是「继承值」，继承永远输给直接声明 → 切字体整本书纹丝不动。
      'body, body *': { 'font-family': `${fam} !important` },
      'body *::before, body *::after': { 'font-family': `${fam} !important` },
      // 代码 / 等宽块保留等宽，不跟着正文拉成宋体
      'body code, body pre, body kbd, body samp, body tt': {
        'font-family': 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace !important',
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

  // epub.js 的 addStylesheetRules 只 insertRule 不清旧规则，而 applyTheme 每次
  // 改字号 / 字体 / 主题都会被调用 → 规则会越堆越多（同选择器重复几十份）。
  // 每轮先把上次注入的 <style> 清空，保证只留当前一份。
  function clearThemeCss() {
    try {
      for (const c of rendition.getContents()) {
        const el = c.document?.getElementById('epubjs-inserted-css-moyue');
        if (el) el.textContent = '';
      }
    } catch { /* 忽略 */ }
  }

  function applyTheme() {
    clearThemeCss();
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

  // ---------- 全书总页码（真实分页测量） ----------
  // 目标：左下角显示「第 276 / 556 页」这样的全书页码，且同一版式下恒定、翻一屏 +1。
  //
  // 旧实现按「每栏字符数」估算全书栏数，有三个硬伤：
  //   ① 扉页 / 版权页这类只有几行的短章，按字符估会算出一整页甚至更多；
  //   ② 字号一放大就重新采样，总页数整本书级地跳；
  //   ③ 和 epub.js 自己给的章内栏号（displayed.page）对不齐。
  // 现在改成：把每个 spine 章节在「当前版式」下离屏真实排一遍（列宽 / 列距 / 字号 /
  // 行距 / 上下留白都与阅读区完全一致），量出真实栏数并累积成全书索引。
  // 注意 epub.js 的 displayed 单位是「栏」不是「页」，双页模式一屏 2 栏，
  // 所以页码 = 栏号 / divisor。

  /** 版式签名：模式 / 视口宽高 / 字号 / 行距 / 边距 / 字体任一变化，旧索引即作废 */
  // 字体必须算进签名：换了字面，每栏能塞的字数就变了，
  // 不重算会导致「第 66 / 142 页」的分母停在上一个字体的页数上。
  function indexSig() {
    const W = Math.round(mount.clientWidth || 0);
    const H = Math.round(mount.clientHeight || 0);
    const fam = String(currentStyles.fontFamily || '');
    let h = 0;
    for (let i = 0; i < fam.length; i++) h = (h * 31 + fam.charCodeAt(i)) | 0;
    return [
      curPageMode, W >= 720 ? 'w' : 'n', W, H,
      Math.round((currentStyles.fontSize || 0) * 10),
      Math.round((currentStyles.lineHeight || 0) * 100),
      Math.round(currentStyles.margin || 0),
      h,
    ].join('|');
  }

  /** 兼容旧调用点：版式变了就把索引标脏，并排一次重建 */
  function layoutKey() {
    const k = indexSig();
    if (bookIdx.sig && bookIdx.sig !== k) {
      bookIdx.sig = '';
      bookIdx.offsets = null;
      bookIdx.total = 0;
      scheduleIndex(180);
    }
    return k;
  }

  function isDualNow() {
    const w = mount.clientWidth || 0;
    return curPageMode === 'dual' && w >= 720;
  }

  const divisorNow = () => (isDualNow() ? 2 : 1);

  function indexReady() {
    return !!(bookIdx.offsets && bookIdx.sig === indexSig() && bookIdx.total > 0);
  }

  function scheduleIndex(delay = 100) {
    clearTimeout(idxTimer);
    idxTimer = setTimeout(() => { buildBookIndex().catch(() => {}); }, delay);
  }

  /** 等图片加载完再量（未加载的 img 高度为 0，会把含图章节的页数算少） */
  function waitImages(imgs, timeout) {
    const pending = [...imgs].filter((im) => !im.complete);
    if (!pending.length) return Promise.resolve();
    return Promise.race([
      Promise.all(pending.map((im) => new Promise((r) => {
        im.addEventListener('load', r, { once: true });
        im.addEventListener('error', r, { once: true });
      }))),
      wait(timeout),
    ]);
  }

  // 章节样式表缓存：一本书里几十章往往共用同一套 CSS，读一次就够
  const cssCache = new Map();
  async function collectCss(section, sdoc) {
    const parts = [];
    for (const link of sdoc.querySelectorAll('link[href]')) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      const type = (link.getAttribute('type') || '').toLowerCase();
      if (!rel.includes('stylesheet') && !type.includes('css')) continue;
      let abs = link.getAttribute('href');
      try { abs = new URL(abs, section.url || location.href).href; } catch { /* 用原值 */ }
      if (!cssCache.has(abs)) {
        try {
          const res = await fetch(abs);
          cssCache.set(abs, res.ok ? await res.text() : '');
        } catch { cssCache.set(abs, ''); }
      }
      const css = cssCache.get(abs);
      if (css) parts.push(css);
    }
    for (const st of sdoc.querySelectorAll('style')) parts.push(st.textContent || '');
    return parts.join('\n');
  }

  async function buildBookIndex() {
    if (curPageMode === 'scroll' || destroyed) return;
    if (idxBuilding) { idxPending = true; return; }
    const W = Math.round(mount.clientWidth || 0);
    const H = Math.round(mount.clientHeight || 0);
    if (W < 40 || H < 40) return;
    const sig = indexSig();
    if (bookIdx.sig === sig && bookIdx.offsets) return;
    if (!book.spine?.length) return;

    idxBuilding = true;
    const dual = curPageMode === 'dual' && W >= 720;
    const geo = geomFor(dual, W);
    const divisor = dual ? 2 : 1;
    const vp = vpadOf();
    const contentH = Math.max(120, H - 2 * vp);
    const fs = currentStyles.fontSize || 18;
    const lh = currentStyles.lineHeight || 1.8;
    const fam = currentStyles.fontFamily || 'serif';
    const per = geo.colW + geo.gap;
    const padX = Math.round(geo.gap / 2);

    // 必须用离屏 iframe 而不是普通 div 来测量：
    // 章节的排版规则写在外部 stylesheet.css 里（首行缩进 / 段距 / 标题字号…），
    // 塞进主文档的 div 完全拿不到这些规则，实测会少算 30% 的页数。
    // iframe 里内联同一套 CSS、同样的列宽/列距/字号/行高，量出来的才是真页数。
    const measureCss = `
      html, body { margin:0 !important; background:transparent !important; }
      body {
        width:${geo.stageW}px !important; height:${contentH}px !important;
        box-sizing:border-box !important; padding:0 ${padX}px !important;
        column-width:${geo.colW}px !important; column-gap:${geo.gap}px !important;
        column-fill:auto !important; overflow:hidden !important;
        text-align:justify !important; text-spacing-trim:space-first; text-autospace:normal;
        font-family:${fam} !important; line-height:${lh} !important; font-size:${fs}px;
      }
      img { max-width:100% !important; height:auto !important; }
    `;

    const mf = document.createElement('iframe');
    mf.setAttribute('aria-hidden', 'true');
    mf.style.cssText = `position:absolute;left:-30000px;top:0;border:0;visibility:hidden;pointer-events:none;width:${geo.stageW}px;height:${contentH}px;`;
    mount.appendChild(mf);

    const offsets = [0];
    let acc = 0;
    let mark = performance.now();
    let aborted = false;

    try {
      for (let i = 0; i < book.spine.length; i++) {
        if (destroyed || indexSig() !== sig) { aborted = true; break; }
        const section = book.spine.get(i);
        let cols = 1;
        try {
          const contents = await section.load(book.load.bind(book));
          const sdoc = contents?.ownerDocument || contents;
          const css = await collectCss(section, sdoc);
          const clone = sdoc.documentElement.cloneNode(true);
          for (const l of [...clone.querySelectorAll('link')]) {
            if ((l.getAttribute('rel') || '').toLowerCase().includes('stylesheet')) l.remove();
          }
          const srcBody = clone.querySelector('body');

          const mdoc = mf.contentDocument;
          mdoc.open();
          mdoc.write('<!DOCTYPE html><html><head></head><body></body></html>');
          mdoc.close();
          const base = mdoc.createElement('base');
          base.setAttribute('href', section.url || '');
          mdoc.head.appendChild(base);
          const st = mdoc.createElement('style');
          st.textContent = `${css}\n${measureCss}`;
          mdoc.head.appendChild(st);
          if (srcBody) {
            if (srcBody.className) mdoc.body.className = srcBody.className;
            mdoc.body.innerHTML = srcBody.innerHTML;
          } else {
            mdoc.body.innerHTML = clone.innerHTML;
          }

          const imgs = mdoc.querySelectorAll('img');
          if (imgs.length) await waitImages(imgs, 260);

          // body 的 scrollWidth 含左内边距，减掉才是纯内容宽
          const innerW = mdoc.body.scrollWidth - padX;
          cols = Math.max(1, Math.round((innerW + geo.gap) / per));
        } catch { cols = 1; }

        // 双页一屏 2 栏：屏数向上取整（末屏可能只排 1 栏），页码按「屏」累计
        const screens = Math.max(1, Math.ceil(cols / divisor));
        acc += screens;
        offsets.push(acc);

        // 时间片让位：大书有上百章，一次测完会卡住翻页
        if (performance.now() - mark > 14) {
          await wait(0);
          mark = performance.now();
          if (destroyed || indexSig() !== sig) { aborted = true; break; }
        }
      }
    } finally {
      mf.remove();
      idxBuilding = false;
    }

    if (destroyed) return;
    if (aborted || indexSig() !== sig) {
      idxPending = true;
    } else {
      bookIdx.sig = sig;
      bookIdx.offsets = offsets;
      bookIdx.total = Math.max(1, acc);
      refreshProgress();
    }
    if (idxPending) { idxPending = false; scheduleIndex(120); }
  }

  /** 当前舞台宽度＝翻页步长（双页是一整屏，单页是版心宽） */
  function stageWidthNow() {
    const W = Math.round(mount.clientWidth || 0);
    if (curPageMode === 'scroll' || W < 40) return Math.max(1, W);
    return Math.max(1, geomFor(isDualNow(), W).stageW);
  }

  /**
   * 当前页（1 起）。
   *
   * 这里刻意不用 epub.js 的 displayed.page：它的章内总栏数是按 spreadWidth 向上取整
   * 算的（scrollWidth 还带 padding），比真实栏数多出 1~2 屏；滚到内容末尾之后
   * 页码还会继续 +1，而画面已经不动了 —— 用户看到的就是「页码乱跳 + 点了没反应」。
   * 真实滚动位置才是唯一可靠的事实来源。
   */
  function currentPageNumber(loc) {
    if (!indexReady()) return 0;
    const spineIdx = loc?.start?.index ?? 0;
    const off = bookIdx.offsets[Math.min(spineIdx, bookIdx.offsets.length - 1)] || 0;
    const nextOff = spineIdx + 1 < bookIdx.offsets.length ? bookIdx.offsets[spineIdx + 1] : bookIdx.total;
    const screens = Math.max(1, nextOff - off);
    let sl = 0;
    try { sl = rendition.manager?.container?.scrollLeft || 0; } catch { sl = 0; }
    const delta = stageWidthNow();
    const s = Math.max(0, Math.min(screens - 1, Math.round(sl / delta)));
    return Math.max(1, Math.min(bookIdx.total, off + s + 1));
  }

  function totalPageNumber() {
    if (!indexReady()) return 0;
    return Math.max(1, bookIdx.total);
  }

  function pageLabelFromLoc(loc) {
    // 滚动模式没有「页」的概念，跟文本渲染器保持一致
    if (curPageMode === 'scroll') return '滚动';
    const total = totalPageNumber();
    const cur = currentPageNumber(loc);
    if (total && cur) return `第 ${Math.min(total, cur)} / ${total} 页`;
    // 索引还在算：先不显示页码，免得先给一个错的、稍后又跳
    return '—';
  }

  rendition.on('relocated', (loc) => {
    const cfi = loc.start.cfi;
    lastCfi = cfi;
    const pct = percentFromCfi(cfi);
    onProgress?.({
      cfi,
      percent: pct,
      chapterTitle: currentChapterTitle(),
      pageLabel: pageLabelFromLoc(loc),
      locator: { cfi },
      spineIndex: loc.start.index,
    });
    prefetchNeighbor(loc.start.index);
  });

  /**
   * 预取邻章：epub.js 换章时是 clear() + append() 重建 iframe，
   * 章节没缓存时这一步要好几百毫秒，期间翻页锁没释放，表现成「点了没反应」。
   */
  const prefetched = new Set();
  function prefetchNeighbor(index) {
    if (curPageMode === 'scroll') return;
    for (const i of [index + 1, index - 1]) {
      if (i < 0 || i >= book.spine.length || prefetched.has(i)) continue;
      const section = book.spine.get(i);
      if (!section) continue;
      prefetched.add(i);
      try { section.load(book.load.bind(book)).catch(() => {}); } catch { /* 忽略 */ }
    }
  }

  /** locations 建好后刷新一次（百分比进度依赖它） */
  function refreshProgress() {
    try {
      const loc = rendition.currentLocation();
      if (!loc?.start?.cfi) return;
      const pct = percentFromCfi(loc.start.cfi);
      onProgress?.({
        cfi: loc.start.cfi,
        percent: pct,
        chapterTitle: currentChapterTitle(),
        pageLabel: pageLabelFromLoc(loc),
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

  // 首屏出来之后再统计全书页码（后台分片跑，不挡阅读）
  scheduleIndex(60);

  // ---------- 翻页：iframe 跟手 + 链条动画 ----------
  let turning = false;
  let pendingDir = null;
  let turnGuard = null;

  function iframeEl() { return mount.querySelector('iframe'); }

  function currentAt(dir) {
    try {
      const loc = rendition.currentLocation();
      return dir === 'next' ? !!loc?.atEnd : !!loc?.atStart;
    } catch { return false; }
  }

  /**
   * 章节未缓存时 rendition.next() 要 clear() + append() 重建 iframe，
   * 队列里的 promise 可能几百毫秒、甚至更久才 resolve。以前这里直接 await，
   * turning 锁就一直不释放，用户连点箭头全部被丢弃 —— 表现就是「点着没反应」。
   * 现在：给导航一个硬上限，超时也继续走完流程，锁必定释放。
   */
  const NAV_TIMEOUT = 1600;
  function nav(dir) {
    let p;
    try { p = dir === 'next' ? rendition.next() : rendition.prev(); } catch { return Promise.resolve(false); }
    return Promise.race([
      Promise.resolve(p).then(() => true).catch(() => false),
      wait(NAV_TIMEOUT).then(() => false),
    ]);
  }

  // ---------- 翻页动画 ----------
  // 参考 WPS PDF：位移连续、速度不断档。滑出用「收到尾段仍在走」的曲线，
  // 滑入用「接住原速再减速」的曲线，接缝处用轻微淡出遮住换页的那一帧。
  const TURN_OUT = 150;
  const TURN_IN = 175;
  const EASE_OUT = 'cubic-bezier(.42,.02,.82,.42)';
  const EASE_IN = 'cubic-bezier(.12,.52,.28,1)';

  async function animatedTurn(dir) {
    // 连点时不再默默丢弃：记住最后一次方向，本页翻完立刻接上
    if (turning) { pendingDir = dir; return; }
    if (currentAt(dir)) return;
    turning = true;
    clearTimeout(turnGuard);
    turnGuard = setTimeout(() => { turning = false; }, NAV_TIMEOUT + 1500);
    try {
      const w = mount.clientWidth || 800;
      const travel = Math.max(220, Math.round(w * 0.55));
      const out = dir === 'next' ? -travel : travel;
      let iframe = iframeEl();

      if (curTurnFx === 'none') {
        await nav(dir);
        iframe = iframeEl();
        if (iframe) { iframe.style.transition = 'none'; iframe.style.transform = 'translate3d(0,0,0)'; iframe.style.opacity = '1'; iframe.style.boxShadow = ''; }
        return;
      }

      if (curTurnFx === 'fade') {
        if (iframe) { iframe.style.transition = 'opacity .15s linear'; iframe.style.opacity = '0'; }
        await wait(155);
        await nav(dir);
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
      await nav(dir);
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
      clearTimeout(turnGuard);
      turning = false;
      const queued = pendingDir;
      pendingDir = null;
      if (queued) setTimeout(() => { animatedTurn(queued).catch(() => {}); }, 30);
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

  // ---------- 翻页手势引擎（长按选词 / 箭头浮现） ----------
  // 注意：这里**不传 onTap / onRightClick** —— 鼠标在书页上单击不再翻页，
  // 否则划词标注时手一抖就翻页、选区也跟着丢。翻页只走边缘按钮 / 键盘 / turnPage()。
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
      const doc = c?.document;
      if (!doc) continue;
      engine.attachDocument(doc);
      // 标注工具条在父文档，iframe 内的点击传不出去 → 之前「点正文根本关不掉」。
      // 这里在 iframe 文档里兜一层：点书页任意处即收起工具条。
      if (!doc.__moyuePopHook) {
        doc.__moyuePopHook = true;
        doc.addEventListener('pointerdown', () => {
          try { window.__moyueSelToolbar?.onOutsidePointerDown?.(); } catch { /* 忽略 */ }
        }, true);
      }
    }
    tuneTypography();
    // 每节渲染完成后重新登记一次高亮（新文档 = 新的 CSS.highlights 集合）
    paintHighlights();
  };
  rendition.on('rendered', attachEngine);
  rendition.on('displayed', attachEngine);
  attachEngine();

  // ---------- 标注（高亮 / 批注） ----------
  // 荧光笔改用 CSS Highlight API（::highlight）绘制，不再用 epub.js 的 SVG 覆盖层。
  // 原因是 SVG 覆盖层有三个治不好的毛病，正好就是「标完一片颜色糊出去」：
  //   ① 它是按行盒（line box）画矩形的，行距 2 倍时矩形高 28px 而字只有 14px，
  //      上下各糊出 7px，挨着的两行会连成一整条色带；
  //   ② 矩形只用 range.getClientRects() 的天生宽度，两侧没有收缩余量，紧贴相邻列；
  //   ③ 坐标只在「创建那一刻」算一次，之后翻页 / 改字号 / 开关目录导致重排，
  //      覆盖层不会重算，颜色就僵在原地，压到别的文字上。
  // ::highlight 由浏览器自己绘制，只填文字字形所占的区域，重排后自动跟随，
  // 天生满足「只有文字被标上颜色」。

  function hlSupported(win) {
    return !!(win && win.CSS && win.CSS.highlights && win.Highlight);
  }

  // 用函数而不是常量：attachEngine() 会在模块初始化阶段就调用 paintHighlights()，
  // 那时下面的 const 还在 TDZ 里，取常量会直接抛错。
  function hlStyleCss() {
    return HL_COLORS.map((c) => `::highlight(moyue-hl-${c.key}){background-color:${c.fill};}`).join('\n');
  }

  /** 每节文档各注入一份 ::highlight 样式（样式作用域在各自的 document 里） */
  function ensureHlStyle(doc) {
    if (!doc || doc.__moyueHlStyle) return;
    doc.__moyueHlStyle = true;
    const st = doc.createElement('style');
    st.id = 'moyue-hl-style';
    st.textContent = hlStyleCss();
    (doc.head || doc.documentElement).appendChild(st);
  }

  /** 从 CFI 反推 spine 序号：epubcfi(/6/18[chap]!/...) → 8 */
  function spineOfCfi(cfi) {
    const m = /^epubcfi\(\/6\/(\d+)/.exec(String(cfi || ''));
    return m ? Math.round(parseInt(m[1], 10) / 2) - 1 : -1;
  }

  /** 把当前显示的每一节里的标注重新登记成 Range（重排后浏览器自动重新上色） */
  function paintHighlights() {
    let all = [];
    try { all = annStore.all() || []; } catch { all = []; }
    for (const c of rendition.getContents()) {
      const win = c?.document?.defaultView;
      const doc = c?.document;
      if (!doc || !hlSupported(win)) continue;
      ensureHlStyle(doc);
      const groups = new Map();
      for (const a of all) {
        const cfi = a?.loc?.cfi;
        if (!cfi) continue;
        if (spineOfCfi(cfi) !== c.sectionIndex) continue;
        try {
          const r = c.range(cfi);
          if (!r || r.collapsed) continue;
          const key = a.color && HL_COLORS.some((x) => x.key === a.color) ? a.color : 'yellow';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(r);
        } catch { /* CFI 失效时静默跳过 */ }
      }
      for (const col of HL_COLORS) {
        const name = 'moyue-hl-' + col.key;
        const list = groups.get(col.key);
        if (list && list.length) {
          win.CSS.highlights.set(name, new win.Highlight(...list));
        } else {
          win.CSS.highlights.delete(name);
        }
      }
    }
  }

  async function applyStoredAnnotations() {
    await annStore.load();
    paintHighlights();
  }

  function applyAnnotation(ann) {
    if (!ann?.loc?.cfi) return;
    if (hlSupported(window)) { paintHighlights(); return; }
    // 老内核没有 Highlight API 时的退路（Electron 40 用不到，留着兜底）
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
    if (!ann?.loc?.cfi) return;
    if (hlSupported(window)) { paintHighlights(); return; }
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
      destroyed = true;
      clearTimeout(idxTimer);
      clearTimeout(turnGuard);
      window.removeEventListener('resize', onWinResize);
      try { ro?.disconnect(); } catch { /* 忽略 */ }
      clearTimeout(resizeTimer);
      engine.destroy();
      try { rendition.destroy(); } catch {}
      try { book.destroy(); } catch {}
    },
  };
}
