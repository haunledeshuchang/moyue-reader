// 逐一点击字体按钮，读 iframe 内段落的「计算字体」与「实际渲染字体」
// 用法: node test/font-check.mjs [--keep]
import WebSocket from 'ws';

const PORT = +(process.env.CDP_PORT || 9222);

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
}

async function connect(match) {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && t.url.includes(match));
  if (!page) throw new Error('没有找到页面: ' + match);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('超时 ' + method)); } }, 30000);
  });
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('CSS.enable');
  return { send, close: () => ws.close() };
}

const ev = async (send, expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const { send, close } = await connect(process.env.READER_MATCH || 'reader.html');

// 拿到 iframe 里第一个 <p> 的 nodeId（走 DOM 树，贯穿 iframe 的 contentDocument）
async function probeNodeId() {
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
  let frameDocId = null;
  const walk = (n) => {
    if (!n) return;
    if (n.nodeName === 'IFRAME' && n.contentDocument) { frameDocId = n.contentDocument.nodeId; return; }
    for (const c of n.children || []) { walk(c); if (frameDocId) return; }
    if (n.contentDocument) { walk(n.contentDocument); }
  };
  walk(doc.root);
  if (!frameDocId) {
    // 内容文档可能没随 pierce 展开，退回按 frameId 取
    const ft = await send('Page.getFrameTree');
    const child = ft.frameTree.childFrames?.[0]?.frame;
    if (!child) return null;
    const fd = await send('DOM.getDocument', { depth: -1, pierce: true });
    frameDocId = fd.root.nodeId;
  }
  const q = await send('DOM.querySelector', { nodeId: frameDocId, selector: 'p' });
  return q.nodeId || null;
}

const keys = await ev(send, `[...document.querySelectorAll('#fontFamilySeg button')].map(b=>b.dataset.v)`);
console.log('字体按钮:', keys.join(', '));

const rows = [];
for (const k of keys) {
  await ev(send, `document.querySelector('#fontFamilySeg button[data-v="${k}"]').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const info = await ev(send, `(()=>{
    const d = document.querySelector('iframe').contentDocument;
    const p = d.querySelectorAll('p')[1] || d.querySelector('p');
    const cs = getComputedStyle(p);
    const active = document.querySelector('#fontFamilySeg button.active')?.dataset.v;
    const r = p.getBoundingClientRect();
    return JSON.stringify({ active, font: cs.fontFamily, size: cs.fontSize, w: Math.round(r.width), h: Math.round(r.height) });
  })()`);
  const o = JSON.parse(info);
  let real = '';
  const nodeId = await probeNodeId();
  if (nodeId) {
    try {
      const pf = await send('CSS.getPlatformFontsForNode', { nodeId });
      real = (pf.fonts || []).map((f) => `${f.familyName}(${f.glyphCount})`).join(' ');
    } catch (e) { real = '取字体失败: ' + e.message; }
  }
  rows.push({ 键: k, 按钮高亮: o.active, 计算字体: o.font.slice(0, 46), 实际渲染: real, 行宽: o.w });
  console.log(`[${k}] active=${o.active} 行宽=${o.w} 实际=${real}`);
}

console.log('\n--- 汇总 ---');
for (const r of rows) console.log(`${r.键.padEnd(8)} ${String(r.实际渲染).padEnd(30)} ${r.计算字体}`);
close();
