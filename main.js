/**
 * 墨阅 MoYue — Electron 主进程
 * 职责：窗口管理、moyue-app:// 应用文件协议、moyue-book:// 书库文件协议、书库存储 IPC
 */
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

const isDev = !app.isPackaged;

// 任务栏 / 标题栏图标：墨绿底「墨」字
const APP_ICON = path.join(__dirname, 'build', 'icon.ico');

// 防止 Chromium 对后台/不可见窗口做渲染降级：
// 阅读器依赖 rAF 驱动排版队列，窗口被遮挡或最小化时不能停发动画帧
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ---------- 路径 ----------
const userDataDir = app.getPath('userData');
const booksDir = path.join(userDataDir, 'books');
const coversDir = path.join(userDataDir, 'covers');
const annotationsDir = path.join(userDataDir, 'annotations');
const libraryFile = path.join(userDataDir, 'library.json');
const settingsFile = path.join(userDataDir, 'window-state.json');
for (const d of [booksDir, coversDir, annotationsDir]) fs.mkdirSync(d, { recursive: true });

const SUPPORTED_EXTS = ['epub', 'pdf', 'txt', 'mobi', 'azw3', 'prc'];
const FORMAT_MAP = { epub: 'epub', pdf: 'pdf', txt: 'txt', mobi: 'mobi', azw3: 'mobi', prc: 'mobi' };

// ---------- 协议注册 ----------
protocol.registerSchemesAsPrivileged([
  { scheme: 'moyue-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: 'moyue-book', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const SAFE_ID = /^[a-zA-Z0-9_-]{8,64}$/;

const MIME = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/x-mobi8-ebook',
  prc: 'application/x-mobipocket-ebook',
};

const APP_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};
function guessMime(ext) {
  return APP_MIME[ext.toLowerCase()] || 'application/octet-stream';
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadLibrary() { return readJson(libraryFile, { books: [] }); }
function saveLibrary(lib) { writeJson(libraryFile, lib); }
function loadSettings() {
  const s = Object.assign({
    theme: 'day', fontSize: 18, lineHeight: 1.8, fontFamily: 'system', margin: 64,
    pageMode: 'dual', turnFx: 'slide', pdfZoom: 'fit-width', shelfView: 'grid', shelfSort: 'recent',
  }, readJson(settingsFile, {}));
  // 兼容旧版：原 paginated 映射为新的双页（更符合“像真书”的默认体验）
  if (s.pageMode === 'paginated') s.pageMode = 'dual';
  return s;
}
function saveSettings(s) { writeJson(settingsFile, s); }

// ---------- 窗口 ----------
let shelfWindow = null;
let readerWindows = new Map(); // bookId -> BrowserWindow

function createShelfWindow() {
  const ws = readJson(settingsFile, {});
  shelfWindow = new BrowserWindow({
    width: ws.shelfWidth || 1180, height: ws.shelfHeight || 760,
    minWidth: 860, minHeight: 560,
    title: '墨阅 MoYue',
    backgroundColor: '#faf9f6',
    autoHideMenuBar: true,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  shelfWindow.loadURL('moyue-app://app/src/index.html');
  shelfWindow.on('close', () => {
    const [w, h] = shelfWindow.getSize();
    writeJson(settingsFile, { ...loadSettings(), shelfWidth: w, shelfHeight: h });
  });
  shelfWindow.on('closed', () => { shelfWindow = null; app.quit(); });
}

function createReaderWindow(bookId) {
  if (readerWindows.has(bookId)) {
    const w = readerWindows.get(bookId);
    if (!w.isDestroyed()) { w.focus(); return; }
  }
  const ws = readJson(settingsFile, {});
  const win = new BrowserWindow({
    width: ws.readerWidth || 960, height: ws.readerHeight || 800,
    minWidth: 480, minHeight: 400,
    title: '墨阅 · 阅读',
    backgroundColor: '#faf9f6',
    autoHideMenuBar: true,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL('moyue-app://app/src/reader.html?book=' + encodeURIComponent(bookId));
  win.on('close', () => {
    const [w, h] = win.getSize();
    writeJson(settingsFile, { ...loadSettings(), readerWidth: w, readerHeight: h });
  });
  win.on('closed', () => readerWindows.delete(bookId));
  readerWindows.set(bookId, win);
}

// ---------- 导入 ----------
function importFiles(paths) {
  const lib = loadLibrary();
  const added = [];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const ext = path.extname(p).slice(1).toLowerCase();
      if (!SUPPORTED_EXTS.includes(ext)) continue;
      const stat = fs.statSync(p);
      if (!stat.isFile() || stat.size === 0) continue;
      const id = crypto.randomUUID();
      const dest = path.join(booksDir, id);
      fs.copyFileSync(p, dest);
      const base = path.basename(p, path.extname(p));
      const record = {
        id,
        title: base,
        author: '',
        format: FORMAT_MAP[ext] || ext,
        fileName: path.basename(p),
        fileSize: stat.size,
        addedAt: Date.now(),
        lastOpenedAt: 0,
        cover: null,
        progress: { percent: 0, locator: null, label: '' },
        bookmarks: [],
        settings: {},
      };
      lib.books.push(record);
      added.push(record);
    } catch (e) {
      console.error('导入失败:', p, e.message);
    }
  }
  if (added.length) saveLibrary(lib);
  return added;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('library:get', () => {
    const lib = loadLibrary();
    return { books: lib.books, settings: loadSettings() };
  });

  ipcMain.handle('library:import', async (_e, filePaths) => {
    if (!Array.isArray(filePaths)) return [];
    return importFiles(filePaths.map(String));
  });

  ipcMain.handle('dialog:openBooks', async () => {
    const result = await dialog.showOpenDialog(shelfWindow || undefined, {
      title: '选择要导入的图书',
      filters: [
        { name: '支持的图书格式', extensions: SUPPORTED_EXTS },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return importFiles(result.filePaths);
  });

  ipcMain.handle('library:remove', (_e, id) => {
    const lib = loadLibrary();
    const idx = lib.books.findIndex((b) => b.id === id);
    if (idx === -1) return false;
    lib.books.splice(idx, 1);
    saveLibrary(lib);
    try { fs.unlinkSync(path.join(booksDir, id)); } catch {}
    const w = readerWindows.get(id);
    if (w && !w.isDestroyed()) w.close();
    return true;
  });

  ipcMain.handle('library:update', (_e, id, patch) => {
    const lib = loadLibrary();
    const book = lib.books.find((b) => b.id === id);
    if (!book) return null;
    Object.assign(book, patch);
    saveLibrary(lib);
    return book;
  });

  ipcMain.handle('settings:update', (_e, patch) => {
    const s = Object.assign(loadSettings(), patch);
    saveSettings(s);
    return s;
  });

  ipcMain.handle('window:openReader', (_e, bookId) => {
    createReaderWindow(bookId);
    const lib = loadLibrary();
    const book = lib.books.find((b) => b.id === bookId);
    if (book) {
      book.lastOpenedAt = Date.now();
      saveLibrary(lib);
    }
    return true;
  });

  ipcMain.handle('window:focusShelf', () => {
    if (shelfWindow && !shelfWindow.isDestroyed()) shelfWindow.show();
  });

  ipcMain.handle('book:reveal', (_e, id) => {
    if (!SAFE_ID.test(id)) return false;
    const file = path.join(booksDir, id);
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    return true;
  });

  ipcMain.handle('book:readBuffer', async (_e, id) => {
    if (!SAFE_ID.test(id)) throw new Error('非法图书 ID');
    const file = path.join(booksDir, id);
    const buf = await fs.promises.readFile(file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  // ---------- 标注（高亮 / 批注） ----------
  // 按书存储：annotations/<bookId>.json，渲染进程保存整表（数据量小、结构简单）
  ipcMain.handle('annotations:get', (_e, id) => {
    if (!SAFE_ID.test(id)) return [];
    return readJson(path.join(annotationsDir, id + '.json'), []);
  });

  ipcMain.handle('annotations:save', (_e, id, list) => {
    if (!SAFE_ID.test(id) || !Array.isArray(list)) return false;
    writeJson(path.join(annotationsDir, id + '.json'), list);
    return true;
  });

  ipcMain.handle('annotations:export', (_e, id, markdown) => {
    if (!SAFE_ID.test(id)) throw new Error('非法图书 ID');
    const dir = path.join(userDataDir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const book = loadLibrary().books.find((b) => b.id === id);
    const name = (book?.title || '书摘').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const file = path.join(dir, `${name}-标注.md`);
    fs.writeFileSync(file, String(markdown), 'utf8');
    return file;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    userData: userDataDir,
    booksDir,
    isPackaged: app.isPackaged,
  }));
}

// ---------- 启动 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // Windows: 双击关联文件启动 → argv 里有文件路径
    const files = argv.filter((a) => SUPPORTED_EXTS.includes(path.extname(a).slice(1).toLowerCase()));
    if (files.length) {
      const added = importFiles(files);
      if (shelfWindow && !shelfWindow.isDestroyed()) {
        shelfWindow.show();
        shelfWindow.webContents.send('library:changed', added);
      }
    } else if (shelfWindow && !shelfWindow.isDestroyed()) {
      shelfWindow.show();
    }
  });

  app.whenReady().then(() => {
    // moyue-app:// → 项目文件（src/ 与 vendor/）
    protocol.handle('moyue-app', async (req) => {
      let p = decodeURIComponent(new URL(req.url).pathname);
      if (p === '/' || p === '') p = '/src/index.html';
      const file = path.normalize(path.join(__dirname, p));
      if (!file.startsWith(__dirname)) return new Response('Forbidden', { status: 403 });
      try {
        // 整 Buffer 返回并禁用缓存：流式响应体会导致 XHR 挂起，
        // 而磁盘缓存会让开发中的代码修改不生效
        const buf = await fs.promises.readFile(file);
        return new Response(buf, {
          status: 200,
          headers: {
            'Content-Type': guessMime(path.extname(file)),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });

    // moyue-book://book/<id>[.<ext>] → 书库文件（带 CORS 头，供 epub.js/pdf.js 跨源读取）
    // <ext> 仅供渲染库识别格式，磁盘文件仍以纯 <id> 存储
    // 注意：必须整Buffer返回——流式响应体在 XHR 下会挂起（Electron 已知问题）
    protocol.handle('moyue-book', async (req) => {
      const raw = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      const id = raw.replace(/\.[a-z0-9]+$/i, '');
      if (!SAFE_ID.test(id)) return new Response('Bad request', { status: 400 });
      const file = path.join(booksDir, id);
      try {
        const buf = await fs.promises.readFile(file);
        const ext = (raw.match(/\.([a-z0-9]+)$/i) || [])[1] || 'bin';
        return new Response(buf, {
          status: 200,
          headers: {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': String(buf.byteLength),
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-store',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });

    registerIpc();
    createShelfWindow();

    // 启动时通过命令行参数导入（Windows 文件关联）
    const startupFiles = process.argv.filter((a) => SUPPORTED_EXTS.includes(path.extname(a).slice(1).toLowerCase()));
    if (startupFiles.length) {
      const added = importFiles(startupFiles);
      setTimeout(() => {
        shelfWindow && shelfWindow.webContents.send('library:changed', added);
        if (added.length === 1) createReaderWindow(added[0].id);
      }, 1200);
    }

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createShelfWindow(); });
  });

  app.on('window-all-closed', () => app.quit());
}
