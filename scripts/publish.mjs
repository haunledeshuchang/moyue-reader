#!/usr/bin/env node
/**
 * 通过 GitHub REST API 发布仓库（不依赖 git push，适合 github.com:443 被代理拦截的网络）。
 *
 * 用法：GITHUB_TOKEN=ghp_xxx node scripts/publish.mjs
 *
 * 做的事：
 *   1. 校验 token 身份
 *   2. 仓库不存在则创建（public）
 *   3. 用 Git Data API 一次提交全部文件（blobs → tree → commit → ref）
 *   4. 写入 About 描述、主页、topics
 *   5. 创建 Release 并上传安装包/便携版（ASCII 文件名，便于分享链接）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER_HINT = 'haunledeshuchang';
const REPO = 'moyue-reader';
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const ROOT = process.cwd();

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN');
  process.exit(1);
}

async function api(pathname, { method = 'GET', body, headers = {}, host = API, raw = false } = {}) {
  const url = host + pathname;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: raw ? 'application/vnd.github+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'moyue-publisher',
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    duplex: raw && typeof body?.pipe === 'function' ? 'half' : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(`${method} ${pathname} → ${res.status} ${(json && json.message) || text.slice(0, 200)}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

function listFiles() {
  const out = execSync('git ls-files', { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  // 1. 身份
  const me = await api('/user');
  console.log(`[1/5] 已认证：${me.login}`);
  const owner = me.login;

  // 2. 仓库
  let repo;
  try {
    repo = await api(`/repos/${owner}/${REPO}`);
    console.log(`[2/5] 仓库已存在：${repo.html_url}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    repo = await api('/user/repos', {
      method: 'POST',
      body: {
        name: REPO,
        description: 'A local-first, paper-like EPUB / PDF / TXT / MOBI reader for Windows. Two-page spreads, real book typography, annotations, zero network calls.',
        homepage: '',
        private: false,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        auto_init: false,
      },
    });
    console.log(`[2/5] 仓库已创建：${repo.html_url}`);
  }

  // 3. 一次性提交全部文件
  // 空仓库无法直接写 blob（409 Git Repository is empty），先落一个初始提交
  let parent = null;
  try {
    const ref = await api(`/repos/${owner}/${REPO}/git/ref/heads/main`);
    parent = ref.object.sha;
  } catch {
    const init = await api(`/repos/${owner}/${REPO}/contents/README.md`, {
      method: 'PUT',
      body: {
        message: 'chore: initialise repository',
        content: Buffer.from('# MoYue\n').toString('base64'),
      },
    });
    parent = init.commit.sha;
    console.log('     空仓库已初始化 main 分支');
  }

  const files = listFiles();
  console.log(`[3/5] 上传 ${files.length} 个文件…`);
  const entries = [];
  for (const f of files) {
    const abs = path.join(ROOT, f);
    const buf = fs.readFileSync(abs);
    const blob = await api(`/repos/${owner}/${REPO}/git/blobs`, {
      method: 'POST',
      body: { content: buf.toString('base64'), encoding: 'base64' },
    });
    entries.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
    process.stdout.write('.');
  }
  console.log('');

  const tree = await api(`/repos/${owner}/${REPO}/git/trees`, {
    method: 'POST',
    body: { tree: entries },
  });

  const commit = await api(`/repos/${owner}/${REPO}/git/commits`, {
    method: 'POST',
    body: {
      message: `feat: MoYue ${VERSION} — local-first EPUB/PDF/TXT/MOBI reader for Windows`,
      tree: tree.sha,
      parents: parent ? [parent] : [],
    },
  });

  if (parent) {
    await api(`/repos/${owner}/${REPO}/git/refs/heads/main`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: true },
    });
  } else {
    await api(`/repos/${owner}/${REPO}/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/main', sha: commit.sha },
    });
  }
  console.log(`     提交完成 ${commit.sha.slice(0, 8)}（默认分支 main）`);

  // 4. About / topics
  await api(`/repos/${owner}/${REPO}`, {
    method: 'PATCH',
    body: {
      description: 'A local-first, paper-like EPUB / PDF / TXT / MOBI reader for Windows. Two-page spreads, real book typography, annotations, zero network calls.',
      homepage: `https://github.com/${owner}/${REPO}/releases/latest`,
    },
  });
  await api(`/repos/${owner}/${REPO}/topics`, {
    method: 'PUT',
    body: {
      names: ['ebook-reader', 'epub', 'pdf', 'mobi', 'azw3', 'txt', 'electron', 'windows', 'reader', 'annotations', 'typography', 'offline-first', 'local-first', 'desktop-app'],
    },
  });
  console.log('[4/5] 简介 / topics 已设置');

  // 5. Release + 资产
  const tag = `v${VERSION}`;
  const notes = fs.existsSync('docs/RELEASE_NOTES.md')
    ? fs.readFileSync('docs/RELEASE_NOTES.md', 'utf8')
    : `## MoYue ${VERSION}\n\nSee README for details.`;

  let release;
  try {
    release = await api(`/repos/${owner}/${REPO}/releases/tags/${tag}`);
    console.log(`[5/5] Release ${tag} 已存在，跳过创建`);
  } catch (e) {
    if (e.status !== 404) throw e;
    release = await api(`/repos/${owner}/${REPO}/releases`, {
      method: 'POST',
      body: {
        tag_name: tag,
        target_commitish: 'main',
        name: `MoYue ${VERSION} — 墨阅`,
        body: notes,
        draft: false,
        prerelease: false,
      },
    });
    console.log(`[5/5] Release ${tag} 已创建`);
  }

  const assets = [
    { file: `dist/墨阅MoYue-${VERSION}-x64.exe`, name: `MoYue-${VERSION}-x64.exe`, label: 'Windows installer (x64)' },
    { file: `dist/墨阅MoYue-${VERSION}-便携版.exe`, name: `MoYue-${VERSION}-portable.exe`, label: 'Portable (no install)' },
  ];

  const existing = new Set((release.assets || []).map((a) => a.name));
  for (const a of assets) {
    if (existing.has(a.name)) {
      console.log(`     资产已存在：${a.name}`);
      continue;
    }
    if (!fs.existsSync(a.file)) {
      console.log(`     跳过（文件不存在）：${a.file}`);
      continue;
    }
    const size = fs.statSync(a.file).size;
    console.log(`     上传 ${a.name}（${(size / 1048576).toFixed(1)} MB）…`);
    const buf = fs.readFileSync(a.file);
    await api(
      `/repos/${owner}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(a.name)}&label=${encodeURIComponent(a.label)}`,
      {
        method: 'POST',
        host: UPLOADS,
        raw: true,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
        body: buf,
      },
    );
    console.log(`     完成 ${a.name}`);
  }

  console.log('\n=== 发布完成 ===');
  console.log(`仓库：https://github.com/${owner}/${REPO}`);
  console.log(`Release：https://github.com/${owner}/${REPO}/releases/tag/${tag}`);
  console.log(`下载：https://github.com/${owner}/${REPO}/releases/download/${tag}/MoYue-${VERSION}-x64.exe`);
  console.log(`便携：https://github.com/${owner}/${REPO}/releases/download/${tag}/MoYue-${VERSION}-portable.exe`);
}

main().catch((e) => {
  console.error('\n发布失败：', e.message);
  if (e.payload) console.error(JSON.stringify(e.payload, null, 2).slice(0, 800));
  process.exit(1);
});
