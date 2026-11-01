/**
 * 墨阅 MoYue — 翻页手势引擎
 * 手感三要素：跟手（拖拽实时跟随）/ 回弹（越界橡皮筋 + 未达阈值弹簧）/
 * 判定（距离 + 速度双阈值）。
 * 同时接管 iframe 内文档（EPUB）：iframe 不冒泡指针事件，需挂双文档监听。
 *
 * 2026-11 修订（第三次）：
 *  - **鼠标一律不能翻页**。之前「左键点右半页 / 右键上一页」虽然带双击保护，
 *    但在划词标注时还是会被误判——手一抖就翻页，选中的文字也跟着没了。
 *    现在指针在书页上只做一件事：选字。翻页只剩三条路：边缘的翻页按钮、
 *    键盘 ← →、程序调用 turn()。
 *  - 手势悬空自愈：pointerup 丢失（鼠标移出窗口松手等）时不再永久锁死后续手势。
 */

const TAP_SLOP = 6;        // 轻点最大位移 px
const TAP_MS = 420;        // 轻点最长时间 ms
const TAP_DELAY = 240;     // 单击判定延迟：给「双击选词」一个取消窗口
const TURN_RATIO = 0.2;    // 拖过页宽比例即翻页
const TURN_VELOCITY = 0.3; // px/ms 速度即翻页（快速轻扫）
const RUBBER = 0.32;       // 越界阻尼系数
const WHEEL_LOCK = 420;    // 触控板横滑节流 ms
const LONG_PRESS_MS = 420; // 长按进入文本选择模式
const GESTURE_TTL = 4000;  // 手势超过该时长仍未收到 up → 视为失效

export function createPageTurn({
  viewport,
  canGo = () => true,        // 该书/该方向是否可翻（书级边界）
  canMove = null,            // 视觉是否可移动（默认同 canGo）
  enabled = () => true,
  // 2026-10 修正：鼠标拖拽翻页会与「选字 / 划词批注」争夺指针，导致想选文字却翻了页。
  // 2026-11 再收紧：鼠标单击 / 右键翻页同样会误触，全部关掉。
  // 现在指针在正文里只负责选字，翻页只走「边缘翻页按钮」和键盘。
  // 传 drag:true / wheel:true / tap:true 可恢复旧行为（目前没有调用方这么做）。
  drag = false,
  wheel = false,
  tap = false,               // 鼠标单击翻页（默认关闭，见上方说明）
  onDragStart = () => {},
  onDragMove = () => {},
  onDragEnd = () => {},
  onTurn = () => {},
  onTap = () => {},          // (ratio) => void  仅在 tap:true 时可用
  onRightClick = null,       // () => void      仅在 tap:true 时可用
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
  let tapTimer = null;
  let tapSeq = 0;

  // 只接受落在 viewport（或其内嵌 iframe）上的手势，
  // 避免点击顶栏 / 箭头 / 目录等 UI 时误触发翻页
  function inViewport(target) {
    if (!target) return false;
    if (viewport.contains(target)) return true;
    const frame = target.ownerDocument?.defaultView?.frameElement;
    return !!frame && viewport.contains(frame);
  }

  function docOf(target) {
    return target?.ownerDocument || viewport.ownerDocument;
  }

  /** 文档（含 iframe 内）是否存在有效文本选区 */
  function hasSelectionIn(doc) {
    try {
      const win = doc?.defaultView || window;
      const s = win.getSelection ? win.getSelection() : null;
      return !!s && !s.isCollapsed && (s.toString() || '').trim().length > 0;
    } catch { return false; }
  }

  /**
   * 把点击位置换算成「阅读区内的水平比例」。
   * iframe 内的 clientX 是相对 iframe 视口的，而 epub.js 的 iframe 往往宽达数千
   * 像素并被父容器横向滚动，因此要先换回屏幕坐标再对 viewport 取比例。
   */
  function tapRatio(clientX, target) {
    const doc = docOf(target);
    const frameEl = doc?.defaultView?.frameElement || null;
    const vr = viewport.getBoundingClientRect();
    const screenX = frameEl ? frameEl.getBoundingClientRect().left + clientX : clientX;
    return Math.min(1, Math.max(0, (screenX - vr.left) / Math.max(1, vr.width)));
  }

  function cancelQueuedTap() {
    clearTimeout(tapTimer);
    tapTimer = null;
    tapSeq++;
  }

  /** 单击判定：延迟一拍再执行，期间若发生双击（选词）则自动取消 */
  function queueTap(e, g) {
    if (!tap) return;
    if (g.hadSel) return;                                     // 从已有选区上按下（想取消选区）→ 不翻页
    if (Math.abs(e.clientX - g.startX) > TAP_SLOP) return;     // 拖拽过 → 不是单击
    if (Math.abs(e.clientY - g.startY) > TAP_SLOP) return;
    if (e.timeStamp - g.startT > TAP_MS) return;               // 按太久（长按/选字）
    const t = e.target;
    if (t?.closest?.('a[href], button, input, textarea, select, audio, video, .page-arrow')) return;
    const doc = docOf(t);
    const x = e.clientX;
    const target = t;
    const seq = ++tapSeq;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      tapTimer = null;
      if (seq !== tapSeq) return;                 // 期间又点了一下 → 双击，放弃翻页
      if (hasSelectionIn(doc)) return;            // 已形成选区（双击选词）→ 不翻页
      onTap(tapRatio(x, target));
    }, TAP_DELAY);
  }

  function onDown(e) {
    if (!enabled()) return;
    const isRight = e.pointerType === 'mouse' && e.button === 2;
    if (e.pointerType === 'mouse' && e.button !== 0 && !isRight) return;
    if (gesture && e.timeStamp - (gesture.startT || 0) > GESTURE_TTL) gesture = null; // 悬空自愈
    if (gesture) return;
    if (!inViewport(e.target)) return;
    // 点箭头不接管手势：箭头有自己的 click 翻页，避免“单击正文/箭头”误翻页
    if (e.target?.closest?.('.page-arrow')) return;

    const doc = docOf(e.target);
    const sel = hasSelectionIn(doc);

    if (isRight) {
      // 右键：无选区时 = 上一页，并吃掉右键菜单；有选区时保留原生菜单（便于复制）
      if (tap && !sel && onRightClick) {
        e.preventDefault();
        cancelQueuedTap();
        onRightClick();
      }
      return;
    }

    // 新的按下动作会打断上一次待定的单击判定（双击保护）
    cancelQueuedTap();

    gesture = {
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, startT: e.timeStamp,
      lastX: e.clientX, lastT: e.timeStamp, vx: 0,
      dir: null, active: false, hadSel: sel, doc,
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
    if (!g.active) {
      // 轻点：交点击判定（延迟一拍，避免双击选词被误判为翻页）
      if (!drag) queueTap(e, g);
      else if (Math.abs(e.clientX - g.startX) <= TAP_SLOP && Math.abs(e.clientY - g.startY) <= TAP_SLOP && e.timeStamp - g.startT < TAP_MS) {
        onTap(tapRatio(e.clientX, e.target));
      }
      return;
    }
    const raw = e.clientX - g.startX;
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
  function onContextMenu(e) {
    if (!tap || !onRightClick) return;
    // 有选区时保留原生菜单（复制 / 搜索）；否则吃掉，因为右键已经 = 上一页
    if (hasSelectionIn(e.currentTarget)) return;
    e.preventDefault();
  }
  function attachDocument(doc) {
    if (!doc || attached.has(doc)) return;
    attached.add(doc);
    doc.addEventListener('pointerdown', onDown);
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onCancel);
    doc.addEventListener('wheel', onWheel, { passive: true });
    doc.addEventListener('contextmenu', onContextMenu);
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
      cancelQueuedTap();
      for (const doc of attached) {
        doc.removeEventListener('pointerdown', onDown);
        doc.removeEventListener('pointermove', onMove);
        doc.removeEventListener('pointerup', onUp);
        doc.removeEventListener('pointercancel', onCancel);
        doc.removeEventListener('wheel', onWheel);
        doc.removeEventListener('contextmenu', onContextMenu);
        doc.removeEventListener('mousemove', onHoverMove);
      }
      attached.clear();
      shadowL.remove();
      shadowR.remove();
    },
  };
}
