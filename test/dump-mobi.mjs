// MOBI 头部 Debug 转储
import { readFileSync } from 'node:fs';

const f = process.argv[2];
const buf = new Uint8Array(readFileSync(f));
const u16 = (b, o) => ((b[o] << 8) | b[o + 1]) & 0xffff;
const u32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
const cstr = (b, o, m) => { let e = o; while (e < b.length && e < o + m && b[e] !== 0) e++; return new TextDecoder('windows-1252').decode(b.subarray(o, e)); };

console.log('文件大小:', buf.length);
console.log('PalmDB name:', JSON.stringify(cstr(buf, 0, 32)));
console.log('type:', JSON.stringify(cstr(buf, 60, 4)), 'creator:', JSON.stringify(cstr(buf, 64, 4)));
const numRecords = u16(buf, 76);
console.log('numRecords:', numRecords);
const offs = [];
for (let i = 0; i < numRecords; i++) offs.push(u32(buf, 78 + i * 8));
console.log('记录偏移前10:', offs.slice(0, 10));
console.log('记录偏移后5:', offs.slice(-5));
console.log('偏移是否单调递增:', offs.every((v, i) => i === 0 || v >= offs[i - 1]));
const rec0 = buf.subarray(offs[0], offs[1] ?? buf.length);
console.log('rec0 大小:', rec0.length, 'magic@16:', JSON.stringify(cstr(rec0, 16, 4)));
console.log('compression:', u16(rec0, 0), 'textLength:', u32(rec0, 4), 'textRecords:', u16(rec0, 8), 'recordSize:', u16(rec0, 0xa), 'crypto:', u16(rec0, 0xc));
console.log('headerLength:', u32(rec0, 0x14), 'type:', u32(rec0, 0x18), 'codepage:', u32(rec0, 0x1c), 'version:', u32(rec0, 0x24));
console.log('firstNonText:', u32(rec0, 0x50), 'firstResource:', u32(rec0, 0x6c));
console.log('exthFlags:', u32(rec0, 0x80).toString(16), 'traildataFlags:', u16(rec0, 0xf2));
console.log('titleOffset:', u32(rec0, 0x54), 'titleLength:', u32(rec0, 0x58));
// EXTH
if (u32(rec0, 0x80) & 0x40) {
  const eo = u32(rec0, 0x14) + 16;
  console.log('EXTH magic:', JSON.stringify(cstr(rec0, eo, 4)), 'len:', u32(rec0, eo + 4), 'count:', u32(rec0, eo + 8));
  let pos = eo + 12;
  for (let i = 0; i < u32(rec0, eo + 8) && pos + 8 <= rec0.length; i++) {
    const id = u32(rec0, pos), size = u32(rec0, pos + 4);
    if (size < 8 || pos + size > rec0.length) break;
    const d = rec0.subarray(pos + 8, pos + size);
    let val;
    if (size === 9) val = d[0];
    else if (size === 10) val = u16(d, 0);
    else if (size === 12) val = u32(d, 0);
    else val = new TextDecoder('utf-8').decode(d).slice(0, 60);
    console.log(`  EXTH ${id}: size=${size} value=${JSON.stringify(String(val))}`);
    pos += size;
  }
}
// 每条记录大小
const sizes = offs.map((v, i) => (i + 1 < offs.length ? offs[i + 1] : buf.length) - v);
console.log('记录大小: min=', Math.min(...sizes), 'max=', Math.max(...sizes), 'avg=', (sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1));
console.log('前 8 条大小:', sizes.slice(0, 8));
// 第一条文本记录开头
if (offs[1] !== undefined) {
  const r1 = buf.subarray(offs[1], offs[2] ?? buf.length);
  console.log('rec1 前 32 字节:', Array.from(r1.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));
}
