// 分段下载大文件（规避沙箱网络单连接传输限制）
import { createWriteStream } from 'node:fs';
import { statSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import https from 'node:https';

const url = process.argv[2];
const out = process.argv[3];
const CHUNK = 96 * 1024;

const HDRS = { Accept: 'application/vnd.github.v3.raw', 'User-Agent': 'moyue-reader-dev' };

function head(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', headers: HDRS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(head(next, depth + 1));
      }
      resolve({ status: res.statusCode, length: parseInt(res.headers['content-length'] || '0', 10), acceptRanges: res.headers['accept-ranges'] });
      res.resume();
    });
    req.on('error', reject);
    req.end();
  });
}

function getRange(url, start, end, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...HDRS, Range: `bytes=${start}-${end}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(getRange(next, start, end, depth + 1));
      }
      if (res.statusCode !== 206 && res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

(async () => {
  if (existsSync(out) && process.argv.includes('--resume')) {
    // 断点续传：从现有文件大小开始
  }
  const h = await head(url);
  console.log('HEAD:', h);
  if (!h.length) { console.log('无 content-length，放弃分段'); process.exit(1); }
  if (h.acceptRanges !== 'bytes') { console.log('服务端不支持 Range，放弃分段'); process.exit(1); }
  let start = 0;
  if (existsSync(out)) start = statSync(out).size;
  if (start >= h.length) { console.log('文件已完整'); process.exit(0); }
  if (start > 0) console.log(`断点续传，从 ${start} 开始`);
  let attempt = 0;
  while (start < h.length) {
    const end = Math.min(start + CHUNK - 1, h.length - 1);
    try {
      const buf = await getRange(url, start, end);
      if (buf.length === 0) throw new Error('空响应');
      appendFileSync(out, buf);
      start += buf.length;
      attempt = 0;
      process.stdout.write(`\r已下载 ${start}/${h.length} (${(start / h.length * 100).toFixed(1)}%)`);
    } catch (e) {
      if (++attempt > 5) { console.error('\n重试次数用尽:', e.message); process.exit(1); }
      process.stdout.write(`\r重试 ${attempt} (${e.message})...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.log('\n完成:', statSync(out).size, 'bytes');
})().catch((e) => { console.error(e); process.exit(1); });
