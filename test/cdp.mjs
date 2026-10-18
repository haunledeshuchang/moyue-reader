// CDP 自动化验证：连接 Electron 渲染进程，执行 JS、截图
// 用法: node cdp.mjs <命令> [参数]
//   shot <file.png> [selector]  截图（可选只截某元素）
//   eval <表达式>               执行 JS 并打印结果
//   import <file...>            导入测试图书
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const PORT = +(process.env.CDP_PORT || 9222);

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function connectPage(urlMatch) {
  const targets = await getTargets();
  let page;
  if (urlMatch) {
    page = targets.find((t) => t.type === 'page' && t.url.includes(urlMatch));
  } else {
    page = targets.find((t) => t.type === 'page');
  }
  if (!page) throw new Error('没有找到页面目标' + (urlMatch ? ' (' + urlMatch + ')' : ''));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  let msgId = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      console.error('[console.' + msg.params.type + ']', text);
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 60000);
    });
  await send('Runtime.enable');
  await send('Page.enable');
  return { send, close: () => ws.close() };
}

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

// 通过 Input 域派发可信鼠标事件（Chromium 会自动转换为 PointerEvent）
async function mouse(send, type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    clickCount: type === 'mousePressed' ? 1 : 0,
    buttons: type === 'mouseReleased' ? 0 : 1,
    ...extra,
  });
}

const [cmd, ...args] = process.argv.slice(2);
// eval/shot/import 默认连书架页；用 @<url片段> 前缀可指定页面
const urlFlagIdx = args.findIndex((a) => a.startsWith('@'));
let urlMatch = null;
if (urlFlagIdx !== -1) {
  urlMatch = args[urlFlagIdx].slice(1);
  args.splice(urlFlagIdx, 1);
}

try {
  const { send, close } = await connectPage(urlMatch);

  if (cmd === 'eval') {
    const result = await evaluate(send, args[0]);
    console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result));
  } else if (cmd === 'drag') {
    // drag <x1> <y1> <x2> <y2> [steps] — 鼠标拖拽（自动转 PointerEvent）
    const [x1, y1, x2, y2, steps = 12] = args.map(Number);
    await mouse(send, 'mouseMoved', x1, y1);
    await mouse(send, 'mousePressed', x1, y1);
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      await mouse(send, 'mouseMoved', x, y);
      await new Promise((r) => setTimeout(r, 16));
    }
    await mouse(send, 'mouseReleased', x2, y2);
    console.log('拖拽完成:', x1, y1, '→', x2, y2);
  } else if (cmd === 'longpress') {
    // longpress <x1> <y1> [x2 y2] [holdMs] — 长按进入选择模式，可选拖动扩展
    const [x1, y1, x2, y2, holdMs = 550] = args.map(Number);
    await mouse(send, 'mouseMoved', x1, y1);
    await mouse(send, 'mousePressed', x1, y1);
    await new Promise((r) => setTimeout(r, Number.isFinite(holdMs) ? holdMs : 550));
    if (Number.isFinite(x2) && Number.isFinite(y2)) {
      const steps = 14;
      for (let i = 1; i <= steps; i++) {
        const x = x1 + ((x2 - x1) * i) / steps;
        const y = y1 + ((y2 - y1) * i) / steps;
        await mouse(send, 'mouseMoved', x, y);
        await new Promise((r) => setTimeout(r, 22));
      }
      await mouse(send, 'mouseReleased', x2, y2);
      console.log('长按并拖动完成:', x1, y1, '→', x2, y2);
    } else {
      await mouse(send, 'mouseReleased', x1, y1);
      console.log('长按完成:', x1, y1);
    }
  } else if (cmd === 'click') {
    // click <x> <y> [count]
    const [x, y, count = 1] = args.map(Number);
    await mouse(send, 'mouseMoved', x, y);
    await mouse(send, 'mousePressed', x, y);
    await mouse(send, 'mouseReleased', x, y);
    console.log('已点击:', x, y);
  } else if (cmd === 'mousemove') {
    const [x, y] = args.map(Number);
    await mouse(send, 'mouseMoved', x, y);
    console.log('已移动:', x, y);
  } else if (cmd === 'shot') {
    const file = args[0];
    const selector = args[1];
    let params = { format: 'png' };
    if (selector) {
      const box = await evaluate(send, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
      if (box) params.clip = { ...box, scale: 1 };
    }
    const r = await send('Page.captureScreenshot', params);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('截图已保存:', file, `(${Math.round(r.data.length / 1365)}KB)`);
  } else if (cmd === 'import') {
    const files = JSON.stringify(args);
    const result = await evaluate(send, `window.moyue.importBooks(${files})`);
    console.log('导入结果:', JSON.stringify(result, null, 2));
    await new Promise((r) => setTimeout(r, 2500));
  } else if (cmd === 'openReader') {
    await evaluate(send, `window.moyue.openReader(${JSON.stringify(args[0])})`);
    await new Promise((r) => setTimeout(r, 4000));
    const targets = await getTargets();
    const reader = targets.find((t) => t.type === 'page' && t.url.includes('reader.html'));
    console.log('阅读器窗口:', reader ? reader.url : '未找到');
  } else if (cmd === 'pages') {
    const targets = await getTargets();
    for (const t of targets) console.log(t.type, '|', t.url, '|', t.title);
  } else {
    console.log('未知命令:', cmd);
  }
  close();
  process.exit(0);
} catch (e) {
  console.error('CDP 错误:', e.message);
  process.exit(1);
}
