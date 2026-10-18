/**
 * 生成墨阅应用图标：墨绿圆角底 + 白色「墨」字
 * 用法：electron build/gen-icon.cjs
 * 输出：build/icon.png（256）、build/icon-512.png、build/icon.ico（多尺寸 PNG 内嵌）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = __dirname;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
  #wrap{width:512px;height:512px;position:relative;}
  #tile{
    position:absolute;inset:0;border-radius:118px;
    background:linear-gradient(160deg,#12795f 0%,#0f6e56 45%,#0a5544 100%);
    box-shadow:inset 0 -10px 26px rgba(0,0,0,.18), inset 0 8px 20px rgba(255,255,255,.10);
    display:flex;align-items:center;justify-content:center;
  }
  #glyph{
    font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;
    font-weight:700;
    font-size:330px;
    line-height:1;
    color:#fbfaf6;
    letter-spacing:0;
    transform:translateY(-6px);
    text-shadow:0 4px 10px rgba(0,0,0,.16);
  }
</style></head>
<body><div id="wrap"><div id="tile"><div id="glyph">墨</div></div></div></body></html>`;

function buildIco(pngBySize) {
  const count = SIZES.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const s of SIZES) {
    const data = pngBySize[s];
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0); // width（256 记 0）
    e.writeUInt8(s >= 256 ? 0 : s, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...SIZES.map((s) => pngBySize[s])]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, paintWhenInitiallyHidden: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 400));
  try { await win.webContents.executeJavaScript('document.fonts.ready.then(()=>true)'); } catch { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 250));

  const img = await win.webContents.capturePage();
  const base = img.resize({ width: 512, height: 512, quality: 'best' });

  fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), base.toPNG());
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), base.resize({ width: 256, height: 256, quality: 'best' }).toPNG());

  const pngBySize = {};
  for (const s of SIZES) {
    pngBySize[s] = base.resize({ width: s, height: s, quality: 'best' }).toPNG();
  }
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(pngBySize));

  console.log('icon.ico', fs.statSync(path.join(OUT_DIR, 'icon.ico')).size, 'bytes');
  console.log('icon.png', fs.statSync(path.join(OUT_DIR, 'icon.png')).size, 'bytes');
  app.quit();
});
