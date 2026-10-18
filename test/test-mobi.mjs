// MOBI 解析器 Node 测试
import { readFileSync } from 'node:fs';
import { parseMobi, palmdocDecompress } from '../src/js/parsers/mobi-parser.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('用法: node test-mobi.mjs <file.mobi> [...]');
  process.exit(0);
}

let pass = 0, fail = 0;
for (const f of files) {
  console.log('='.repeat(60));
  console.log('文件:', f);
  try {
    const buf = new Uint8Array(readFileSync(f));
    const t0 = Date.now();
    const r = parseMobi(buf);
    const ms = Date.now() - t0;
    console.log(`解析成功 (${ms}ms), isK8=${r.isK8}, rawHtml=${r.rawHtml.length} 字符, images=${r.images.size}, cover=${r.coverRecord}`);
    console.log('meta:', JSON.stringify(r.meta, (k, v) => typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : v));
    if (r.warnings.length) console.log('warnings:', r.warnings);
    // 内容抽样检查
    const sample = r.rawHtml.replace(/\s+/g, ' ').slice(0, 300);
    console.log('正文开头:', sample);
    // 图片类型统计
    const types = {};
    for (const v of r.images.values()) types[v.mediaType] = (types[v.mediaType] || 0) + 1;
    if (Object.keys(types).length) console.log('图片类型:', types);
    // 基础断言
    const ok = r.rawHtml.length > 200 && r.meta.title && r.meta.title.length > 0;
    console.log(ok ? '✅ PASS' : '❌ FAIL (内容过短或标题为空)');
    ok ? pass++ : fail++;
  } catch (e) {
    if (e.message.includes('DRM')) {
      console.log('✅ PASS (正确识别 DRM 加密并拒绝)');
      pass++;
    } else {
      console.log('❌ FAIL:', e.message);
      fail++;
    }
  }
}

// LZ77 算法自测：构造简单压缩流验证往返
console.log('='.repeat(60));
console.log('PalmDOC LZ77 算法自测...');
{
  // 编码规则: c1=0x80|(dist>>5), c2=((dist&0x1F)<<3)|(len-3)
  // 构造: 'A' 字面量 + 2 个匹配(dist=1, len=10) → 共 21 个 A
  const input = [0x41]; // 'A' 字面量
  for (let k = 0; k < 2; k++) {
    const dist = 1, len = 10;
    const c1 = 0x80 | (dist >> 5);
    const c2 = ((dist & 0x1f) << 3) | (len - 3);
    input.push(c1, c2);
  }
  const out = palmdocDecompress(new Uint8Array(input));
  const s = new TextDecoder('windows-1252').decode(out);
  const expect = 'A'.repeat(21);
  console.log('解压结果:', JSON.stringify(s), s === expect ? '✅ PASS' : `❌ FAIL (期望 21 个 A，实际 ${s.length} 个)`);
  s === expect ? pass++ : fail++;
}

// 字面量与 0xC0-0xFF 规则自测：0xC0 → " @"（空格+0x40），0xE1 → " a"
{
  const out = palmdocDecompress(new Uint8Array([0x41, 0xc0, 0xe1, 0x00]));
  const s = new TextDecoder('windows-1252').decode(out);
  const expect = 'A @ a\u0000';
  console.log('字面量/扩展字节规则:', JSON.stringify(s), s === expect ? '✅ PASS' : `❌ FAIL (期望 ${JSON.stringify(expect)})`);
  s === expect ? pass++ : fail++;
}

console.log('='.repeat(60));
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
