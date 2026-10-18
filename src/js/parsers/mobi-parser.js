/**
 * 墨阅 MoYue — 自研 MOBI / AZW3(KF8) 解析器
 *
 * 依据公开格式规范实现（REA 式"按规范重建"）：
 *   PalmDB 头 → Record0(PalmDOC 头 + MOBI 头 + EXTH 元数据)
 *   → PalmDOC LZ77 解压 / 无压缩 → KF8 边界定位 → 原始 HTML 提取
 *
 * 算法逻辑对齐权威实现 KindleUnpack / libmobi（同源于 MOBI Pocket 格式规范）。
 * 纯二进制解析，无 DOM 依赖：既可在 Electron 渲染进程使用，也可在 Node 中测试。
 */

const TEXT_ENCODINGS = {
  1252: 'windows-1252',
  65001: 'utf-8',
  936: 'gbk',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
};

function u16(b, o) { return ((b[o] << 8) | b[o + 1]) & 0xffff; }
function u32(b, o) { return (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0); }
function readCString(b, o, max) {
  let end = o;
  while (end < b.length && end < o + max && b[end] !== 0) end++;
  return new TextDecoder('windows-1252').decode(b.subarray(o, end));
}

/**
 * PalmDOC LZ77 解压（规范定义）：
 *   0x00        → 字面量 0x00
 *   0x01-0x08   → 后续 c 个字节原样复制
 *   0x09-0x7F   → 字面量（自身）
 *   0x80-0xBF   → 匹配对：距离 11 位，长度 3-10（可重叠）
 *   0xC0-0xFF   → 两字节：空格 + (c ^ 0x80)
 */
export function palmdocDecompress(data) {
  const out = [];
  const n = data.length;
  let p = 0;
  while (p < n) {
    const c = data[p++];
    if (c >= 1 && c <= 8) {
      for (let k = 0; k < c && p < n; k++) out.push(data[p++]);
    } else if (c < 128) {
      out.push(c);
    } else if (c >= 192) {
      out.push(0x20, c ^ 0x80);
    } else {
      if (p >= n) break;
      const c2 = data[p++];
      const m = (c << 8) | c2;
      const dist = (m >> 3) & 0x07ff;
      const len = (m & 7) + 3;
      if (dist === 0 || dist > out.length) continue; // 损坏数据保护
      for (let k = 0; k < len; k++) out.push(out[out.length - dist]);
    }
  }
  return new Uint8Array(out);
}

function getSizeOfTrailingDataEntry(data) {
  let num = 0;
  const start = Math.max(0, data.length - 4);
  for (let i = start; i < data.length; i++) {
    const v = data[i];
    if (v & 0x80) num = 0;
    num = ((num << 7) | (v & 0x7f)) >>> 0;
  }
  return num;
}

/** 按 traildata_flags(0xF2) 规则裁剪记录尾部数据 */
function trimTrailingDataEntries(data, trailers, multibyte) {
  let d = data;
  for (let t = 0; t < trailers; t++) {
    const num = getSizeOfTrailingDataEntry(d);
    if (num <= 0 || num >= d.length) break;
    d = d.subarray(0, d.length - num);
  }
  if (multibyte && d.length > 0) {
    const num = (d[d.length - 1] & 3) + 1;
    if (num < d.length) d = d.subarray(0, d.length - num);
  }
  return d;
}

function decodeText(bytes, codepage) {
  const label = TEXT_ENCODINGS[codepage] || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch (e) {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * HUFF/CDIC 解压器（MOBI6 时代可选压缩，格式规范移植自 KindleUnpack/libmobi）
 * HUFF 记录: "HUFF\0\0\0\x18" + off1 + off2, dict1@off1(256×u32), dict2@off2(64×u32)
 * CDIC 记录: "CDIC\0\0\0\x10" + phrases + bits, 偏移表@16
 * 解码: 64 位滑动窗口按位读取, 大整数运算保证正确性
 */
class HuffcdicReader {
  constructor() {
    this.dict1 = [];   // {codelen, term, maxcode} × 256
    this.mincode = []; // 33 项
    this.maxcode = []; // 33 项
    this.dictionary = []; // [Uint8Array, cachedFlag]
  }

  loadHuff(huff) {
    if (!(huff[0] === 0x48 && huff[1] === 0x55 && huff[2] === 0x46 && huff[3] === 0x46 &&
          huff[4] === 0 && huff[5] === 0 && huff[6] === 0 && huff[7] === 0x18)) {
      throw new Error('invalid huff header');
    }
    const off1 = u32(huff, 8), off2 = u32(huff, 12);
    for (let i = 0; i < 256; i++) {
      const v = u32(huff, off1 + i * 4);
      const codelen = v & 0x1f;
      const term = (v & 0x80) !== 0;
      const maxcode = BigInt((v >>> 8) + 1) * (1n << BigInt(32 - codelen)) - 1n;
      this.dict1.push({ codelen, term, maxcode });
    }
    this.mincode = [0n];
    this.maxcode = [0n];
    for (let codelen = 1; codelen <= 32; codelen++) {
      const mincode = u32(huff, off2 + (codelen - 1) * 8);
      const maxcode = u32(huff, off2 + (codelen - 1) * 8 + 4);
      this.mincode.push(BigInt(mincode) * (1n << BigInt(32 - codelen)));
      this.maxcode.push(BigInt(maxcode + 1) * (1n << BigInt(32 - codelen)) - 1n);
    }
  }

  loadCdic(cdic) {
    if (!(cdic[0] === 0x43 && cdic[1] === 0x44 && cdic[2] === 0x49 && cdic[3] === 0x43 &&
          cdic[4] === 0 && cdic[5] === 0 && cdic[6] === 0 && cdic[7] === 0x10)) {
      throw new Error('invalid cdic header');
    }
    const phrases = u32(cdic, 8);
    const bits = u32(cdic, 12);
    const n = Math.min(1 << bits, phrases - this.dictionary.length);
    for (let i = 0; i < n; i++) {
      const off = u16(cdic, 16 + i * 2);
      const blen = u16(cdic, 16 + off);
      const slice = cdic.subarray(18 + off, 18 + off + (blen & 0x7fff));
      this.dictionary.push([slice, (blen & 0x8000) !== 0]);
    }
  }

  unpack(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const padded = new Uint8Array(data.length + 8);
    padded.set(data);
    const pdv = new DataView(padded.buffer);
    let bitsleft = data.length * 8;
    let pos = 0;
    let x = pdv.getBigUint64(pos, false);
    let n = 32;
    const chunks = [];
    while (true) {
      if (n <= 0) {
        pos += 4;
        x = pdv.getBigUint64(pos, false);
        n += 32;
      }
      const code = (x >> BigInt(n)) & 0xffffffffn;
      let d1 = this.dict1[Number(code >> 24n)];
      let codelen = d1.codelen;
      let maxcode = d1.maxcode;
      if (!d1.term) {
        while (code < this.mincode[codelen]) codelen++;
        maxcode = this.maxcode[codelen];
      }
      n -= codelen;
      bitsleft -= codelen;
      if (bitsleft < 0) break;
      const r = Number((maxcode - code) >> BigInt(32 - codelen));
      let entry = this.dictionary[r];
      if (!entry) break; // 损坏数据保护
      let slice = entry[0];
      if (!entry[1]) {
        this.dictionary[r] = [slice, true]; // 先占位防递归死循环
        const sub = this.unpack(slice);
        this.dictionary[r] = [sub, true];
        slice = sub;
      }
      chunks.push(slice);
    }
    return concatBytes(chunks);
  }
}

/** 简易图片类型嗅探 */
function sniffImageType(data) {
  if (data.length < 4) return null;
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  // WEBP: RIFF....WEBP
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * 解析 MOBI/AZW3 文件
 * @param {Uint8Array} buffer 文件字节
 * @returns {{meta: object, rawHtml: string, images: Map<number,{mediaType:string,data:Uint8Array}>, coverRecord: number|null, isK8: boolean, warnings: string[]}}
 */
export function parseMobi(buffer) {
  const warnings = [];
  if (buffer.length < 78) throw new Error('文件太小，不是有效的 MOBI 文件');

  // ---------- 1. PalmDB 头 ----------
  const palmName = readCString(buffer, 0, 32);
  const dbType = readCString(buffer, 60, 4);
  const dbCreator = readCString(buffer, 64, 4);
  const numRecords = u16(buffer, 76);
  if (numRecords < 1 || 78 + numRecords * 8 > buffer.length) {
    throw new Error('PalmDB 记录数异常，不是有效的 MOBI 文件');
  }
  if (dbType !== 'BOOK' && dbCreator !== 'MOBI' && !(dbType === 'TEXt' && dbCreator === 'REAd')) {
    throw new Error(`不是有效的 MOBI 文件 (type=${dbType}, creator=${dbCreator})`);
  }
  const recordOffsets = [];
  for (let i = 0; i < numRecords; i++) {
    recordOffsets.push(u32(buffer, 78 + i * 8));
  }
  const getRecord = (idx) => {
    if (idx < 0 || idx >= numRecords) return null;
    const start = recordOffsets[idx];
    const end = idx + 1 < numRecords ? recordOffsets[idx + 1] : buffer.length;
    if (start >= end || end > buffer.length) return null;
    return buffer.subarray(start, end);
  };

  // ---------- 2. Record0: PalmDOC + MOBI 头 ----------
  const rec0 = getRecord(0);
  if (!rec0 || rec0.length < 0x10 + 8) throw new Error('记录 0 缺失或损坏');
  const isMobi = rec0.length >= 20 && readCString(rec0, 16, 4) === 'MOBI';
  const isPalmDoc = dbType === 'TEXt' && dbCreator === 'REAd';

  const compression = u16(rec0, 0x00);
  const textLength = u32(rec0, 0x04);
  const textRecords = u16(rec0, 0x08);
  const recordSize = u16(rec0, 0x0a);
  const cryptoType = u16(rec0, 0x0c);
  if (cryptoType !== 0) {
    throw new Error('该书带有 DRM 加密，暂不支持解密阅读（可先用 Calibre 去 DRM 后导入）');
  }
  if (!isMobi && !isPalmDoc) {
    throw new Error('未找到 MOBI 头，无法解析');
  }

  const headerLength = u32(rec0, 0x14);
  const mobiType = u32(rec0, 0x18);
  const codepage = u32(rec0, 0x1c);
  const version = u32(rec0, 0x24);
  const titleOffset = u32(rec0, 0x54);
  const titleLength = u32(rec0, 0x58);
  const exthFlags = u32(rec0, 0x80);
  const hasExth = (exthFlags & 0x40) !== 0;
  let firstNonText = u32(rec0, 0x50);
  let firstResource = u32(rec0, 0x6c);

  // 尾部数据规则（traildata_flags @0xF2）
  let multibyte = 0, trailers = 0;
  if (headerLength >= 0xe4 && version >= 5) {
    const flags = u16(rec0, 0xf2);
    multibyte = flags & 1;
    let f = flags;
    while (f > 1) {
      if (f & 2) trailers++;
      f >>= 1;
    }
  }

  // ---------- 3. EXTH 元数据 ----------
  const exth = new Map();
  if (hasExth) {
    const exthOffset = headerLength + 16;
    if (rec0.length >= exthOffset + 12 && readCString(rec0, exthOffset, 4) === 'EXTH') {
      const exthLen = u32(rec0, exthOffset + 4);
      const exthCount = u32(rec0, exthOffset + 8);
      let pos = exthOffset + 12;
      const exthEnd = exthOffset + exthLen;
      for (let i = 0; i < exthCount && pos + 8 <= exthEnd && pos + 8 <= rec0.length; i++) {
        const id = u32(rec0, pos);
        const size = u32(rec0, pos + 4);
        if (size < 8 || pos + size > rec0.length) break;
        const data = rec0.subarray(pos + 8, pos + size);
        if (!exth.has(id)) exth.set(id, []);
        exth.get(id).push(data);
        pos += size;
      }
    } else {
      warnings.push('EXTH 标志置位但未找到 EXTH 数据');
    }
  }

  const exthStr = (id) => {
    const arr = exth.get(id);
    return arr && arr.length ? decodeText(arr[0], codepage).replace(/\0+$/, '') : null;
  };
  const exthInt = (id) => {
    const arr = exth.get(id);
    if (!arr || !arr.length) return null;
    const d = arr[0];
    if (d.length === 1) return d[0];
    if (d.length === 2) return u16(d, 0);
    if (d.length === 4) return u32(d, 0);
    return null;
  };

  // 标题：MOBI 头 title_offset → EXTH 503 → PalmDB 名
  let title = null;
  if (titleOffset > 0 && titleLength > 0 && titleOffset + titleLength <= rec0.length) {
    title = decodeText(rec0.subarray(titleOffset, titleOffset + titleLength), codepage).replace(/\0+$/, '');
  }
  if (!title) title = exthStr(503);
  if (!title) title = palmName;
  const author = exthStr(100) || exthStr(108) || '';
  const publisher = exthStr(101) || '';
  const description = exthStr(103) || '';
  const language = exthStr(524) || '';
  const isbn = exthStr(104) || '';
  const k8Boundary = hasExth ? exthInt(121) : null;
  const coverOffset = hasExth ? exthInt(201) : null;

  // ---------- 4. 选择 KF8 或 MOBI6 内容 ----------
  let k8HeaderRecord = -1;
  if (k8Boundary !== null && k8Boundary !== 0xffffffff && k8Boundary > 0 && k8Boundary < numRecords) {
    // EXTH 121 指向 BOUNDARY 记录，KF8 MOBI 头在它下一条
    const cand = getRecord(k8Boundary + 1);
    if (cand && cand.length >= 20 && readCString(cand, 16, 4) === 'MOBI') {
      k8HeaderRecord = k8Boundary + 1;
    } else {
      // 兜底：扫描 BOUNDARY 魔法
      for (let i = 1; i < numRecords; i++) {
        const r = getRecord(i);
        if (r && r.length >= 8 && readCString(r, 0, 8) === 'BOUNDARY') {
          const c2 = getRecord(i + 1);
          if (c2 && c2.length >= 20 && readCString(c2, 16, 4) === 'MOBI') { k8HeaderRecord = i + 1; break; }
        }
      }
    }
  }

  const makeUnpacker = (comp, hdr, hdrIdx) => {
    if (comp === 1) return (d) => d;
    if (comp === 2) return (d) => palmdocDecompress(d);
    if (comp === 0x4448) {
      const huffoff = u32(hdr, 0x70) + hdrIdx;
      const huffnum = u32(hdr, 0x74);
      const reader = new HuffcdicReader();
      const huffRec = getRecord(huffoff);
      if (!huffRec) throw new Error('HUFF 压缩种子记录缺失');
      reader.loadHuff(huffRec);
      for (let i = 1; i < huffnum; i++) {
        const cdic = getRecord(huffoff + i);
        if (cdic) reader.loadCdic(cdic);
      }
      return (d) => reader.unpack(d);
    }
    throw new Error(`不支持的压缩类型: 0x${comp.toString(16)}`);
  };

  let rawMlBytes = new Uint8Array(0);
  let imageRecords = [];   // 绝对记录号列表（图片资源候选）
  let usedCodepage = codepage;
  let isK8 = false;

  if (k8HeaderRecord > 0) {
    // ---------- 4a. KF8(AZW3) ----------
    isK8 = true;
    const k8 = getRecord(k8HeaderRecord);
    const k8TextRecords = u16(k8, 0x08);
    const k8Compression = u16(k8, 0x00);
    usedCodepage = u32(k8, 0x1c);
    const k8FirstResource = u32(k8, 0x6c);
    let k8Multibyte = 0, k8Trailers = 0;
    if (u32(k8, 0x14) >= 0xe4 && u32(k8, 0x24) >= 5) {
      const flags = u16(k8, 0xf2);
      k8Multibyte = flags & 1;
      let f = flags;
      while (f > 1) { if (f & 2) k8Trailers++; f >>= 1; }
    }
    const unpack = makeUnpacker(k8Compression, k8, k8HeaderRecord);
    const chunks = [];
    const firstText = k8HeaderRecord + 1;
    for (let i = 0; i < k8TextRecords; i++) {
      const rec = getRecord(firstText + i);
      if (!rec) { warnings.push(`KF8 文本记录 ${firstText + i} 缺失`); break; }
      const trimmed = trimTrailingDataEntries(rec, k8Trailers, k8Multibyte);
      chunks.push(unpack(trimmed));
    }
    rawMlBytes = concatBytes(chunks);
    const k8TextEnd = firstText + k8TextRecords - 1;
    const rescStart = (k8FirstResource !== 0xffffffff && k8FirstResource > k8TextEnd) ? k8FirstResource : k8TextEnd + 1;
    for (let i = rescStart; i < numRecords; i++) imageRecords.push(i);
    const k8TextLength = u32(k8, 0x04);
    if (k8TextLength > 0 && Math.abs(rawMlBytes.length - k8TextLength) > 16) {
      warnings.push(`KF8 文本长度校验差异: 期望 ${k8TextLength}, 实际 ${rawMlBytes.length}`);
    }
  } else {
    // ---------- 4b. MOBI6 / PalmDOC ----------
    const unpack = makeUnpacker(compression, rec0, 0);
    const chunks = [];
    for (let i = 1; i <= textRecords && i < numRecords; i++) {
      const rec = getRecord(i);
      if (!rec) { warnings.push(`MOBI6 文本记录 ${i} 缺失`); break; }
      const trimmed = trimTrailingDataEntries(rec, trailers, multibyte);
      chunks.push(unpack(trimmed));
    }
    rawMlBytes = concatBytes(chunks);
    // 打印复本检测（%MOP = 内嵌 PDF）
    const head = new TextDecoder('windows-1252').decode(rawMlBytes.subarray(0, 4));
    if (head === '%MOP') {
      throw new Error('打印复本格式（内嵌 PDF），暂不支持，建议直接阅读其 PDF 版本');
    }
    const fn = (firstNonText !== 0xffffffff && firstNonText > 0) ? firstNonText : (1 + textRecords);
    const fr = (firstResource !== 0xffffffff && firstResource > 0) ? firstResource : fn;
    for (let i = Math.min(fn, fr); i < numRecords; i++) imageRecords.push(i);
    if (textLength > 0 && Math.abs(rawMlBytes.length - textLength) > 16) {
      warnings.push(`MOBI6 文本长度校验差异: 期望 ${textLength}, 实际 ${rawMlBytes.length}`);
    }
  }

  // ---------- 5. 收集图片资源 ----------
  const images = new Map();
  for (const recIdx of imageRecords) {
    const rec = getRecord(recIdx);
    if (!rec || rec.length < 8) continue;
    const type = sniffImageType(rec);
    if (type) images.set(recIdx, { mediaType: type, data: rec });
  }

  // 封面：EXTH 201 指向的绝对记录号优先；否则第一张图
  let coverRecord = null;
  if (coverOffset !== null && coverOffset !== 0xffffffff && images.has(coverOffset)) {
    coverRecord = coverOffset;
  } else if (coverOffset !== null && coverOffset !== 0xffffffff && coverOffset < numRecords) {
    const rec = getRecord(coverOffset);
    const t = rec ? sniffImageType(rec) : null;
    if (t) {
      images.set(coverOffset, { mediaType: t, data: rec });
      coverRecord = coverOffset;
    }
  }
  if (coverRecord === null && images.size > 0) {
    coverRecord = imageRecords.find((i) => images.has(i)) ?? null;
  }

  const rawHtml = decodeText(rawMlBytes, usedCodepage);

  return {
    meta: { title, author, publisher, description, language, isbn, type: isK8 ? 'azw3' : 'mobi' },
    rawHtml,
    images,
    coverRecord,
    isK8,
    warnings,
  };
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export default { parseMobi, palmdocDecompress };
