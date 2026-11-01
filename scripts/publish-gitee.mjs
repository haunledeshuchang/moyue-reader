#!/usr/bin/env node
/**
 * 在 Gitee 上创建发行版并上传安装包附件。
 *
 * 背景：Gitee 的「导入已有仓库」只同步代码和 tag，不会带上 GitHub 的 Release 与
 * 二进制附件，所以每次发版都要单独建一次发行版、再传两个 exe。
 *
 * 用法：
 *   GITEE_TOKEN=xxxx node scripts/publish-gitee.mjs
 *
 * 令牌：https://gitee.com/profile/personal_access_tokens （勾选 projects 即可）
 *
 * 附件统一用 ASCII 文件名上传（MoYue-0.1.2-x64.exe），这样直链不会被
 * 百分号转义成一长串 %E5%A2%A8...，贴到群里、写进抖音简介都干净。
 */
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.GITEE_TOKEN;
const OWNER = process.env.GITEE_OWNER || 'huanledeshuchang';
const REPO = process.env.GITEE_REPO || 'moyue-reader';
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const TAG = `v${VERSION}`;
const API = 'https://gitee.com/api/v5';
const DRY = process.env.DRY === '1';

if (!TOKEN && !DRY) {
  console.error('缺少 GITEE_TOKEN；先在 https://gitee.com/profile/personal_access_tokens 生成（勾 projects）');
  process.exit(1);
}

async function call(pathname, { method = 'GET', json, form, query = {} } = {}) {
  const qs = new URLSearchParams({ access_token: TOKEN, ...query }).toString();
  const res = await fetch(`${API}${pathname}?${qs}`, {
    method,
    headers: json ? { 'Content-Type': 'application/json' } : undefined,
    body: json ? JSON.stringify(json) : form,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text.slice(0, 300);
    const err = new Error(`${method} ${pathname} → ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const BODY = `MoYue（墨阅）${VERSION} —— Windows 本地阅读器：EPUB / PDF / TXT / MOBI

这一版主要在「手感」上较真，都是长期读下来才会遇到的毛刺：

- 荧光笔只给字上色。EPUB 改用浏览器原生 CSS Highlight API（::highlight）绘制，
  颜色紧贴字形，不再按行盒画出一整条比字还高的色带；改字号、翻页、开关目录之后
  也不会留在原地糊到别的段落上。
- 翻页只认左右边缘的按钮和键盘 ← →。正文里单击、双击、右键、拖拽一律不翻页，
  划词标注时再也不会被一次误触清掉选区。按钮命中区放大到 64×148，
  鼠标偏十几像素也点得中（以前 42px 圆钮，稍一犹豫就点空，像是「没反应」）。
- 选中文字浮出的工具条加了关闭按钮（×，或按 Esc），只是随手选中一段、
  并不想标注时终于能关掉了。
- 全书页码按真实分页重排算出来，不是按字符数估。扉页、版权页这类短章
  不会再被算成整页；单/双页切换、开目录、改字号之后总页数稳定，每翻一页严格 +1。

安装包：
- MoYue-${VERSION}-x64.exe：安装版，建桌面与开始菜单快捷方式，关联 epub/pdf/mobi/txt
- MoYue-${VERSION}-portable.exe：便携版，单个 exe，免安装直接运行

Windows x64，未签名，SmartScreen 可能提示一次（更多信息 → 仍要运行）。`;

/** 本地中文文件名 → 上传用 ASCII 名 */
const ASSETS = [
  { local: `dist/墨阅MoYue-${VERSION}-x64.exe`, upload: `MoYue-${VERSION}-x64.exe` },
  { local: `dist/墨阅MoYue-${VERSION}-便携版.exe`, upload: `MoYue-${VERSION}-portable.exe` },
  { local: `dist/MoYue-${VERSION}-x64.exe`, upload: `MoYue-${VERSION}-x64.exe` },
  { local: `dist/MoYue-${VERSION}-portable.exe`, upload: `MoYue-${VERSION}-portable.exe` },
];

function pickAssets() {
  const seen = new Set();
  const out = [];
  for (const a of ASSETS) {
    if (seen.has(a.upload)) continue;
    if (fs.existsSync(a.local)) { seen.add(a.upload); out.push(a); }
  }
  return out;
}

async function main() {
  const files = pickAssets();
  if (!files.length) {
    console.error(`dist/ 下没有 ${VERSION} 的安装包，先跑 npm run dist`);
    process.exit(1);
  }
  for (const f of files) {
    const mb = (fs.statSync(f.local).size / 1048576).toFixed(1);
    console.log(`待上传 ${f.upload}  ←  ${f.local}（${mb} MB）`);
  }
  if (DRY) return;

  const repo = await call(`/repos/${OWNER}/${REPO}`);
  console.log(`[1/3] 仓库：${repo.full_name}（id ${repo.id}）`);

  const list = await call(`/repos/${OWNER}/${REPO}/releases`, { query: { per_page: 100 } });
  let release = (list || []).find((r) => r.tag_name === TAG) || null;

  if (release) {
    console.log(`[2/3] 发行版已存在：${release.tag_name}（${(release.assets || []).length} 个附件）`);
  } else {
    release = await call(`/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      json: {
        tag_name: TAG,
        target_commitish: process.env.GITEE_BRANCH || 'main',
        name: `MoYue ${VERSION} — 墨阅`,
        body: BODY,
        prerelease: false,
      },
    });
    console.log(`[2/3] 发行版已创建：${release.tag_name}（id ${release.id}）`);
  }

  const existing = new Set((release.assets || []).map((a) => a.name));
  for (const f of files) {
    if (existing.has(f.upload)) {
      console.log(`     已存在，跳过：${f.upload}`);
      continue;
    }
    const buf = fs.readFileSync(f.local);
    const form = new FormData();
    form.append('file', new Blob([buf]), f.upload);
    process.stdout.write(`     上传 ${f.upload}（${(buf.length / 1048576).toFixed(1)} MB）…`);
    try {
      const att = await call(`/repos/${OWNER}/${REPO}/releases/${release.id}/attach_files`, {
        method: 'POST',
        form,
      });
      console.log(` ok${att?.name ? `（${att.name}）` : ''}`);
    } catch (e) {
      console.log(`\n     失败：${e.message}`);
    }
  }

  console.log('[3/3] 核对结果');
  const final = await call(`/repos/${OWNER}/${REPO}/releases`, { query: { per_page: 100 } });
  const rel = (final || []).find((r) => r.tag_name === TAG);
  console.log(`\n发行版页面：https://gitee.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
  for (const a of rel?.assets || []) {
    if (!/\.exe$/i.test(a.name)) continue;
    console.log(`  ${a.name}（${((a.size || 0) / 1048576).toFixed(1)} MB）`);
    console.log(`  https://gitee.com/${OWNER}/${REPO}/releases/download/${TAG}/${a.name}`);
  }
}

main().catch((e) => {
  console.error('\n失败：', e.message);
  process.exit(1);
});
