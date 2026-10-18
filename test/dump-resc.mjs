// 检查 KF8 文件的 RESC 记录分布
import { readFileSync } from 'node:fs';
const f = process.argv[2];
const buf = new Uint8Array(readFileSync(f));
const u16 = (b, o) => ((b[o] << 8) | b[o + 1]) & 0xffff;
const u32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
const cstr = (b, o, m) => { let e = o; while (e < b.length && e < o + m && b[e] !== 0) e++; return new TextDecoder('windows-1252').decode(b.subarray(o, e)); };

const numRecords = u16(buf, 76);
const offs = [];
for (let i = 0; i < numRecords; i++) offs.push(u32(buf, 78 + i * 8));
const getRec = (i) => buf.subarray(offs[i], i + 1 < numRecords ? offs[i + 1] : buf.length);
const rec0 = getRec(0);

// EXTH 121 / 201
let k8b = null, cover = null;
if (u32(rec0, 0x80) & 0x40) {
  const eo = u32(rec0, 0x14) + 16;
  let pos = eo + 12;
  for (let i = 0; i < u32(rec0, eo + 8); i++) {
    const id = u32(rec0, pos), size = u32(rec0, pos + 4);
    const d = rec0.subarray(pos + 8, pos + size);
    if (id === 121) k8b = u32(d, 0);
    if (id === 201) cover = u32(d, 0);
    pos += size;
  }
}
console.log('numRecords:', numRecords, 'EXTH121(boundary):', k8b, 'EXTH201(cover):', cover);

// 找 KF8 头
let k8h = -1;
if (k8b && k8b < numRecords && cstr(getRec(k8b + 1), 16, 4) === 'MOBI') k8h = k8b + 1;
if (k8h < 0) {
  for (let i = 1; i < numRecords; i++) {
    if (cstr(getRec(i), 0, 8) === 'BOUNDARY' && cstr(getRec(i + 1), 16, 4) === 'MOBI') { k8h = i + 1; break; }
  }
}
console.log('KF8 头记录:', k8h);
if (k8h > 0) {
  const k8 = getRec(k8h);
  console.log('KF8 textRecords:', u16(k8, 8), 'firstResource:', u32(k8, 0x6c), 'firstNonText:', u32(k8, 0x50), 'compression:', u16(k8, 0));
  const textEnd = k8h + u16(k8, 8);
  console.log('KF8 文本结束记录:', textEnd);
  // 列出 textEnd 之后每条记录的魔数
  for (let i = Math.max(0, textEnd - 1); i < numRecords; i++) {
    const r = getRec(i);
    const magic = cstr(r, 0, 8).replace(/[^\x20-\x7e]/g, '.');
    console.log(`  记录 ${i}: ${r.length} bytes, magic="${magic}"`);
  }
}
