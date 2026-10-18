/**
 * 墨阅 MoYue — 标注系统（荧光笔高亮 / 阅读批注）
 * 数据模型与存储；各渲染器只依赖这里的定位结构：
 *   epub  → { cfi }
 *   txt   → { chapter, start, end }   （章内文本偏移，基于渲染文本流）
 *   pdf   → { page, start, end }      （页内文本偏移，基于文本层）
 */

export const HL_COLORS = [
  { key: 'red',    name: '红色', fill: 'rgba(232,80,80,.40)',  dot: '#e05252' },
  { key: 'orange', name: '橙色', fill: 'rgba(240,146,58,.45)', dot: '#e88a2e' },
  { key: 'yellow', name: '黄色', fill: 'rgba(240,198,52,.52)', dot: '#e8bd2a' },
  { key: 'green',  name: '绿色', fill: 'rgba(76,180,110,.42)', dot: '#3f9e63' },
  { key: 'blue',   name: '蓝色', fill: 'rgba(74,142,224,.40)', dot: '#3f7fd4' },
  { key: 'purple', name: '紫色', fill: 'rgba(152,112,214,.42)', dot: '#8a63c9' },
];

export const HL_COLOR_MAP = Object.fromEntries(HL_COLORS.map((c) => [c.key, c]));

export function colorFill(key) {
  return (HL_COLOR_MAP[key] || HL_COLOR_MAP.yellow).fill;
}

export function newAnnotationId() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 创建一本书的标注仓库（内存表 + 落盘） */
export function createAnnotationStore(bookId) {
  let list = [];
  let loaded = false;
  const listeners = new Set();

  async function load() {
    if (!loaded) {
      try { list = await moyue.getAnnotations(bookId) || []; } catch { list = []; }
      loaded = true;
    }
    return list;
  }

  async function commit() {
    await moyue.saveAnnotations(bookId, list);
    listeners.forEach((fn) => fn(list));
  }

  return {
    load,
    all: () => list,
    get: (id) => list.find((a) => a.id === id),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async add(ann) {
      const full = { id: newAnnotationId(), type: 'highlight', color: 'yellow', text: '', note: '', createdAt: Date.now(), updatedAt: Date.now(), ...ann };
      list = [...list, full];
      await commit();
      return full;
    },
    async update(id, patch) {
      const a = list.find((x) => x.id === id);
      if (!a) return null;
      Object.assign(a, patch, { updatedAt: Date.now() });
      await commit();
      return a;
    },
    async remove(id) {
      list = list.filter((x) => x.id !== id);
      await commit();
    },
    /** 文本类：某章的高亮（按起点排序） */
    forChapter(chapter) {
      return list.filter((a) => a.loc && a.loc.chapter === chapter).sort((a, b) => a.loc.start - b.loc.start);
    },
    /** PDF：某页的高亮 */
    forPage(page) {
      return list.filter((a) => a.loc && a.loc.page === page).sort((a, b) => a.loc.start - b.loc.start);
    },
  };
}

/**
 * 把 DOM Range 的起止点换算成“根元素文本流偏移”。
 * 用 selectNodeContents + setEnd 量长度，天然兼容元素/文本容器。
 */
export function textFlowOffset(root, container, offset) {
  try {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(container, offset);
    return r.toString().length;
  } catch { return 0; }
}

/**
 * 在 root 的文本流 [start, end) 区间包裹 <mark>。
 * 先快照全部文本节点再拆裹，避免边拆边遍历导致的位置漂移。
 */
export function wrapTextRange(root, start, end, { fill, id } = {}) {
  if (end <= start) return null;
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    nodes.push({ node, nStart: pos, nEnd: pos + len });
    pos += len;
  }
  let firstMark = null;
  for (const item of nodes) {
    if (item.nEnd <= start || item.nStart >= end) continue;
    const s = Math.max(start, item.nStart) - item.nStart;
    const e = Math.min(end, item.nEnd) - item.nStart;
    let target = item.node;
    if (e < target.nodeValue.length) target.splitText(e);
    if (s > 0) target = target.splitText(s);
    const mark = document.createElement('mark');
    mark.className = 'hl';
    if (id) mark.dataset.ann = id;
    if (fill) mark.style.background = fill;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    if (!firstMark) firstMark = mark;
  }
  return firstMark;
}

/** 读取根元素内某个 <mark data-ann> 所处的页序号（列布局翻页用） */
export function markPageIndex(mark, contentEl, pageWidth, gap, currentPage) {
  const cRect = contentEl.getBoundingClientRect();
  const mRect = mark.getBoundingClientRect();
  const dx = mRect.left - cRect.left;
  const stride = pageWidth + gap;
  return Math.max(0, Math.min(999, currentPage + Math.round(dx / stride)));
}
