/**
 * 墨阅 MoYue — 选中标注工具栏
 * 选中文本后浮现：六色荧光笔 + 批注入口 + 批注编辑（仿 Word 边注体验）
 */
import { HL_COLORS } from './annotations.js';

export function createSelectionToolbar({ onApplyColor, onAnnotate }) {
  let currentColor = 'yellow';
  let activeCtx = null;

  const pop = document.createElement('div');
  pop.className = 'sel-pop';
  pop.hidden = true;

  // ---------- 主条：颜色 + 批注 ----------
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
    }
  });
  bar.appendChild(noteBtn);
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
  cancelBtn.addEventListener('click', () => { noteSection.hidden = true; });
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
    if (e.key === 'Escape') { e.stopPropagation(); noteSection.hidden = true; }
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
  function hide() {
    pop.hidden = true;
    activeCtx = null;
  }

  // 点击外部关闭
  document.addEventListener('pointerdown', (e) => {
    if (pop.hidden) return;
    if (!pop.contains(e.target)) hide();
  }, true);

  document.body.appendChild(pop);

  return { show, hide, isVisible: () => !pop.hidden };
}
