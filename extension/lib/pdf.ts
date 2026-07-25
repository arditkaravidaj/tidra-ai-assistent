// A PDF writer, by hand.
//
// Tidra needs to hand the user a real .pdf — of a page it just read, of an
// email thread, of something it wrote. A PDF library would be the obvious move,
// but every one of them is hundreds of kilobytes of DOM-assuming code, and this
// runs in an MV3 service worker where there is no DOM and every byte is loaded
// on every wake-up. What a text document actually needs from PDF is small: the
// 14 built-in fonts (no embedding, no font parsing), one content stream per
// page, and a correct xref table. That is what this file is.
//
// It takes markdown-ish text — headings, bullets, tables, code, **bold** — and
// lays it out itself, because "put text on a page" in PDF means "you compute
// every coordinate". Hence the width tables: without them there is no way to
// know where a line ends.

/* ── Metrics ──────────────────────────────────────────────────────────────── */

const PAGE = { w: 595.28, h: 841.89 }; // A4, in points
const M = { top: 64, bottom: 58, left: 56, right: 56 };
const USABLE = PAGE.w - M.left - M.right;

type FontKey = 'F1' | 'F2' | 'F3' | 'F4'; // regular, bold, italic, mono

// Advance widths (1/1000 em) for the built-in Helvetica faces, ASCII 32–126.
// These come with the format — they are not measured, they are declared by the
// spec, which is why no font file has to be embedded.
// prettier-ignore
const REG_W = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];
// prettier-ignore
const BOLD_W = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,
];

function charWidth(ch: string, font: FontKey): number {
  if (font === 'F4') return 600; // Courier is monospaced
  let code = ch.codePointAt(0) ?? 32;
  if (code > 126) {
    // "é" measures as "e": NFD splits an accented letter into its base letter
    // plus a combining mark, and the accent adds no advance width.
    const base = ch.normalize('NFD').codePointAt(0) ?? 111;
    code = base <= 126 ? base : 111;
  }
  return (font === 'F2' ? BOLD_W : REG_W)[code - 32] ?? 556;
}

function textWidth(s: string, font: FontKey, size: number): number {
  let total = 0;
  for (const ch of s) total += charWidth(ch, font);
  return (total * size) / 1000;
}

/* ── Text encoding ────────────────────────────────────────────────────────── */

// The built-in fonts are used with WinAnsiEncoding: one byte per glyph, Latin-1
// for 0xA0–0xFF, plus this block of typography at 0x80–0x9F. Anything outside
// it has no glyph at all, so it is transliterated or dropped before layout —
// silently, because a missing glyph in a PDF is a black box, not an error.
const WIN_ANSI: Record<string, number> = {
  '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135, 'ˆ': 136,
  '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140, 'Ž': 142, '‘': 145, '’': 146, '“': 147,
  '”': 148, '•': 149, '–': 150, '—': 151, '˜': 152, '™': 153, 'š': 154, '›': 155,
  'œ': 156, 'ž': 158, 'Ÿ': 159,
};

const TRANSLITERATE: Record<string, string> = {
  '→': '->', '←': '<-', '⇒': '=>', '↔': '<->', '≥': '>=', '≤': '<=', '≠': '!=',
  '≈': '~', '×': 'x', '·': '-', '‐': '-', '‑': '-', '−': '-', '™': '(TM)',
  '№': 'No.', '⋅': '.', '✓': 'v', '✔': 'v', '✅': 'v', '❌': 'x', '✗': 'x',
  '□': '-', '▪': '-', '●': '-', '○': '-', '☐': '[ ]', '☑': '[x]', '\t': '    ',
};

/** Reduce text to what WinAnsi can actually draw. Runs once, before layout. */
export function toWinAnsiText(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10 || code === 13) {
      out += ch;
      continue;
    }
    if (code >= 32 && code <= 126) {
      out += ch;
      continue;
    }
    if (TRANSLITERATE[ch]) {
      out += TRANSLITERATE[ch];
      continue;
    }
    if (WIN_ANSI[ch] !== undefined) {
      out += ch;
      continue;
    }
    if (code >= 160 && code <= 255) {
      out += ch;
      continue;
    }
    // An accented character outside Latin-1 (ő, ș, ā) still has a base letter
    // worth keeping — better "Timisoara" than "Tim?oara".
    const stripped = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (stripped && stripped !== ch) {
      out += toWinAnsiText(stripped);
      continue;
    }
    // Emoji and the rest: drop, rather than litter the page with question marks.
  }
  return out;
}

/** Escape a run for a PDF literal string, with non-ASCII as octal. */
function pdfLiteral(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 32;
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
    else if (code >= 32 && code <= 126) out += ch;
    else {
      const byte = WIN_ANSI[ch] ?? (code <= 255 ? code : 63);
      out += '\\' + byte.toString(8).padStart(3, '0');
    }
  }
  return out;
}

/**
 * A string for the Info dictionary. NOT the same encoding as page text: the
 * default there is PDFDocEncoding, which disagrees with WinAnsi over the whole
 * 0x80–0x9F block — a WinAnsi em-dash in a title comes out of a viewer as "Š".
 * UTF-16BE with a byte-order mark is unambiguous, so metadata uses that.
 */
function pdfTextString(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/* ── Inline runs ──────────────────────────────────────────────────────────── */

interface Run {
  text: string;
  font: FontKey;
  size: number;
}

interface Word extends Run {
  w: number;
  /** Was this word preceded by whitespace? Decides whether a space is drawn. */
  sp: boolean;
}

const INLINE =
  /(\*\*|__)([\s\S]+?)\1|(\*|_)([^\s*_][\s\S]*?)\3|`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;

/** **bold**, *italic*, `code`, [label](url) → styled runs. */
function parseInline(text: string, size: number, base: FontKey = 'F1'): Run[] {
  const runs: Run[] = [];
  const push = (t: string, font: FontKey) => {
    if (t) runs.push({ text: t, font, size });
  };
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    push(text.slice(last, m.index), base);
    if (m[2] !== undefined) push(m[2], 'F2');
    else if (m[4] !== undefined) push(m[4], base === 'F2' ? 'F2' : 'F3');
    else if (m[5] !== undefined) push(m[5], 'F4');
    else push(m[6] || m[7], base); // link: the label, or the URL if unlabelled
    last = m.index + m[0].length;
  }
  push(text.slice(last), base);
  return runs.length ? runs : [{ text: '', font: base, size }];
}

function toWords(runs: Run[]): Word[] {
  const words: Word[] = [];
  let sp = false;
  for (const run of runs) {
    // Split on whitespace but remember where it was, so "**Note:**done" doesn't
    // silently gain a space it never had.
    const parts = run.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        sp = true;
        continue;
      }
      words.push({ text: part, font: run.font, size: run.size, w: textWidth(part, run.font, run.size), sp });
      sp = false;
    }
  }
  return words;
}

/** Break a word that cannot fit on a line of its own (a long URL, a hash). */
function hardBreak(word: Word, maxWidth: number): Word[] {
  const out: Word[] = [];
  let buf = '';
  let w = 0;
  for (const ch of word.text) {
    const cw = (charWidth(ch, word.font) * word.size) / 1000;
    if (buf && w + cw > maxWidth) {
      out.push({ ...word, text: buf, w, sp: out.length === 0 ? word.sp : false });
      buf = '';
      w = 0;
    }
    buf += ch;
    w += cw;
  }
  if (buf) out.push({ ...word, text: buf, w, sp: out.length === 0 ? word.sp : false });
  return out;
}

function wrap(runs: Run[], maxWidth: number): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  let used = 0;
  for (const raw of toWords(runs)) {
    const pieces = raw.w > maxWidth ? hardBreak(raw, maxWidth) : [raw];
    for (const word of pieces) {
      const space = (charWidth(' ', word.font) * word.size) / 1000;
      if (line.length && used + (word.sp ? space : 0) + word.w > maxWidth) {
        lines.push(line);
        line = [];
        used = 0;
      }
      line.push(word);
      used += (line.length > 1 && word.sp ? space : 0) + word.w;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

/* ── Blocks ───────────────────────────────────────────────────────────────── */

type Block =
  | { k: 'h'; level: number; runs: Run[] }
  | { k: 'p'; runs: Run[] }
  | { k: 'li'; runs: Run[]; marker: string; depth: number }
  | { k: 'quote'; runs: Run[] }
  | { k: 'code'; lines: string[] }
  | { k: 'table'; rows: string[][] }
  | { k: 'hr' };

const BODY = 10.8;
const H_SIZE = [20, 15, 12.6, 11.4, 11, 11];

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l) && l.includes('|');
const isDivider = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (!para.length) return;
    blocks.push({ k: 'p', runs: parseInline(para.join(' ').trim(), BODY) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) {
      flush();
      continue;
    }

    if (/^```/.test(t)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]), i++;
      blocks.push({ k: 'code', lines: body });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      blocks.push({ k: 'hr' });
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      const level = h[1].length;
      blocks.push({ k: 'h', level, runs: parseInline(h[2], H_SIZE[level - 1], 'F2') });
      continue;
    }

    // A table is a run of consecutive pipe rows; the |---|---| divider under the
    // header is layout, not data, so it never becomes a row.
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1]) && isTableRow(lines[i + 1])) {
      flush();
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isDivider(lines[i])) rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      blocks.push({ k: 'table', rows });
      continue;
    }

    const q = /^>\s?(.*)$/.exec(t);
    if (q) {
      flush();
      blocks.push({ k: 'quote', runs: parseInline(q[1], BODY, 'F3') });
      continue;
    }

    const li = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const depth = Math.min(2, Math.floor(li[1].replace(/\t/g, '  ').length / 2));
      const marker = /\d/.test(li[2]) ? li[2] : '•';
      blocks.push({ k: 'li', runs: parseInline(li[3], BODY), marker, depth });
      continue;
    }

    para.push(t);
  }
  flush();
  return blocks;
}

/* ── Page painting ────────────────────────────────────────────────────────── */

class Painter {
  pages: string[][] = [];
  private cur: string[] = [];
  y = PAGE.h - M.top;

  constructor() {
    this.pages.push(this.cur);
  }

  private op(s: string) {
    this.cur.push(s);
  }

  break_() {
    this.cur = [];
    this.pages.push(this.cur);
    this.y = PAGE.h - M.top;
  }

  /** Start a new page if `h` points of content would run off this one. */
  need(h: number) {
    if (this.y - h < M.bottom) this.break_();
  }

  gray(v: number) {
    this.op(`${v} ${v} ${v} rg`);
  }

  rule(x1: number, x2: number, y: number, v = 0.78, thickness = 0.6) {
    this.op(`q ${v} ${v} ${v} RG ${thickness} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S Q`);
  }

  fill(x: number, y: number, w: number, h: number, v: number) {
    this.op(`q ${v} ${v} ${v} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q`);
  }

  /** Draw one laid-out line at (x, baseline). Words merge into as few Tj as possible. */
  line(words: Word[], x: number, baseline: number, shade = 0.13) {
    if (!words.length) return;
    this.op('BT');
    this.gray(shade);
    let cursor = x;
    let group: Word | null = null;
    let groupX = x;
    const flush = () => {
      if (!group) return;
      this.op(`/${group.font} ${group.size} Tf`);
      this.op(`1 0 0 1 ${groupX.toFixed(2)} ${baseline.toFixed(2)} Tm`);
      this.op(`(${pdfLiteral(group.text)}) Tj`);
      group = null;
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const gap = i && w.sp ? (charWidth(' ', w.font) * w.size) / 1000 : 0;
      if (group && gap && group.font === w.font && group.size === w.size) {
        group.text += ' ' + w.text;
        cursor += gap + w.w;
        continue;
      }
      flush();
      cursor += gap;
      groupX = cursor;
      group = { ...w };
      cursor += w.w;
    }
    flush();
    this.op('ET');
  }

  stream(i: number): string {
    return this.pages[i].join('\n');
  }
}

function lineHeight(size: number): number {
  return size * 1.42;
}

/** Lay every block onto pages. */
function paint(blocks: Block[], p: Painter) {
  let prev: Block['k'] | null = null;

  for (const b of blocks) {
    if (b.k === 'hr') {
      p.need(18);
      p.y -= 9;
      p.rule(M.left, PAGE.w - M.right, p.y);
      p.y -= 9;
      prev = b.k;
      continue;
    }

    if (b.k === 'h') {
      const size = H_SIZE[b.level - 1];
      const lh = lineHeight(size);
      const before = prev === null ? 0 : b.level === 1 ? 20 : b.level === 2 ? 17 : 12;
      const lines = wrap(b.runs, USABLE);
      p.need(before + lh * lines.length + 10);
      p.y -= before;
      for (const l of lines) {
        p.y -= lh;
        p.line(l, M.left, p.y, 0.07);
      }
      if (b.level <= 2) {
        p.y -= 6;
        p.rule(M.left, PAGE.w - M.right, p.y, b.level === 1 ? 0.65 : 0.85);
      }
      p.y -= 6;
      prev = b.k;
      continue;
    }

    if (b.k === 'code') {
      const size = 9.2;
      const lh = size * 1.35;
      const pad = 7;
      const body = b.lines.length ? b.lines : [''];
      p.need(Math.min(body.length, 6) * lh + pad * 2 + 10);
      p.y -= 8;
      // The tint is drawn per page-chunk, so a block that spans a page break
      // still sits on its own background on both pages.
      let chunkTop = p.y;
      let drawn: { words: Word[]; indent: number }[] = [];
      const paintChunk = () => {
        if (!drawn.length) return;
        const h = drawn.length * lh + pad * 2;
        p.fill(M.left, chunkTop - h, USABLE, h, 0.955);
        let base = chunkTop - pad;
        for (const l of drawn) {
          base -= lh;
          p.line(l.words, M.left + pad + l.indent, base + 2, 0.2);
        }
        p.y = chunkTop - h;
        drawn = [];
      };
      for (const raw of body) {
        // Wrapping tokenises on whitespace, which would flatten a code block's
        // indentation — so the leading run is measured and re-applied as an x
        // offset instead of being fed through the wrapper.
        const lead = /^[ \t]*/.exec(raw)![0].replace(/\t/g, '  ');
        const indent = textWidth(lead, 'F4', size);
        const lines = wrap([{ text: raw.slice(lead.length) || ' ', font: 'F4', size }], USABLE - pad * 2 - indent);
        for (const l of lines) {
          if (chunkTop - (drawn.length + 1) * lh - pad * 2 < M.bottom) {
            paintChunk();
            p.break_();
            chunkTop = p.y;
          }
          drawn.push({ words: l, indent });
        }
      }
      paintChunk();
      p.y -= 8;
      prev = b.k;
      continue;
    }

    if (b.k === 'table') {
      paintTable(b.rows, p);
      prev = b.k;
      continue;
    }

    if (b.k === 'li') {
      const indent = 14 + b.depth * 16;
      const lh = lineHeight(BODY);
      const lines = wrap(b.runs, USABLE - indent);
      p.need(lh + 2);
      let first = true;
      for (const l of lines) {
        p.need(lh);
        p.y -= lh;
        if (first) {
          p.line([{ text: b.marker, font: 'F1', size: BODY, w: 0, sp: false }], M.left + b.depth * 16, p.y, 0.35);
          first = false;
        }
        p.line(l, M.left + indent, p.y);
      }
      p.y -= 3;
      prev = b.k;
      continue;
    }

    if (b.k === 'quote') {
      const lh = lineHeight(BODY);
      const lines = wrap(b.runs, USABLE - 20);
      p.need(lh + 8);
      p.y -= 6;
      const top = p.y;
      for (const l of lines) {
        p.need(lh);
        p.y -= lh;
        p.line(l, M.left + 16, p.y, 0.32);
      }
      p.fill(M.left + 2, p.y - 2, 2.2, top - p.y + 2, 0.78);
      p.y -= 6;
      prev = b.k;
      continue;
    }

    // Paragraph.
    const lh = lineHeight(BODY);
    const lines = wrap(b.runs, USABLE);
    p.y -= prev === null ? 0 : 5;
    for (const l of lines) {
      p.need(lh);
      p.y -= lh;
      p.line(l, M.left, p.y);
    }
    p.y -= 3;
    prev = b.k;
  }
}

function paintTable(rows: string[][], p: Painter) {
  if (!rows.length) return;
  const cols = Math.max(...rows.map((r) => r.length));
  const colW = USABLE / cols;
  const pad = 5;
  const size = 9.8;
  const lh = size * 1.35;

  p.y -= 8;
  rows.forEach((row, ri) => {
    const cells = Array.from({ length: cols }, (_, ci) =>
      wrap(parseInline(row[ci] ?? '', size, ri === 0 ? 'F2' : 'F1'), colW - pad * 2),
    );
    const height = Math.max(...cells.map((c) => c.length)) * lh + pad;
    p.need(height + 4);
    if (ri === 0) p.fill(M.left, p.y - height, USABLE, height, 0.95);
    const top = p.y;
    cells.forEach((lines, ci) => {
      let base = top - pad;
      for (const l of lines) {
        base -= lh - 2;
        p.line(l, M.left + ci * colW + pad, base, ri === 0 ? 0.1 : 0.18);
        base -= 2;
      }
    });
    p.y = top - height;
    p.rule(M.left, PAGE.w - M.right, p.y, ri === 0 ? 0.6 : 0.88, ri === 0 ? 0.7 : 0.4);
  });
  p.y -= 8;
}

/* ── Serialisation ────────────────────────────────────────────────────────── */

function pdfDate(d: Date): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

const FONT_OBJ: Record<FontKey, string> = {
  F1: 'Helvetica',
  F2: 'Helvetica-Bold',
  F3: 'Helvetica-Oblique',
  F4: 'Courier',
};

function serialize(streams: string[], title: string, author: string): Uint8Array {
  const objects: string[] = []; // objects[i] is object number i+1
  const pageCount = streams.length;
  const firstPage = 8; // 1 catalog, 2 pages, 3–6 fonts, 7 info

  const pageIds = streams.map((_, i) => firstPage + i * 2);
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
  );
  (['F1', 'F2', 'F3', 'F4'] as FontKey[]).forEach((k) => {
    objects.push(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_OBJ[k]} /Encoding /WinAnsiEncoding >>`,
    );
  });
  objects.push(
    `<< /Title ${pdfTextString(title)} /Author ${pdfTextString(author)} /Producer (Tidra) /Creator (Tidra) /CreationDate (${pdfDate(new Date())}) >>`,
  );

  streams.forEach((stream, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w.toFixed(2)} ${PAGE.h.toFixed(2)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> ` +
        `/Contents ${pageIds[i] + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  // Everything below is byte-counted, so the file is assembled as a latin-1
  // string first: every character written from here is one byte.
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = out.length;
  const size = objects.length + 1;
  out += `xref\n0 ${size}\n0000000000 65535 f\r\n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n\r\n`;
  out += `trailer\n<< /Size ${size} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/* ── The one entry point ──────────────────────────────────────────────────── */

export interface PdfInput {
  /** Rendered big at the top of page one, and set as the document title. */
  title?: string;
  /** A line under the title — a source URL, a date, a byline. */
  subtitle?: string;
  /** Markdown-ish body: #/##/### headings, -/1. lists, tables, ```code```, **bold**. */
  content: string;
  author?: string;
}

export function buildPdf({ title, subtitle, content, author = 'Tidra' }: PdfInput): Uint8Array {
  const p = new Painter();

  const heading = toWinAnsiText((title ?? '').trim());
  if (heading) {
    const lines = wrap(parseInline(heading, 22, 'F2'), USABLE);
    for (const l of lines) {
      p.y -= lineHeight(22);
      p.line(l, M.left, p.y, 0.05);
    }
    const sub = toWinAnsiText((subtitle ?? '').trim());
    if (sub) {
      for (const l of wrap([{ text: sub, font: 'F1', size: 9.6 }], USABLE)) {
        p.y -= lineHeight(9.6);
        p.line(l, M.left, p.y, 0.45);
      }
    }
    p.y -= 8;
    p.rule(M.left, PAGE.w - M.right, p.y, 0.6);
    p.y -= 14;
  }

  paint(parseBlocks(toWinAnsiText(content)), p);

  // Footers last: the page count isn't known until everything is laid out.
  const total = p.pages.length;
  p.pages.forEach((ops, i) => {
    const label = `${i + 1} / ${total}`;
    const w = textWidth(label, 'F1', 8.4);
    ops.push(
      'BT',
      '0.55 0.55 0.55 rg',
      '/F1 8.4 Tf',
      `1 0 0 1 ${(PAGE.w - M.right - w).toFixed(2)} ${(M.bottom - 26).toFixed(2)} Tm`,
      `(${pdfLiteral(label)}) Tj`,
      'ET',
    );
  });

  // Metadata is UTF-16, so it keeps characters the page itself cannot draw.
  return serialize(
    p.pages.map((_, i) => p.stream(i)),
    (title || 'Document').slice(0, 200),
    author.slice(0, 120),
  );
}

/** Bytes → base64, in chunks so a big document can't blow the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Make a model-supplied name safe for the downloads API. An empty `ext` leaves
 * the name bare on purpose — the browser then picks the extension from the
 * file's real content type, which beats guessing .jpg at a PNG.
 */
export function safeFilename(name: string | undefined, fallback: string, ext: string): string {
  let base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    .trim()
    .replace(/[\x00-\x1f<>:"|?*]+/g, '')
    .replace(/\.+$/, '')
    .slice(0, 80)
    .trim();
  if (ext && base.toLowerCase().endsWith(`.${ext}`)) base = base.slice(0, -(ext.length + 1)).trim();
  if (!base) base = fallback;
  return ext ? `${base}.${ext}` : base;
}
