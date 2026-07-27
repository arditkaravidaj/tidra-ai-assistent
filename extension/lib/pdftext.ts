// Reading the text out of a PDF.
//
// lib/pdf.ts writes PDFs. This reads them, which is the harder direction: a PDF
// does not contain text, it contains instructions for painting glyphs, and
// "what does it say" has to be reconstructed from those.
//
// Three things make that awkward, and all three show up in real documents:
//
// 1. The bytes in a content stream are FONT CODES, not characters. Code 228 is
//    "ä" only if the font says so. The friendly case is an embedded /ToUnicode
//    map; plenty of PDFs — including every German statement this was built
//    against — have none, and the answer lives in the font's /Encoding instead.
//    So encodings are not a fallback here, they are the main path.
//
// 2. Content streams are usually Flate-compressed, and in PDF 1.5+ the objects
//    themselves are packed into compressed object streams too.
//
// 3. There are no line breaks. Position operators are all that separate a line
//    from the next, so the layout has to be inferred.
//
// A scanned PDF contains no text at all — just an image of one. That is not a
// failure to parse and must never be reported as empty: see `note`.

/* ── Shapes ───────────────────────────────────────────────────────────────── */

export interface PdfText {
  text: string;
  pages: number;
  /**
   * Set when the text is missing or partial for a reason the USER needs to
   * hear — a scan with no text layer, an encrypted file. Silence here would
   * turn "this is a photo of a document" into "this document is blank".
   */
  note?: string;
}

interface PdfObj {
  num: number;
  /** The object's dictionary/body, as latin1 — 1 char per byte, so offsets align. */
  body: string;
  /** Raw (still encoded) stream bytes, if it has a stream. */
  raw?: Uint8Array;
}

/* ── Bytes ────────────────────────────────────────────────────────────────── */

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

/**
 * PDF's /FlateDecode is zlib-wrapped, so 'deflate' is right — but enough
 * producers emit raw deflate that the retry is worth having rather than losing
 * the page. Returns null when the data is neither.
 */
async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  for (const format of ['deflate', 'deflate-raw'] as const) {
    const chunks: Uint8Array[] = [];
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      void writer.write(bytes as unknown as BufferSource).catch(() => {});
      void writer.close().catch(() => {});
      const reader = ds.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } catch {
      // Deliberately kept: real PDFs pad the stream, so a complete deflate block
      // is routinely followed by bytes that make the decompressor throw
      // AFTER it has already emitted every byte of the actual content. Reading
      // chunk by chunk means the error costs the padding, not the page —
      // `await new Response(stream).arrayBuffer()` throws it all away instead.
    }
    if (chunks.length) {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    }
  }
  return null;
}

/**
 * Undo a PDF predictor. Flate streams that carry tabular data (xref and object
 * streams, mostly) are filtered per-row before compression; without this their
 * bytes come out shuffled.
 */
function unpredict(data: Uint8Array, predictor: number, colors: number, bpc: number, columns: number): Uint8Array {
  if (predictor < 10) return data;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const tag = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = new Uint8Array(row);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (tag === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (tag === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (tag === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (tag === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    out.set(cur, r * rowLen);
    prev = cur;
  }
  return out;
}

/* ── Encodings ────────────────────────────────────────────────────────────── */

// WinAnsi differs from Latin-1 only in 128–159; everything from 160 up is the
// same codepoint. That is the whole reason German text survives without a
// /ToUnicode map — ä ö ü ß all sit in the identical range.
const WIN_ANSI_HIGH: Record<number, string> = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ',
  137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“',
  148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›',
  156: 'œ', 158: 'ž', 159: 'Ÿ',
};

const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/** Glyph names that actually turn up in /Differences on Western documents. */
const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1',
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', quoteright: '’', quoteleft: '‘',
  quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—', bullet: '•',
  ellipsis: '…', euro: '€', sterling: '£', yen: '¥', cent: '¢', section: '§',
  paragraph: '¶', degree: '°', plusminus: '±', copyright: '©', registered: '®',
  germandbls: 'ß', adieresis: 'ä', odieresis: 'ö', udieresis: 'ü',
  Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü', aacute: 'á', agrave: 'à',
  acircumflex: 'â', eacute: 'é', egrave: 'è', ecircumflex: 'ê', ccedilla: 'ç',
  ntilde: 'ñ', oslash: 'ø', aring: 'å', ae: 'æ', oe: 'œ', scaron: 'š',
};

function glyphToChar(name: string): string {
  if (GLYPHS[name]) return GLYPHS[name];
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1], 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(parseInt(u[1], 16));
  // "g23" / "cid42" name the glyph slot, not the character — nothing to recover.
  return '';
}

/** code → text. Missing entries fall back to the base encoding at decode time. */
type Encoding = { map: Record<number, string>; base: 'win' | 'mac' | 'std'; wide?: boolean };

function decodeWith(enc: Encoding, code: number): string {
  const mapped = enc.map[code];
  if (mapped !== undefined) return mapped;
  if (code >= 32 && code <= 126) return String.fromCharCode(code);
  if (enc.base === 'mac') return code >= 128 && code <= 255 ? (MAC_ROMAN_HIGH[code - 128] ?? '') : '';
  if (code >= 160 && code <= 255) return String.fromCharCode(code); // Latin-1 == WinAnsi here
  return WIN_ANSI_HIGH[code] ?? '';
}

/* ── Parsing ──────────────────────────────────────────────────────────────── */

/**
 * Every `N G obj … endobj` in the file, found by scanning rather than by
 * following the cross-reference table. Slower, but it survives the damaged and
 * incrementally-updated xrefs that real-world PDFs are full of — and a document
 * that opens fine in a viewer must not come back empty here.
 */
const dictNum = (dict: string, key: string): number | null => {
  const m = new RegExp(`/${key}\\s+(\\d+)`).exec(dict);
  return m ? Number(m[1]) : null;
};

function scanObjects(src: string, bytes: Uint8Array): Map<number, PdfObj> {
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    const stop = end === -1 ? src.length : end;
    const body = src.slice(start, stop);
    const obj: PdfObj = { num, body };
    const sIdx = body.indexOf('stream');
    if (sIdx !== -1) {
      let dataStart = start + sIdx + 'stream'.length;
      if (src[dataStart] === '\r') dataStart++;
      if (src[dataStart] === '\n') dataStart++;
      const eIdx = src.indexOf('endstream', dataStart);
      let dataEnd = eIdx === -1 ? stop : eIdx;
      // /Length is the real end. Between it and `endstream` sits an EOL that is
      // NOT part of the stream, and DecompressionStream rejects the whole thing
      // as trailing junk over those two bytes — every page comes back empty.
      const dict = body.slice(0, sIdx);
      const len = dictNum(dict, 'Length');
      if (len !== null && dataStart + len <= dataEnd) dataEnd = dataStart + len;
      else while (dataEnd > dataStart && /[\r\n \t]/.test(src[dataEnd - 1])) dataEnd--;
      obj.body = dict;
      obj.raw = bytes.subarray(dataStart, dataEnd);
    }
    // Later definitions win: that is what an incremental update means.
    objs.set(num, obj);
  }
  return objs;
}

/** ASCII85 — how a stream survives being pasted through a text-only channel. */
function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // "~>" ends it
    if (c <= 32 || c === 10 || c === 13) continue; // whitespace is not data
    if (c === 0x7a && count === 0) {
      out.push(0, 0, 0, 0); // 'z' is shorthand for four zero bytes
      continue;
    }
    if (c < 33 || c > 117) continue;
    tuple = tuple * 85 + (c - 33);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    // A partial group encodes count-1 bytes; pad with the maximum digit.
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return new Uint8Array(out);
}

function asciiHex(data: Uint8Array): Uint8Array {
  const hex = latin1(data).replace(/>[\s\S]*$/, '').replace(/[^0-9A-Fa-f]/g, '');
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2).padEnd(2, '0'), 16);
  return out;
}

/** The image codecs. Their bytes are a picture, so there is no text to find. */
const IMAGE_FILTERS = /^(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)$/;

/**
 * Decoded stream bytes, with the filters applied IN ORDER.
 *
 * /Filter is a chain as often as it is a single name — `[/ASCII85Decode
 * /FlateDecode]` means armour first, then compress, so decoding must unwind it
 * in the same sequence. Treating it as "does it mention Flate" silently drops
 * every stream that was armoured on the way in.
 */
async function streamOf(obj: PdfObj): Promise<Uint8Array | null> {
  if (!obj.raw) return null;
  const spec = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(obj.body);
  const filters = spec ? (spec[1].match(/\/([A-Za-z0-9]+)/g) ?? []).map((f) => f.slice(1)) : [];
  if (filters.some((f) => IMAGE_FILTERS.test(f))) return null;

  let data: Uint8Array = obj.raw;
  for (const filter of filters) {
    if (filter === 'ASCII85Decode') data = ascii85(data);
    else if (filter === 'ASCIIHexDecode') data = asciiHex(data);
    else if (filter === 'FlateDecode') {
      const out = await inflate(data);
      if (!out) return null;
      data = out;
      const pred = dictNum(obj.body, 'Predictor');
      if (pred && pred >= 10) {
        data = unpredict(
          data,
          pred,
          dictNum(obj.body, 'Colors') ?? 1,
          dictNum(obj.body, 'BitsPerComponent') ?? 8,
          dictNum(obj.body, 'Columns') ?? 1,
        );
      }
    } else if (filter === 'Crypt') {
      continue; // identity in practice for unencrypted files
    } else {
      return null; // LZWDecode and friends — not decoded here
    }
  }
  return data;
}

/**
 * PDF 1.5+ hides most objects inside compressed object streams. Without
 * unpacking these, a modern file looks like it has almost no objects at all.
 */
async function expandObjectStreams(objs: Map<number, PdfObj>): Promise<void> {
  for (const obj of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.body)) continue;
    const data = await streamOf(obj);
    if (!data) continue;
    const n = dictNum(obj.body, 'N') ?? 0;
    const first = dictNum(obj.body, 'First') ?? 0;
    const src = latin1(data);
    const header = src.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      const nextOff = i + 1 < n ? header[i * 2 + 3] : src.length - first;
      // Objects inside a stream never override a top-level definition.
      if (!objs.has(num)) objs.set(num, { num, body: src.slice(first + off, first + nextOff) });
    }
  }
}

/* ── Fonts ────────────────────────────────────────────────────────────────── */

function parseToUnicode(src: string): Record<number, string> {
  const map: Record<number, string> = {};
  const hexToStr = (h: string) => {
    let s = '';
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16));
    return s.replace(/\0/g, '');
  };
  for (const block of src.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) map[parseInt(m[1], 16)] = hexToStr(m[2]);
  }
  for (const block of src.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3]) {
        const base = parseInt(m[3], 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map[c] = String.fromCharCode(base + (c - lo));
      } else if (m[4]) {
        const items = m[4].match(/<([0-9A-Fa-f]+)>/g) ?? [];
        items.forEach((it, i) => (map[lo + i] = hexToStr(it.slice(1, -1))));
      }
    }
  }
  return map;
}

async function buildEncoding(fontObj: PdfObj, objs: Map<number, PdfObj>): Promise<Encoding> {
  const enc: Encoding = { map: {}, base: 'win' };

  // Two-byte codes. Detected here so the tokenizer reads the string correctly.
  if (/\/Subtype\s*\/Type0/.test(fontObj.body) || /\/Encoding\s*\/Identity-[HV]/.test(fontObj.body)) {
    enc.wide = true;
  }

  const encRef = /\/Encoding\s+(\d+)\s+\d+\s+R/.exec(fontObj.body);
  const encDict = encRef ? (objs.get(Number(encRef[1]))?.body ?? '') : fontObj.body;
  if (/\/MacRomanEncoding/.test(encDict)) enc.base = 'mac';
  else if (/\/WinAnsiEncoding/.test(encDict)) enc.base = 'win';

  // /Differences remaps individual codes by glyph name.
  const diff = /\/Differences\s*\[([\s\S]*?)\]/.exec(encDict);
  if (diff) {
    let code = 0;
    for (const tok of diff[1].match(/\/[^\s/\][]+|\d+/g) ?? []) {
      if (tok.startsWith('/')) {
        const ch = glyphToChar(tok.slice(1));
        if (ch) enc.map[code] = ch;
        code++;
      } else code = Number(tok);
    }
  }

  // /ToUnicode wins over everything above when it exists.
  const tuRef = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObj.body);
  if (tuRef) {
    const tu = objs.get(Number(tuRef[1]));
    if (tu) {
      const data = await streamOf(tu);
      if (data) Object.assign(enc.map, parseToUnicode(latin1(data)));
    }
  }
  return enc;
}

/* ── Content streams ──────────────────────────────────────────────────────── */

/** Read a PDF literal string starting at `i` (the opening paren). */
function readLiteral(src: string, i: number): { codes: number[]; next: number } {
  const codes: number[] = [];
  let depth = 1;
  let j = i + 1;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      const octal = /^[0-7]{1,3}/.exec(src.slice(j + 1, j + 4));
      if (octal) {
        codes.push(parseInt(octal[0], 8) & 0xff);
        j += 1 + octal[0].length;
        continue;
      }
      const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      if (n in esc) codes.push(esc[n]);
      else if (n === '\n') {
        /* line continuation — nothing emitted */
      } else codes.push(n.charCodeAt(0));
      j += 2;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
    codes.push(c.charCodeAt(0) & 0xff);
    j++;
  }
  return { codes, next: j + 1 };
}

function codesToText(codes: number[], enc: Encoding): string {
  if (!enc.wide) return codes.map((c) => decodeWith(enc, c)).join('');
  let out = '';
  for (let i = 0; i + 1 < codes.length; i += 2) {
    const code = (codes[i] << 8) | codes[i + 1];
    out += enc.map[code] ?? '';
  }
  return out;
}

/**
 * Walk one page's content stream and pull the shown text out of it.
 *
 * Line breaks are the guesswork. A PDF only ever says "move the cursor", so a
 * vertical move becomes a newline and a large negative kern inside a TJ array
 * becomes a space — which is how justified text avoids comingoutlikethis.
 */
function extractContent(src: string, fonts: Record<string, Encoding>): string {
  let out = '';
  let enc: Encoding = { map: {}, base: 'win' };
  const stack: (string | number | number[])[] = [];
  let i = 0;

  const show = (codes: number[]) => (out += codesToText(codes, enc));

  while (i < src.length) {
    const c = src[i];
    if (c === '(') {
      const { codes, next } = readLiteral(src, i);
      stack.push(codes);
      i = next;
      continue;
    }
    if (c === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i);
      if (end === -1) break;
      const hex = src.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
      const codes: number[] = [];
      for (let k = 0; k + 1 < hex.length + 1; k += 2) codes.push(parseInt(hex.substr(k, 2).padEnd(2, '0'), 16));
      stack.push(codes);
      i = end + 1;
      continue;
    }
    if (c === '/') {
      const m = /^\/([^\s/\][()<>]*)/.exec(src.slice(i));
      stack.push(m ? m[1] : '');
      i += m ? m[0].length : 1;
      continue;
    }
    const num = /^[-+]?[\d.]+/.exec(src.slice(i));
    if (num && /[\d.+-]/.test(c)) {
      stack.push(Number(num[0]));
      i += num[0].length;
      continue;
    }
    const op = /^[A-Za-z'"*]+/.exec(src.slice(i));
    if (!op) {
      i++;
      continue;
    }
    const name = op[0];
    i += name.length;

    switch (name) {
      case 'Tf': {
        const font = stack[stack.length - 2];
        if (typeof font === 'string' && fonts[font]) enc = fonts[font];
        break;
      }
      case 'Tj':
      case 'TJ': {
        // TJ's array elements were pushed individually; take everything since
        // the last operator and treat big negative numbers as word gaps.
        for (const item of stack) {
          if (Array.isArray(item)) show(item);
          else if (typeof item === 'number' && item < -120) out += ' ';
        }
        break;
      }
      case "'":
      case '"': {
        out += '\n';
        for (const item of stack) if (Array.isArray(item)) show(item);
        break;
      }
      case 'Td':
      case 'TD': {
        const ty = stack[stack.length - 1];
        if (typeof ty === 'number' && ty !== 0) out += '\n';
        break;
      }
      case 'T*':
      case 'TL':
        out += '\n';
        break;
      case 'Tm':
      case 'BT':
      case 'ET':
        out += '\n';
        break;
    }
    stack.length = 0;
  }
  return out;
}

/* ── The one exported function ────────────────────────────────────────────── */

export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  const src = latin1(bytes);
  if (/\/Encrypt\b/.test(src)) {
    return { text: '', pages: 0, note: 'This PDF is password-protected, so its text cannot be read.' };
  }

  const objs = scanObjects(src, bytes);
  await expandObjectStreams(objs);

  const pages = [...objs.values()].filter((o) => /\/Type\s*\/Page[^s]/.test(o.body));
  if (!pages.length) {
    return { text: '', pages: 0, note: "This file doesn't look like a readable PDF." };
  }

  const deref = (dict: string, key: string): PdfObj | null => {
    const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
    return m ? (objs.get(Number(m[1])) ?? null) : null;
  };

  const parts: string[] = [];
  let sawImage = false;

  for (const page of pages) {
    // Fonts for this page, by the name the content stream will use (/F1 …).
    const fonts: Record<string, Encoding> = {};
    const resDict = deref(page.body, 'Resources')?.body ?? page.body;
    const fontBlock = /\/Font\s*<<([\s\S]*?)>>/.exec(resDict);
    const fontDict = fontBlock ? fontBlock[1] : (deref(resDict, 'Font')?.body ?? '');
    const fre = /\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g;
    let fm: RegExpExecArray | null;
    while ((fm = fre.exec(fontDict))) {
      const fo = objs.get(Number(fm[2]));
      if (fo) fonts[fm[1]] = await buildEncoding(fo, objs);
    }

    // /Contents is one stream or an array of them.
    const refs: number[] = [];
    const one = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(page.body);
    if (one) refs.push(Number(one[1]));
    const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(page.body);
    if (arr) for (const r of arr[1].match(/(\d+)\s+\d+\s+R/g) ?? []) refs.push(Number(/\d+/.exec(r)![0]));

    let pageText = '';
    for (const ref of refs) {
      const obj = objs.get(ref);
      if (!obj) continue;
      const data = await streamOf(obj);
      if (!data) continue;
      pageText += extractContent(latin1(data), fonts);
    }
    if (/\/Subtype\s*\/Image/.test(resDict) || /\/XObject/.test(resDict)) sawImage = true;
    parts.push(pageText);
  }

  const text = parts
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) {
    return {
      text: '',
      pages: pages.length,
      note: sawImage
        ? 'This PDF has no text in it — it is a scan or photo of a document, so the words are pixels, not characters. Reading it would need OCR, which Tidra cannot do yet.'
        : 'No text could be read out of this PDF.',
    };
  }
  return { text, pages: pages.length };
}
