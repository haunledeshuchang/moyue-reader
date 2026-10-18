/**
 * 墨阅 MoYue — 翻页手势引擎
 * 手感三要素：跟手（拖拽实时跟随）/ 回弹（越界橡皮筋 + 未达阈值弹簧）/
 * 判定（距离 + 速度双阈值，支持轻点分区与触控板横滑）。
 * 同时接管 iframe 内文档（EPUB）：iframe 不冒泡指针事件，需挂双文档监听。
 */

const TAP_SLOP = 6;        // 轻点最大位移 px
const TAP_MS = 400;        // 轻点最长时间 ms
const TURN_RATIO = 0.2;    // 拖过页宽比例即翻页
const TURN_VELOCITY = 0.3; // px/ms 速度即翻页（快速轻扫）
const RUBBER = 0.32;       // 越界阻尼系数
const WHEEL_LOCK = 420;    // 触控板横滑节流 ms
const LONG_PRESS_MS = 420; // 长按进入文本选择模式

export function createPageTurn({
  viewport,
  canGo = () => true,        // 该书/该方向是否可翻（书级边界）
  canMove = null,            // 视觉是否可移动（默认同 canGo）
  enabled = () => true,
  // 2026-10 修正：鼠标拖拽翻页会与「选字 / 划词批注」争夺指针，导致想选文字却翻了页。
  // 现在默认关闭拖拽与触控板横滑，翻页只由「键盘 ← →」和「贴边箭头」触发；
  // 传 drag:true / wheel:true 可恢复旧行为。
  drag = false,
  wheel = false,
  onDragStart = () => {},
  onDragMove = () => {},
  onDragEnd = () => {},
  onTurn = () => {},
  onTap = () => {},
  onLongPress = null,        // (x, y) => void   长按进入文本选择
  onLongPressMove = null,    // (x, y) => void   拖动扩展选择
  onLongPressEnd = null,     // () => void       选择结束
  onHover = null,            // (x, y) => void   鼠标移动（用于箭头浮现；iframe 内也转发）
}) {
  const movable = canMove || canGo;
  const width = () => viewport.clientWidth || 1;

  // ---------- 翻页阴影（书页之间的纵深） ----------
  const shadowL = document.createElement('div');
  shadowL.className = 'turn-shadow turn-shadow-l';
  const shadowR = document.createElement('div');
  shadowR.className = 'turn-shadow turn-shadow-r';
  for (const s of [shadowL, shadowR]) {
    s.hidden = true;
    viewport.appendChild(s);
  }

  function updateShadow(raw) {
    const p = Math.min(1, Math.abs(raw) / width());
    if (raw < 0) { shadowR.hidden = false; shadowL.hidden = true; shadowR.style.opacity = String(0.85 * p); }
    else if (raw > 0) { shadowL.hidden = false; shadowR.hidden = true; shadowL.style.opacity = String(0.85 * p); }
    else { shadowL.hidden = true; shadowR.hidden = true; }
  }
  function hideShadow() { shadowL.hidden = true; shadowR.hidden = true; }

  // ---------- 手势状态 ----------
  let gesture = null;
  let wheelLock = 0;
  let lpTimer = null;
  let longPress = false;
  let lpPointerId = null;

  // 只接受落在 viewport（或其内嵌 iframe）上的手势，
  // 避免点击顶栏 / 箭头 / 目录等 UI 时误触发翻页
  function inViewport(target) {
    if (!target) return false;
    if (viewport.contains(target)) return true;
    const frame = target.ownerDocument?.defaultView?.frameElement;
    return !!frame && viewport.contains(frame);
  }

  function onDown(e) {
    if (!enabled()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (gesture) return;
    if (!inViewport(e.target)) return;
    // 点箭头不接管手势：箭头有自己的 click 翻页，避免“单击正文/箭头”误翻页
    if (e.target?.closest?.('.page-arrow')) return;
    gesture = {
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, startT: e.timeStamp,
      lastX: e.clientX, lastT: e.timeStamp, vx: 0,
      dir: null, active: false,
    };
    // 长按计时：静置超过阈值且未构成拖拽 → 进入文本选择模式
    if (onLongPress) {
      clearTimeout(lpTimer);
      const x = e.clientX, y = e.clientY;
      lpTimer = setTimeout(() => {
        if (!gesture || gesture.active) return;
        longPress = true;
        lpPointerId = gesture.pointerId;
        gesture = null;
        onLongPress(x, y);
      }, LONG_PRESS_MS);
    }
  }

  function onMove(e) {
    if (longPress) {
      if (e.pointerId === lpPointerId) onLongPressMove?.(e.clientX, e.clientY);
      return;
    }
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const g = gesture;
    // 拖拽关闭时：指针移动一律交还给浏览器（原生选字 / 划词）
    if (!drag) { clearTimeout(lpTimer); gesture = null; return; }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (!g.active) {
      // 纵向意图 → 让位原生滚动
      if (Math.abs(dy) > TAP_SLOP && Math.abs(dy) > Math.abs(dx)) { clearTimeout(lpTimer); gesture = null; return; }
      if (Math.abs(dx) <= TAP_SLOP) return;
      const dir = dx < 0 ? 'next' : 'prev';
      if (!canGo(dir)) { gesture = null; return; } // 无路可走，不劫持手势
      g.active = true;
      g.dir = dir;
      clearTimeout(lpTimer);
      // 捕获指针：iframe 内按下时也能在父文档持续接收（失败则靠双文档监听兜底）
      try { viewport.setPointerCapture(e.pointerId); } catch { /* 跨文档捕获可能不被支持 */ }
      onDragStart(dir);
    }

    const dt = e.timeStamp - g.lastT;
    if (dt > 0) g.vx = (e.clientX - g.lastX) / dt;
    g.lastX = e.clientX;
    g.lastT = e.timeStamp;

    // 越界橡皮筋：视觉可移动方向之外加阻尼
    const beyond = (dx < 0 && !movable('next')) || (dx > 0 && !movable('prev'));
    const damped = beyond ? dx * RUBBER : dx;
    onDragMove(dx, g.dir, damped);
    updateShadow(dx);
  }

  function finish(e, cancelled) {
    clearTimeout(lpTimer);
    if (longPress) {
      longPress = false;
      lpPointerId = null;
      onLongPressEnd?.();
      return;
    }
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    hideShadow();
    try { viewport.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    if (cancelled) {
      if (g.active) onDragEnd(0, 0, g.dir, false);
      return;
    }
    const raw = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.active) {
      // 轻点：位移小且时间短 → 按水平位置分区（左 1/3 上一页，右 1/3 下一页）
      // 拖拽/轻点分区已默认关闭（会干扰选字），保留能力供需要时开启
      if (drag && Math.abs(raw) <= TAP_SLOP && Math.abs(dy) <= TAP_SLOP && e.timeStamp - g.startT < TAP_MS) {
        const r = viewport.getBoundingClientRect();
        onTap(Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))));
      }
      return;
    }
    const dt = Math.max(1, e.timeStamp - g.startT);
    const vx = Math.abs(g.vx) > 1e-3 ? g.vx : raw / dt;
    const sign = g.dir === 'next' ? -1 : 1;
    const progress = raw * sign;
    const confirmed = (progress > width() * TURN_RATIO || vx * sign > TURN_VELOCITY) && canGo(g.dir);
    onDragEnd(raw, vx, g.dir, confirmed);
  }

  function onUp(e) { finish(e, false); }
  function onCancel(e) { finish(e, true); }

  function onWheel(e) {
    if (!wheel) return;
    if (!enabled()) return;
    if (!inViewport(e.target)) return;
    if (Math.abs(e.deltaX) < 24 || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return;
    if (e.timeStamp < wheelLock) return;
    const dir = e.deltaX < 0 ? 'next' : 'prev';
    if (!canGo(dir)) return;
    wheelLock = e.timeStamp + WHEEL_LOCK;
    onTurn(dir);
  }

  // ---------- 文档挂载（主文档 + iframe 文档） ----------
  const attached = new Set();
  function onHoverMove(e) { onHover?.(e.clientX, e.clientY); }
  function attachDocument(doc) {
    if (!doc || attached.has(doc)) return;
    attached.add(doc);
    doc.addEventListener('pointerdown', onDown);
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onCancel);
    doc.addEventListener('wheel', onWheel, { passive: true });
    // 鼠标移动 → 箭头浮现（iframe 内也转发，否则 EPUB 阅读区永不触发）
    doc.addEventListener('mousemove', onHoverMove);
    // 阻止 iframe 内图片/文本的浏览器原生拖拽
    doc.addEventListener('dragstart', (e) => e.preventDefault());
  }
  attachDocument(viewport.ownerDocument);

  return {
    viewport,
    attachDocument,
    /** 程序化翻页（箭头 / 键盘 / 轻点分区） */
    turn(dir) { if (canGo(dir)) onTurn(dir); },
    isDragging: () => !!gesture && gesture.active,
    destroy() {
      for (const doc of attached) {
        doc.removeEventListener('pointerdown', onDown);
        doc.removeEventListener('pointermove', onMove);
        doc.removeEventListener('pointerup', onUp);
        doc.removeEventListener('pointercancel', onCancel);
        doc.removeEventListener('wheel', onWheel);
        doc.removeEventListener('mousemove', onHoverMove);
      }
      attached.clear();
      shadowL.remove();
      shadowR.remove();
    },
  };
}
