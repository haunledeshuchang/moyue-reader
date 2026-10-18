/**
 * 墨阅 MoYue — 预加载脚本
 * 通过 contextBridge 向渲染进程暴露安全的 API 表面
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moyue', {
  // 书库
  getLibrary: () => ipcRenderer.invoke('library:get'),
  importBooks: (paths) => ipcRenderer.invoke('library:import', paths),
  openBookDialog: () => ipcRenderer.invoke('dialog:openBooks'),
  removeBook: (id) => ipcRenderer.invoke('library:remove', id),
  updateBook: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
  readBookBuffer: (id) => ipcRenderer.invoke('book:readBuffer', id),
  revealBook: (id) => ipcRenderer.invoke('book:reveal', id),

  // 设置
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  // 窗口
  openReader: (bookId) => ipcRenderer.invoke('window:openReader', bookId),
  focusShelf: () => ipcRenderer.invoke('window:focusShelf'),

  // 应用信息
  appInfo: () => ipcRenderer.invoke('app:info'),

  // 事件（主 → 渲染）
  onLibraryChanged: (cb) => {
    const listener = (_e, books) => cb(books);
    ipcRenderer.on('library:changed', listener);
    return () => ipcRenderer.removeListener('library:changed', listener);
  },

  // 书籍文件 URL（moyue-book:// 协议；ext 让 epub.js/pdf.js 等按扩展名识别格式）
  bookUrl: (id, ext) => 'moyue-book://book/' + id + (ext ? '.' + String(ext).toLowerCase() : ''),

  // 标注（荧光笔高亮 / 批注）
  getAnnotations: (id) => ipcRenderer.invoke('annotations:get', id),
  saveAnnotations: (id, list) => ipcRenderer.invoke('annotations:save', id, list),
  exportAnnotations: (id, markdown) => ipcRenderer.invoke('annotations:export', id, markdown),
});
