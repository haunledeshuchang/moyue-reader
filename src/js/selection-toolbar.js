/**
 * 墨阅 MoYue — 选中标注工具栏
 * 选中文本后浮现：六色荧光笔 + 批注入口 + 批注编辑（仿 Word 边注体验）
 * 2026-11：新增显式关闭按钮 —— 选中后若不想标注，可一键关掉（并清掉选区），
 *          不再只能靠「点空白处」（EPUB 内容在 iframe 里，点正文根本关不掉）。
 */

import { HL_COLORS } from './annotations.js';

export function createSelectionToolbar({ onApplyColor, onAnnotate, onClose }) {
  let currentColor = 'yellow';
  let activeCtx = null;

  const pop = document.createElement('div');
  pop.className = 'sel-pop';
  pop.hidden = true;

  // ---------- 主条：颜色 + 批注 + 关闭 ----------
  const bar = document.createElement('div');
  bar.className = 'sel-bar';

  const dots = document.createElement('div');
  dots.className = 'sel-dots';
  for (const c of HL_COLORS) {
    const dot = document.createElement('button');
    dot.className = 'sel-dot';
    dot.style.background = c.dot;
    dot.title = c.name;
    dot.dataset.color = c.key;
    dot.addEventListener('click', () => {
      currentColor = c.key;
      syncDots();
      if (activeCtx) {
        onApplyColor(c.key, activeCtx);
        hide();
      }
    });
    dots.appendChild(dot);
  }
  bar.appendChild(dots);

  const noteBtn = document.createElement('button');
  noteBtn.className = 'sel-note-btn';
  noteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>批注';
  noteBtn.addEventListener('click', () => {
    noteSection.hidden = !noteSection.hidden;
    if (!noteSection.hidden) {
      position(activeCtx);
      requestAnimationFrame(() => noteInput.focus());
    } else {
      position(activeCtx);
    }
  });
  bar.appendChild(noteBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'sel-close';
  closeBtn.title = '关闭（Esc）';
  closeBtn.setAttribute('aria-label', '关闭标注工具栏');
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss();
  });
  bar.appendChild(closeBtn);
  pop.appendChild(bar);

  // ---------- 批注编辑区 ----------
  const noteSection = document.createElement('div');
  noteSection.className = 'sel-note';
  noteSection.hidden = true;

  const noteInput = document.createElement('textarea');
  noteInput.className = 'sel-note-input';
  noteInput.placeholder = '写下阅读心得…（Ctrl+Enter 保存）';
  noteInput.rows = 3;
  noteSection.appendChild(noteInput);

  const noteActions = document.createElement('div');
  noteActions.className = 'sel-note-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'sel-note-cancel';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => { noteSection.hidden = true; position(activeCtx); });
  const saveBtn = document.createElement('button');
  saveBtn.className = 'sel-note-save';
  saveBtn.textContent = '保存批注';
  saveBtn.addEventListener('click', saveNote);
  noteActions.appendChild(cancelBtn);
  noteActions.appendChild(saveBtn);
  noteSection.appendChild(noteActions);
  pop.appendChild(noteSection);

  noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); dismiss(); }
  });

  function saveNote() {
    const note = noteInput.value.trim();
    if (!note) { noteInput.focus(); return; }
    if (activeCtx) onAnnotate(currentColor, note, activeCtx);
    noteInput.value = '';
    noteSection.hidden = true;
    hide();
  }

  function syncDots() {
    for (const d of dots.children) {
      d.classList.toggle('active', d.dataset.color === currentColor);
    }
  }
  syncDots();

  // ---------- 定位（选区上方，空间不足则下方） ----------
  function position(ctx) {
    if (!ctx?.rect) return;
    const r = ctx.rect;
    const w = pop.offsetWidth || 300;
    const h = pop.offsetHeight || 44;
    let left = r.left + (r.width || 0) / 2 - w / 2;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    let top = r.top - h - 10;
    if (top < 56) top = r.top + (r.height || 0) + 10;
    if (top + h > window.innerHeight - 8) top = Math.max(56, window.innerHeight - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function show(ctx) {
    activeCtx = ctx;
    pop.hidden = false;
    noteSection.hidden = true;
    noteInput.value = '';
    position(ctx);
  }

  /** 收起但保留选区（用于「点了别处」这类温和关闭） */
  function hide() {
    pop.hidden = true;
    noteSection.hidden = true;
    activeCtx = null;
  }

  /** 用户主动关闭：收起并清掉选区，避免文字一直蓝着 */
  function dismiss() {
    hide();
    try { onClose?.(); } catch { /* 忽略 */ }
  }

  // 点击外部关闭（主文档；EPUB 的 iframe 由渲染器转发进来）
  document.addEventListener('pointerdown', (e) => {
    if (pop.hidden) return;
    if (pop.contains(e.target)) return;
    hide();
  }, true);

  document.body.appendChild(pop);

  return {
    show,
    hide,
    dismiss,
    isVisible: () => !pop.hidden,
    /** 供 iframe 内的 pointerdown 调用：点书页即收起（不清选区，选字过程还要用） */
    onOutsidePointerDown() { if (!pop.hidden) hide(); },
  };
}
