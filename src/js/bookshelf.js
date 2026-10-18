/**
 * 墨阅 MoYue — 书架页面逻辑
 * 图书导入 / 封面元数据提取（EPUB:JSZip 直解, PDF:pdf.js, MOBI:自研解析器）/ 阅读进度 / 主题切换
 */
import { THEMES, THEME_ORDER, applyTheme, nextTheme } from './themes.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  books: [],
  settings: null,
  view: 'grid',
  sort: 'recent',
  search: '',
  enriching: new Set(),
};

// ---------- 工具 ----------
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function showToast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, ms);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function relTime(ts) {
  if (!ts) return '未阅读';
  const diff = Date.now() - ts;
  const m = 60000, h = 3600000, d = 86400000;
  if (diff < m) return '刚刚';
  if (diff < h) return Math.floor(diff / m) + ' 分钟前';
  if (diff < d) return Math.floor(diff / h) + ' 小时前';
  if (diff < 7 * d) return Math.floor(diff / d) + ' 天前';
  const dt = new Date(ts);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function genCover(title, format) {
  const palettes = {
    epub: ['#2d6a4f', '#52b788'],
    pdf: ['#7f4a3d', '#b5543f'],
    txt: ['#33567e', '#5c7caa'],
    mobi: ['#4d3a7a', '#7f6bad'],
  };
  const [c1, c2] = palettes[format] || palettes.txt;
  const label = (format || 'txt').toUpperCase();
  return `<div class="gen-cover" style="background:linear-gradient(150deg,${c1},${c2})">
    <div class="gen-format">${label}</div>
    <div class="gen-title">${title}</div>
  </div>`;
}

function sniffB64Type(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

// ---------- 元数据提取 ----------
async function extractEpubMeta(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let opfPath = 'OEBPS/content.opf';
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (containerXml) {
    const m = containerXml.match(/full-path="([^"]+)"/);
    if (m) opfPath = m[1];
  }
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('未找到 OPF');
  const opf = await opfFile.async('text');
  const doc = new DOMParser().parseFromString(opf, 'application/xml');
  const title = doc.querySelector('title')?.textContent?.trim() || '';
  const creator = doc.querySelector('creator')?.textContent?.trim() || '';
  let coverHref = null;
  const manifest = doc.querySelector('manifest');
  if (manifest) {
    for (const item of manifest.querySelectorAll('item')) {
      if ((item.getAttribute('properties') || '').includes('cover-image')) {
        coverHref = item.getAttribute('href');
        break;
      }
    }
    if (!coverHref) {
      const meta = [...doc.querySelectorAll('meta')].find((x) => x.getAttribute('name') === 'cover');
      if (meta) {
        const item = [...manifest.querySelectorAll('item')].find((i) => i.getAttribute('id') === meta.getAttribute('content'));
        if (item) coverHref = item.getAttribute('href');
      }
    }
  }
  let cover = null;
  if (coverHref) {
    const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const coverFile = zip.file(dir + coverHref) || zip.file(coverHref);
    if (coverFile) {
      const b64 = await coverFile.async('base64');
      cover = `data:${sniffB64Type(b64)};base64,${b64}`;
    }
  }
  return { title, author: creator, cover };
}

async function extractPdfMeta(buffer) {
  const pdfjs = await import('/src/vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/src/vendor/pdf.worker.mjs';
  const doc = await pdfjs.getDocument({ data: buffer.slice(0), useSystemFonts: true }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const page = await doc.getPage(1);
    const baseVp = page.getViewport({ scale: 1 });
    const scale = Math.min(260 / baseVp.width, 390 / baseVp.height, 2);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const cover = canvas.toDataURL('image/jpeg', 0.85);
    return { title: (meta?.info?.Title || '').trim(), author: (meta?.info?.Author || '').trim(), cover };
  } finally {
    try { doc.cleanup(); } catch {}
  }
}

async function extractMobiMeta(buffer) {
  const { parseMobi } = await import('/src/js/parsers/mobi-parser.js');
  const r = parseMobi(new Uint8Array(buffer));
  let cover = null;
  if (r.coverRecord !== null && r.images.has(r.coverRecord)) {
    const img = r.images.get(r.coverRecord);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < img.data.length; i += chunk) {
      bin += String.fromCharCode(...img.data.subarray(i, i + chunk));
    }
    cover = `data:${img.mediaType};base64,${btoa(bin)}`;
  }
  return { title: r.meta.title || '', author: r.meta.author || '', cover };
}

async function extractTxtMeta(buffer) {
  const { decodeTxt, guessTitle } = await import('/src/js/parsers/txt-parser.js');
  const { text } = decodeTxt(new Uint8Array(buffer.slice(0, 65536)));
  return { title: guessTitle(text), author: '', cover: null };
}

async function enrichBook(book) {
  if (state.enriching.has(book.id)) return;
  state.enriching.add(book.id);
  try {
    const buffer = await moyue.readBookBuffer(book.id);
    let meta = { title: '', author: '', cover: null };
    if (book.format === 'epub') meta = await extractEpubMeta(buffer);
    else if (book.format === 'pdf') meta = await extractPdfMeta(buffer);
    else if (book.format === 'mobi') meta = await extractMobiMeta(buffer);
    else meta = await extractTxtMeta(buffer);
    const patch = {};
    if (meta.title && meta.title !== book.title) patch.title = meta.title;
    if (meta.author) patch.author = meta.author;
    if (meta.cover) patch.cover = meta.cover;
    if (Object.keys(patch).length) {
      const updated = await moyue.updateBook(book.id, patch);
      const idx = state.books.findIndex((b) => b.id === book.id);
      if (idx !== -1 && updated) state.books[idx] = updated;
      render();
    }
  } catch (e) {
    console.warn('元数据提取失败:', book.title, e.message);
  } finally {
    state.enriching.delete(book.id);
  }
}

// ---------- 渲染 ----------
function visibleBooks() {
  let list = [...state.books];
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter((b) =>
      (b.title || '').toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q) ||
      (b.fileName || '').toLowerCase().includes(q));
  }
  const sorters = {
    recent: (a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || b.addedAt - a.addedAt,
    added: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN'),
    progress: (a, b) => (b.progress?.percent || 0) - (a.progress?.percent || 0),
  };
  return list.sort(sorters[state.sort] || sorters.recent);
}

function render() {
  const grid = $('#bookGrid');
  const list = $('#bookList');
  const books = visibleBooks();
  grid.innerHTML = '';
  list.innerHTML = '';
  $('#emptyState').hidden = books.length > 0;
  grid.hidden = state.view !== 'grid';
  list.hidden = state.view !== 'list';

  for (const book of books) {
    const card = state.view === 'grid' ? renderCard(book) : renderRow(book);
    (state.view === 'grid' ? grid : list).appendChild(card);
  }

  const totalSize = state.books.reduce((s, b) => s + (b.fileSize || 0), 0);
  $('#statusCount').textContent = `${state.books.length} 本图书`;
  $('#statusSize').textContent = state.books.length ? `共 ${formatSize(totalSize)}` : '';
}

function renderCard(book) {
  const card = el('div', 'book-card');
  const cover = el('div', 'book-cover');
  cover.innerHTML = book.cover
    ? `<img src="${book.cover}" alt="" loading="lazy"/>`
    : genCover(book.title || '未命名', book.format);
  const badge = el('span', 'format-badge', book.format.toUpperCase());
  cover.appendChild(badge);
  const pct = Math.round((book.progress?.percent || 0) * 100);
  const track = el('div', 'progress-track');
  const fill = el('div', 'progress-fill');
  fill.style.width = pct + '%';
  track.appendChild(fill);
  cover.appendChild(track);

  const meta = el('div', 'book-meta');
  meta.appendChild(el('div', 'book-title', book.title || '未命名'));
  const sub = book.author ? `${book.author} · ${pct}%` : `已读 ${pct}%`;
  meta.appendChild(el('div', 'book-sub', sub));

  const actions = el('div', 'card-actions');
  const delBtn = el('button', 'card-action-btn danger', '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>');
  delBtn.title = '从书架移除';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`确定将《${book.title}》从书架移除吗？（不会删除原文件）`)) {
      await moyue.removeBook(book.id);
      state.books = state.books.filter((b) => b.id !== book.id);
      render();
    }
  });
  actions.appendChild(delBtn);

  card.appendChild(cover);
  card.appendChild(meta);
  card.appendChild(actions);
  card.addEventListener('click', () => moyue.openReader(book.id));
  return card;
}

function renderRow(book) {
  const row = el('div', 'list-row');
  const cover = el('div', 'book-cover');
  cover.innerHTML = book.cover
    ? `<img src="${book.cover}" alt=""/>`
    : genCover(book.title || '未命名', book.format);
  const info = el('div', 'list-info');
  info.appendChild(el('div', 'list-title', book.title || '未命名'));
  const pct = Math.round((book.progress?.percent || 0) * 100);
  info.appendChild(el('div', 'list-sub',
    `${book.format.toUpperCase()} · ${book.author || '未知作者'} · ${formatSize(book.fileSize)} · ${relTime(book.lastOpenedAt)}`));
  const prog = el('div', 'list-progress');
  const track = el('div', 'progress-track');
  const fill = el('div', 'progress-fill');
  fill.style.width = pct + '%';
  track.appendChild(fill);
  prog.appendChild(track);

  row.appendChild(cover);
  row.appendChild(info);
  row.appendChild(prog);
  row.addEventListener('click', () => moyue.openReader(book.id));
  return row;
}

// ---------- 导入 ----------
async function afterImport(added) {
  if (!added?.length) return;
  for (const b of added) {
    if (!state.books.some((x) => x.id === b.id)) state.books.push(b);
  }
  render();
  showToast(`已导入 ${added.length} 本图书`);
  // 串行补全元数据（避免并发过高）
  for (const b of added) await enrichBook(b);
}

// ---------- 初始化 ----------
async function init() {
  const { books, settings } = await moyue.getLibrary();
  state.books = books;
  state.settings = settings;
  state.view = settings.shelfView || 'grid';
  state.sort = settings.shelfSort || 'recent';

  applyTheme(settings.theme);
  updateThemeIcon(settings.theme);

  $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value.trim(); render(); });
  $('#sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    moyue.updateSettings({ shelfSort: state.sort });
  });
  $('#sortSelect').value = state.sort;

  $('#viewToggle').addEventListener('click', () => {
    state.view = state.view === 'grid' ? 'list' : 'grid';
    moyue.updateSettings({ shelfView: state.view });
    render();
  });

  $('#themeToggle').addEventListener('click', async () => {
    const next = nextTheme(state.settings.theme);
    state.settings = await moyue.updateSettings({ theme: next });
    applyTheme(next);
    updateThemeIcon(next);
  });

  $('#importBtn').addEventListener('click', async () => {
    const added = await moyue.openBookDialog();
    await afterImport(added);
  });

  // 拖拽导入
  const overlay = $('#dropOverlay');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; overlay.hidden = false; });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length) await afterImport(await moyue.importBooks(paths));
    else showToast('无法读取拖入的文件，请使用「导入图书」按钮');
  });

  // 其他实例导入通知
  moyue.onLibraryChanged(async (added) => { await afterImport(added); });

  render();

  // 懒补全封面/元数据（限制并发 2）
  const queue = state.books.filter((b) => !b.cover && (b.format === 'epub' || b.format === 'pdf' || b.format === 'mobi'));
  const workers = Array.from({ length: 2 }, async () => {
    while (queue.length) await enrichBook(queue.shift());
  });
  await Promise.all(workers);
  console.log('[moyue] 书架就绪，图书数:', state.books.length);
}

function updateThemeIcon(key) {
  $('#themeIcon').textContent = THEMES[key]?.icon || '☀';
  $('#themeToggle').title = `当前主题：${THEMES[key]?.name || '日间'}（点击切换）`;
}

init();
