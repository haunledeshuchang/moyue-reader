// 打开阅读器并全程记录 console / 网络请求，用于诊断渲染卡住问题
// 用法: node watch-reader.mjs <bookId> [等待秒数]
import WebSocket from 'ws';

const PORT = 9222;
const bookId = process.argv[2];
const waitMs = +(process.argv[4] || 25) * 1000;

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function main() {
  // 1. 先关掉已有阅读器窗口
  const targets = await getTargets();
  const oldReader = targets.find((t) => t.type === 'page' && t.url.includes('reader.html'));
  if (oldReader) {
    const ws0 = new WebSocket(oldReader.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r) => ws0.on('open', r));
    ws0.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }));
    await new Promise((r) => setTimeout(r, 800));
    ws0.close();
  }

  // 2. 从书架打开新阅读器
  const shelf = (await getTargets()).find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!shelf) throw new Error('书架窗口未找到');
  const wsShelf = new WebSocket(shelf.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => wsShelf.on('open', r));
  let sid = 0;
  const shelfPending = new Map();
  wsShelf.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && shelfPending.has(m.id)) { shelfPending.get(m.id)(m); shelfPending.delete(m.id); }
  });
  const shelfSend = (method, params = {}) => new Promise((res) => {
    const id = ++sid;
    shelfPending.set(id, res);
    wsShelf.send(JSON.stringify({ id, method, params }));
  });
  await shelfSend('Runtime.evaluate', { expression: `window.moyue.openReader(${JSON.stringify(bookId)})`, awaitPromise: true });
  wsShelf.close();

  // 3. 等阅读器窗口出现
  await new Promise((r) => setTimeout(r, 2500));
  const reader = (await getTargets()).find((t) => t.type === 'page' && t.url.includes('reader.html'));
  if (!reader) throw new Error('阅读器窗口未出现');

  // 4. 连接阅读器，开启全部域
  const ws = new WebSocket(reader.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ');
      logs.push(`[console.${m.params.type}] ${text}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push(`[EXCEPTION] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      logs.push(`[log.${e.level}] ${e.text}${e.url ? ' @ ' + e.url : ''}`);
    }
    if (m.method === 'Network.requestWillBeSent' && /moyue-book|epub|zip|container|opf|ncx/i.test(m.params.request.url)) {
      logs.push(`[NET →] ${m.params.request.url}`);
    }
    if (m.method === 'Network.responseReceived' && /moyue-book/i.test(m.params.response.url)) {
      logs.push(`[NET ←] ${m.params.response.status} ${m.params.response.url}`);
    }
    if (m.method === 'Network.loadingFailed') {
      logs.push(`[NET ✗] ${m.params.errorText}`);
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: false });

  // 5. 观察期
  await new Promise((r) => setTimeout(r, waitMs));
  const snap = await send('Runtime.evaluate', {
    expression: `(()=>{const r=window.__moyueReader;return JSON.stringify({rd:!!r?.renderer,ifr:!!document.querySelector('#epubView iframe'),ld:document.querySelector('#loading').hidden,toc:r?.toc?.length,title:document.querySelector('#bookTitle')?.textContent})})()`,
    returnByValue: true,
  });
  console.log('=== 状态快照 ===');
  console.log(snap.result?.value);
  console.log('=== 日志 (' + logs.length + ' 条) ===');
  console.log(logs.join('\n'));
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
