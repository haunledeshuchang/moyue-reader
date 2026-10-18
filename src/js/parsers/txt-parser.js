/**
 * 墨阅 MoYue — TXT 解析器
 * 编码自动检测（UTF-8 / UTF-16 / GBK）+ 章节智能切分
 */

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];

function startsWith(bytes, sig) {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/**
 * 编码检测与解码
 * @param {Uint8Array} bytes
 * @returns {{text: string, encoding: string}}
 */
export function decodeTxt(bytes) {
  // 1. BOM 优先
  if (startsWith(bytes, BOM_UTF8)) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (startsWith(bytes, BOM_UTF16LE)) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (startsWith(bytes, BOM_UTF16BE)) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  // 2. 严格 UTF-8 校验
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.includes('\ufffd')) return { text, encoding: 'utf-8' };
  } catch { /* 落到 GBK */ }
  // 3. GBK / GB18030 兜底（中文 Windows 常见编码）
  try {
    const text = new TextDecoder('gb18030').decode(bytes);
    return { text, encoding: 'gb18030' };
  } catch { /* 忽略 */ }
  // 4. 最终兜底
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
}

// 章节标题匹配模式（行级）
const CHAPTER_PATTERNS = [
  /^\s*第\s*[0-9０-９零〇一二三四五六七八九十百千两]+\s*[章回卷节部篇幕话]\s*[^\n]{0,60}$/,
  /^\s*(序|序章|序言|序曲|引子|引首|楔子|序幕|尾声|终章|终曲|番外|番外篇|后记|跋|前言|自序)[^\n]{0,60}$/,
  /^\s*Chapter\s+[0-9IVXLCivxlc]+\b[^\n]{0,60}$/i,
  // 关键词后只允许标点或至多 3 个首字母大写的词，排除 "introduction had been made." 这类正文句
  /^\s*(PROLOGUE|EPILOGUE|FOREWORD|PREFACE|AFTERWORD|INTRODUCTION)\b[.:;,]?\s*([A-Z][\w'’-]{0,20}\s*){0,3}$/i,
  // 纯数字编号标题（弱模式）：只接受「数字 + 至多两个短词」，
  // 避免误匹配页码/地址行（如 "156 CHARING CROSS ROAD"、"1.F"）
  /^\s*[（【]?[0-9０-９]{1,4}[）】]?\s*[^\s]{2,10}(\s+[^\s]{2,10})?$/,
];

/**
 * 章节切分
 * @param {string} text 全文
 * @returns {{title: string, start: number, end: number}[]}
 */
export function splitChapters(text) {
  const lines = text.split('\n');
  const hits = []; // {lineIndex, title, charIndex}
  let charIndex = 0;
  let licenseTail = false; // Gutenberg 版权声明之后的内容不再识别章节
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^\**\s*END OF (THE|THIS) PROJECT GUTENBERG/i.test(trimmed)) licenseTail = true;
    if (!licenseTail && trimmed.length > 0 && trimmed.length <= 70) {
      // 强模式（明确的章节关键词）直接命中
      const strongHit = CHAPTER_PATTERNS.slice(0, 4).some((re) => re.test(trimmed));
      // 弱模式（纯数字编号）需排除正文短句：以句读结尾且较长的行视为正文
      const isBodyLine = /[。！？，；:.!?;:,]$/.test(trimmed) && trimmed.length > 20;
      const weakHit = !isBodyLine && CHAPTER_PATTERNS[4].test(trimmed);
      if (strongHit || weakHit) {
        // 清理标题尾部残留的标点/括号
        const title = trimmed.replace(/[\s.。、,，:：;；\[\]【】（）()«»]+$/, '').slice(0, 60);
        if (title) hits.push({ lineIndex: i, title, charIndex });
      }
    }
    charIndex += line.length + 1;
  }
  if (hits.length < 2) {
    return [{ title: '全文', start: 0, end: text.length }];
  }
  const chapters = [];
  for (let i = 0; i < hits.length; i++) {
    chapters.push({
      title: hits[i].title,
      start: hits[i].charIndex,
      end: i + 1 < hits.length ? hits[i + 1].charIndex : text.length,
    });
  }
  return chapters;
}

/** 提取可能的内嵌书名（开头常见格式） */
export function guessTitle(text, fallback = '未命名文本') {
  const head = text.slice(0, 2000);
  const lines = head.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20);
  for (const line of lines) {
    if (line.length >= 2 && line.length <= 40 && !/[。！？，；]/.test(line)) {
      // 跳过 Gutenberg 头之类的
      if (/project gutenberg|ebook| Produced by /i.test(line)) continue;
      return line;
    }
  }
  return fallback;
}

/** 将纯文本按段落转为 HTML（保留空行分段） */
export function textToHtml(text) {
  const paras = text.split(/\n{2,}/);
  return paras
    .map((p) => {
      const lines = p.split('\n').map((l) => escapeHtml(l.trim())).filter((l) => l.length > 0);
      if (!lines.length) return '';
      return '<p>' + lines.join('<br/>') + '</p>';
    })
    .filter(Boolean)
    .join('\n');
}

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
