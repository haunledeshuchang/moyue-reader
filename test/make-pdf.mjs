// 生成测试用 PDF 文件（8 页，标准 PDF 1.4 语法）
import { writeFileSync } from 'node:fs';

const pages = [];
const NUM_PAGES = 8;
for (let i = 0; i < NUM_PAGES; i++) {
  const lines = [`Page ${i + 1} of ${NUM_PAGES}`, ''];
  for (let j = 0; j < 30; j++) {
    lines.push(`This is line ${j + 1} on page ${i + 1}. The quick brown fox jumps over the lazy dog. 0123456789.`);
  }
  pages.push(lines);
}

let pdf = '%PDF-1.4\n';
const offsets = [];
function addObj(num, body) {
  offsets[num] = pdf.length;
  pdf += `${num} 0 obj\n${body}\nendobj\n`;
}

// 1: catalog, 2: pages
addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
let kids = '';
for (let i = 0; i < NUM_PAGES; i++) kids += `${3 + i * 2} 0 R `;
addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${NUM_PAGES} >>`);

const fontObj = 3 + NUM_PAGES * 2;
for (let i = 0; i < NUM_PAGES; i++) {
  const pageObj = 3 + i * 2;
  const contentObj = pageObj + 1;
  let stream = 'BT /F1 13 Tf 60 800 Td 16 TL\n';
  for (const line of pages[i]) {
    const escaped = line.replace(/[()\\]/g, (c) => '\\' + c);
    stream += `(${escaped}) Tj T*\n`;
  }
  stream += 'ET';
  addObj(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
  addObj(contentObj, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
}
addObj(fontObj, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

const xrefStart = pdf.length;
pdf += `xref\n0 ${fontObj + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= fontObj; i++) {
  pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
}
pdf += `trailer\n<< /Size ${fontObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

writeFileSync('test-files/generated.pdf', pdf);
console.log('PDF 生成完成:', pdf.length, 'bytes,', NUM_PAGES, '页');
