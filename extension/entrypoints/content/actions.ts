// Browser-action executor — runs inside the page (content script context), in
// every frame. The background agent sends `tidra-action` messages; we do the
// DOM work and reply. Kept outside React so it works regardless of island state.
//
// The model never matches text against the page. `snapshot` walks the DOM (into
// open shadow roots and same-origin iframes), assigns every interactive element
// a stable `ref_N`, and returns an indented accessibility-style tree. The model
// then acts on refs — click(ref_12) — so ambiguity is resolved once, here, by
// code, instead of on every call by a substring match.

/* ── Element registry ─────────────────────────────────────────────────────── */

let refSeq = 0;
const registry = new Map<string, Element>();

function put(el: Element): string {
  const ref = `ref_${++refSeq}`;
  registry.set(ref, el);
  return ref;
}

function get(ref: string): HTMLElement | null {
  const el = registry.get(String(ref).trim());
  // A ref survives only while its element is still in the document.
  if (!el || !el.isConnected) return null;
  return el as HTMLElement;
}

/* ── Visibility ───────────────────────────────────────────────────────────── */

// Prune: this element and everything under it is invisible to a user.
function pruned(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return true;
  const s = getComputedStyle(el as HTMLElement);
  return s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse';
}

// Emit: this element actually occupies space and can be interacted with.
function renderable(el: Element): boolean {
  const anyEl = el as HTMLElement & { checkVisibility?: (o?: object) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  return Number(getComputedStyle(anyEl).opacity) > 0.05;
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

/* ── Accessible name ──────────────────────────────────────────────────────── */

function textOf(el: Element | null): string {
  if (!el) return '';
  return ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

// The real algorithm's order, near enough: labelledby → aria-label → <label> →
// placeholder → title → alt → value → SVG <title> → visible text.
function accName(el: Element): string {
  const lb = el.getAttribute('aria-labelledby');
  if (lb) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const named = lb
      .split(/\s+/)
      .map((id) => textOf(root.querySelector(`#${CSS.escape(id)}`)))
      .filter(Boolean)
      .join(' ');
    if (named) return named;
  }

  const al = el.getAttribute('aria-label');
  if (al?.trim()) return al.trim();

  const id = (el as HTMLElement).id;
  if (id) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const lab = root.querySelector(`label[for="${CSS.escape(id)}"]`);
    const t = textOf(lab);
    if (t) return t;
  }
  const wrapping = el.closest('label');
  if (wrapping && wrapping !== el) {
    const t = textOf(wrapping);
    if (t) return t;
  }

  for (const attr of ['placeholder', 'title', 'alt']) {
    const v = el.getAttribute(attr);
    if (v?.trim()) return v.trim();
  }

  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    if ((input.type === 'submit' || input.type === 'button') && input.value) return input.value;
  }

  // Icon-only buttons: the only name they have is inside the SVG.
  const svgTitle = el.querySelector('svg > title, svg > desc');
  if (svgTitle?.textContent?.trim()) return svgTitle.textContent.trim();

  const alt = el.querySelector('img[alt]')?.getAttribute('alt');
  if (alt?.trim()) return alt.trim();

  // A <select>'s own text is its option list, which is a misleading name.
  if (el.tagName !== 'SELECT') {
    const own = textOf(el);
    if (own) return own.length > 80 ? own.slice(0, 80) + '…' : own;
  }

  // Last resort — something to aim at rather than an anonymous box.
  return el.getAttribute('name') || el.getAttribute('data-testid') || '';
}

/* ── Roles ────────────────────────────────────────────────────────────────── */

const TAG_ROLE: Record<string, string> = {
  A: 'link',
  BUTTON: 'button',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  SUMMARY: 'summary',
};

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(/\s+/)[0];
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    if (t === 'checkbox' || t === 'radio') return t;
    if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
    return 'textbox';
  }
  if ((el as HTMLElement).isContentEditable) return 'textbox';
  return TAG_ROLE[el.tagName] ?? 'button';
}

const INTERACTIVE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="treeitem"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

function stateOf(el: Element): string {
  const bits: string[] = [];
  const anyEl = el as HTMLInputElement;
  if (anyEl.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
  const checked = el.getAttribute('aria-checked') ?? (anyEl.checked ? 'true' : null);
  if (checked === 'true') bits.push('checked');
  const expanded = el.getAttribute('aria-expanded');
  if (expanded) bits.push(expanded === 'true' ? 'expanded' : 'collapsed');
  if (el.getAttribute('aria-selected') === 'true') bits.push('selected');
  if (el.tagName === 'SELECT') {
    const sel = el as unknown as HTMLSelectElement;
    const opts = Array.from(sel.options).map((o) => o.text).slice(0, 12);
    bits.push(`selected:"${sel.selectedOptions[0]?.text ?? ''}" options:[${opts.join(' | ')}]`);
  } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const v = String(anyEl.value ?? '');
    if (v) bits.push(`value:"${v.length > 40 ? v.slice(0, 40) + '…' : v}"`);
  } else if ((el as HTMLElement).isContentEditable) {
    const v = textOf(el);
    if (v) bits.push(`text:"${v.length > 40 ? v.slice(0, 40) + '…' : v}"`);
  }
  if (!inViewport(el)) bits.push('offscreen');
  return bits.length ? ' ' + bits.join(' ') : '';
}

/* ── Snapshot ─────────────────────────────────────────────────────────────── */

const MAX_NODES = 400;

interface SnapCtx {
  lines: string[];
  truncated: boolean;
}

function walk(node: ParentNode, depth: number, ctx: SnapCtx) {
  for (const el of Array.from(node.children)) {
    if (ctx.lines.length >= MAX_NODES) {
      ctx.truncated = true;
      return;
    }
    if (pruned(el)) continue;

    let nextDepth = depth;
    const isInteractive = el.matches(INTERACTIVE);
    const isHeading = el.matches(HEADINGS);

    if ((isInteractive || isHeading) && renderable(el)) {
      const name = accName(el);
      if (isHeading) {
        if (name) {
          ctx.lines.push(`${'  '.repeat(depth)}# ${name}`);
          nextDepth = depth + 1;
        }
      } else {
        const role = roleOf(el);
        // Form controls are always actionable, so they are listed even when the
        // page gives them no name at all — their state line says what they are.
        const alwaysList = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || (el as HTMLElement).isContentEditable;
        if (name || alwaysList) {
          const ref = put(el);
          ctx.lines.push(`${'  '.repeat(depth)}${role} "${name}"${stateOf(el)} [${ref}]`);
          nextDepth = depth + 1;
        }
      }
    }

    // Descend: light DOM, then open shadow roots, then same-origin iframes.
    walk(el, nextDepth, ctx);
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) walk(shadow, nextDepth, ctx);
    if (el.tagName === 'IFRAME') {
      try {
        // Cross-origin frames throw here; the background reaches those
        // separately, through their own content-script instance.
        const doc = (el as HTMLIFrameElement).contentDocument;
        if (doc?.body) walk(doc.body, nextDepth, ctx);
      } catch {
        ctx.lines.push(`${'  '.repeat(nextDepth)}(cross-origin frame — listed separately below)`);
      }
    }
  }
}

function snapshot(): { tree: string; url: string; title: string; truncated: boolean } {
  registry.clear();
  refSeq = 0;
  const ctx: SnapCtx = { lines: [], truncated: false };
  if (document.body) walk(document.body, 0, ctx);
  return {
    tree: ctx.lines.join('\n'),
    url: location.href,
    title: document.title,
    truncated: ctx.truncated,
  };
}

/* ── Settle + change detection ────────────────────────────────────────────── */

// Wait until the page stops changing, so the next read isn't of a half-rendered
// page. Resolves after ~300ms of DOM quiet, or `cap` ms, whichever comes first.
function settle(cap = 2500): Promise<void> {
  return new Promise((resolve) => {
    let quiet = 0;
    const mo = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, 300) as unknown as number;
    });
    const hard = setTimeout(done, cap) as unknown as number;
    quiet = setTimeout(done, 300) as unknown as number;
    try {
      mo.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      /* detached document */
    }
    function done() {
      mo.disconnect();
      clearTimeout(quiet);
      clearTimeout(hard);
      resolve();
    }
  });
}

interface Fingerprint {
  url: string;
  title: string;
  labels: string[];
}

// Cheap "what's on screen" signature, so an action can report what it actually
// changed instead of just claiming success.
function fingerprint(): Fingerprint {
  const labels: string[] = [];
  for (const el of Array.from(document.querySelectorAll(INTERACTIVE)).slice(0, 400)) {
    if (labels.length >= 120) break;
    if (!renderable(el)) continue;
    const n = accName(el);
    if (n) labels.push(n);
  }
  return { url: location.href, title: document.title, labels };
}

function describeChange(before: Fingerprint, after: Fingerprint): string {
  const bits: string[] = [];
  if (before.url !== after.url) bits.push(`navigated to ${after.url}`);
  else if (before.title !== after.title) bits.push(`title is now "${after.title}"`);
  const was = new Set(before.labels);
  const now = new Set(after.labels);
  const added = after.labels.filter((l) => !was.has(l)).slice(0, 6);
  const removed = before.labels.filter((l) => !now.has(l)).length;
  if (added.length) bits.push(`new on screen: ${added.map((a) => `"${a}"`).join(', ')}`);
  if (removed) bits.push(`${removed} element(s) disappeared`);
  return bits.length ? bits.join('; ') : 'no visible change — the action may not have registered';
}

/* ── Real input events ────────────────────────────────────────────────────── */

// A single el.click() is one synthetic event; plenty of UIs listen for the whole
// gesture. Fire the sequence a real mouse produces. Returns where it clicked
// (CSS viewport coords) so the background can retry the same spot as a trusted
// CDP click if nothing happened.
function realClick(el: HTMLElement): { x: number; y: number } {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  const clientX = r.left + r.width / 2;
  const clientY = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY };
  const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };

  el.dispatchEvent(new PointerEvent('pointerover', ptr));
  el.dispatchEvent(new MouseEvent('mouseover', base));
  el.dispatchEvent(new PointerEvent('pointermove', ptr));
  el.dispatchEvent(new MouseEvent('mousemove', base));
  el.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, button: 0 }));
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* not focusable */
  }
  el.dispatchEvent(new PointerEvent('pointerup', ptr));
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0 }));
  el.dispatchEvent(new MouseEvent('click', { ...base, button: 0, detail: 1 }));
  return { x: Math.round(clientX), y: Math.round(clientY) };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

// Rich editors (Lexical, ProseMirror, Draft.js) keep their own model and ignore
// a direct textContent write — but they all honour beforeinput/execCommand.
function writeInto(el: HTMLElement, text: string) {
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  el.focus();

  if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text }));
    }
    return;
  }

  const field = el as HTMLInputElement;
  setNativeValue(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

// Enter, once — not twice.
//
// This used to dispatch the key events AND call requestSubmit() on the enclosing
// form. In a chat composer that is two sends: the app's own keydown handler
// fires one, the form submit fires another. requestSubmit() is now only a
// fallback for plain form fields whose app ignored the synthetic keydown.
function pressEnter(el: HTMLElement) {
  const init = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const handled = !el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));

  // A composer is never submitted by a form — the app owns Enter there.
  if (el.isContentEditable || el.getAttribute('role') === 'textbox') return;
  // The app called preventDefault, so it acted on Enter itself. Doing more
  // would send a second time.
  if (handled) return;
  (el.closest('form') as HTMLFormElement | null)?.requestSubmit?.();
}

/* ── Label matching (fallback when a ref isn't available) ─────────────────── */

function findClickable(query: string): HTMLElement | null {
  const t = String(query || '').toLowerCase();
  let best: HTMLElement | null = null;
  let bestLen = Infinity;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE))) {
    if (!renderable(el)) continue;
    const label = accName(el).toLowerCase();
    if (label && label.includes(t) && label.length < bestLen) {
      best = el;
      bestLen = label.length;
    }
  }
  return best;
}

function inputEls(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'input[type="text"], input[type="search"], input[type="email"], input[type="url"], input:not([type]), textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]',
    ),
  ).filter(renderable);
}

function findInput(hint?: string): HTMLElement | null {
  const els = inputEls();
  if (!els.length) return null;

  if (hint) {
    const h = hint.toLowerCase();
    const words = h.split(/\s+/).filter(Boolean);
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const el of els) {
      const lab = accName(el).toLowerCase();
      let score = 0;
      if (lab.includes(h)) score = 3;
      else if (words.some((w) => lab.includes(w))) score = 1;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best) return best;
  }

  // No hint: the focused field, else the largest editable area (compose bodies
  // are typically the biggest box on the page).
  const active = document.activeElement as HTMLElement | null;
  if (active && els.includes(active)) return active;
  return els.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  })[0];
}

/* ── File uploads ─────────────────────────────────────────────────────────── */

// Attaching a file is the one action that can't be done by clicking: the click
// opens the OS file dialog, which lives outside the page and outside anything an
// extension can reach. So the dialog is never opened — the bytes are written
// straight into the <input type="file"> instead, and the page is told the same
// story it would have been told by a real pick.
//
// The catch is that on a modern site that input is almost never visible: it sits
// at zero size behind a styled "Add media" button. So it can't be found the way
// every other element here is found (by what the user can see) — it's collected
// blind, everywhere, including the places `renderable` would reject.

function fileInputs(root: Document | ShadowRoot | Element = document): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file') {
      out.push(el as HTMLInputElement);
    }
    if (el.shadowRoot) out.push(...fileInputs(el.shadowRoot));
    if (el.tagName === 'IFRAME') {
      try {
        const doc = (el as HTMLIFrameElement).contentDocument;
        if (doc) out.push(...fileInputs(doc));
      } catch {
        // Cross-origin frame — its own content-script instance handles it.
      }
    }
  }
  return out;
}

/**
 * The input this file belongs in. A page can have several (avatar, banner,
 * post attachment), so an `accept` that actually matches the file wins over one
 * that takes anything, and a disconnected leftover never wins at all.
 */
function pickFileInput(mime: string, ref?: string): HTMLInputElement | null {
  if (ref) {
    const el = get(ref);
    if (el?.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file') return el as HTMLInputElement;
    // A ref pointing at the *button* is the common case — the real input is
    // usually its sibling or a descendant of the same container.
    const near = el?.closest('form, [role="dialog"], div');
    if (near) {
      const found = fileInputs(near)[0];
      if (found) return found;
    }
  }
  const all = fileInputs().filter((el) => el.isConnected && !el.disabled);
  if (!all.length) return null;
  const kind = mime.split('/')[0];
  return (
    all.find((el) => el.accept && el.accept.includes(mime)) ??
    all.find((el) => el.accept && el.accept.includes(`${kind}/*`)) ??
    all.find((el) => !el.accept) ??
    all[0]
  );
}

function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ── Media ────────────────────────────────────────────────────────────────── */

// "Download this image" has to resolve to ONE image, and the snapshot tree only
// carries what is clickable — an <img> usually isn't. So images get their own
// listing, ordered by how much of the page they occupy, because the picture the
// user means is nearly always the big one they are looking at.

interface FoundImage {
  src: string;
  alt: string;
  w: number;
  h: number;
  visible: boolean;
}

function collectImages(): FoundImage[] {
  const out: FoundImage[] = [];
  const seen = new Set<string>();

  const add = (rawSrc: string, alt: string, el: Element) => {
    if (!rawSrc) return;
    let src = rawSrc;
    try {
      src = new URL(rawSrc, location.href).href;
    } catch {
      return;
    }
    if (seen.has(src)) return;
    const r = el.getBoundingClientRect();
    // Tracking pixels, spacers and icon sprites are noise in this list.
    if (r.width < 32 || r.height < 32) return;
    seen.add(src);
    out.push({
      src,
      alt: (alt || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: inViewport(el),
    });
  };

  for (const img of Array.from(document.images)) {
    if (pruned(img) || !renderable(img)) continue;
    // currentSrc is what the browser actually picked out of a srcset.
    add(img.currentSrc || img.src, img.alt || img.title, img);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[style*="background-image"], picture, video[poster]'))) {
    if (pruned(el) || !renderable(el)) continue;
    if (el.tagName === 'VIDEO') {
      add((el as HTMLVideoElement).poster, accName(el), el);
      continue;
    }
    const bg = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
    if (bg) add(bg[1], accName(el), el);
  }

  // Biggest first, on-screen ahead of off-screen: the top entry is almost
  // always the one a person would point at.
  return out
    .sort((a, b) => Number(b.visible) - Number(a.visible) || b.w * b.h - a.w * a.h)
    .slice(0, 30);
}

const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * Read a URL from inside the page and hand it back as a data: URL.
 *
 * The background can fetch most things itself. What it cannot fetch is anything
 * that only exists in this document — a blob: URL minted by the page, a canvas,
 * an image the site serves only to a request carrying its own headers. Those
 * have to be read here, where the page's origin applies.
 */
async function fetchAsset(url: string): Promise<{ dataUrl: string; mime: string; size: number }> {
  const abs = new URL(url, location.href).href;
  const res = await fetch(abs, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const blob = await res.blob();
  if (blob.size > MAX_ASSET_BYTES) throw new Error(`File is too big (${Math.round(blob.size / 1e6)} MB).`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(blob);
  });
  return { dataUrl, mime: blob.type || 'application/octet-stream', size: blob.size };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',', 2);
  const mime = /data:([^;,]+)/.exec(head)?.[1] || 'application/octet-stream';
  if (!/;base64/i.test(head)) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Last-resort save: an <a download> click, the way a page saves its own files. */
function anchorSave(dataUrl: string, filename: string) {
  const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 20000);
}

/* ── Message handling ─────────────────────────────────────────────────────── */

type Reply =
  | { ok: true; data: any; coords?: { x: number; y: number }; changed?: boolean }
  | { ok: false; error: string };

const STALE = (ref: string) => `${ref} is stale or gone — take a new snapshot.`;

const NO_CHANGE = 'no visible change';

// The fingerprint taken just before the last click (or mark_before). Kept here
// so the background's trusted-click retry can ask "did THAT change anything?"
// without shuttling the fingerprint through messages.
let lastBefore: Fingerprint | null = null;

async function handle(msg: any): Promise<Reply> {
  switch (msg.action) {
    case 'ping':
      return { ok: true, data: { url: location.href, title: document.title } };

    case 'get_page':
      return {
        ok: true,
        data: {
          title: document.title,
          url: location.href,
          // Matches the cap on the page text the island sends with a request:
          // get_page is how the agent goes back for the real thing, so it must
          // never hand back less than the prompt already had.
          text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 16000),
        },
      };

    case 'snapshot':
      return { ok: true, data: snapshot() };

    case 'click': {
      const el = get(msg.ref);
      if (!el) return { ok: false, error: STALE(msg.ref) };
      const name = accName(el) || el.tagName.toLowerCase();
      const before = fingerprint();
      lastBefore = before;
      const coords = realClick(el);
      await settle();
      const change = describeChange(before, fingerprint());
      return { ok: true, data: `Clicked "${name}". ${change}`, coords, changed: !change.startsWith(NO_CHANGE) };
    }

    case 'fill': {
      const el = msg.ref ? get(msg.ref) : findInput(msg.field);
      if (!el) return { ok: false, error: msg.ref ? STALE(msg.ref) : 'No matching text field.' };
      const name = accName(el) || el.tagName.toLowerCase();
      const before = fingerprint();
      writeInto(el, String(msg.text ?? ''));
      if (msg.submit) pressEnter(el);
      await settle(msg.submit ? 2500 : 800);
      const change = msg.submit ? ` ${describeChange(before, fingerprint())}` : '';
      return { ok: true, data: `Typed into "${name}"${msg.submit ? ' and submitted.' : '.'}${change}` };
    }

    case 'select': {
      const el = get(msg.ref);
      if (!el) return { ok: false, error: STALE(msg.ref) };
      if (el.tagName !== 'SELECT') return { ok: false, error: `${msg.ref} is not a dropdown.` };
      const sel = el as unknown as HTMLSelectElement;
      const want = String(msg.option ?? '').toLowerCase();
      const opt = Array.from(sel.options).find(
        (o) => o.value.toLowerCase() === want || o.text.toLowerCase().includes(want),
      );
      if (!opt) {
        const all = Array.from(sel.options).map((o) => o.text).slice(0, 20).join(', ');
        return { ok: false, error: `No option matching "${msg.option}". Options: ${all}` };
      }
      sel.value = opt.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(800);
      return { ok: true, data: `Selected "${opt.text}".` };
    }

    case 'scroll': {
      const before = fingerprint();
      if (msg.ref) {
        const el = get(msg.ref);
        if (!el) return { ok: false, error: STALE(msg.ref) };
        el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      } else {
        const amount = Number(msg.amount) || Math.round(innerHeight * 0.8);
        scrollBy({ top: amount * (msg.direction === 'up' ? -1 : 1), behavior: 'instant' as ScrollBehavior });
      }
      await settle(1200);
      const change = describeChange(before, fingerprint());
      return { ok: true, data: `Scrolled. ${change} Take a new snapshot for refs on anything new.` };
    }

    // Fallbacks — label matching, for when a full snapshot isn't worth it.
    case 'click_text': {
      const el = findClickable(msg.text);
      if (!el) return { ok: false, error: `No clickable element matching "${msg.text}"` };
      const name = accName(el);
      const before = fingerprint();
      lastBefore = before;
      const coords = realClick(el);
      await settle();
      const change = describeChange(before, fingerprint());
      return { ok: true, data: `Clicked "${name.slice(0, 60)}". ${change}`, coords, changed: !change.startsWith(NO_CHANGE) };
    }

    case 'type_text': {
      const el = findInput(msg.field);
      if (!el) return { ok: false, error: 'No matching text field found on this page' };
      const before = fingerprint();
      writeInto(el, String(msg.text ?? ''));
      if (msg.submit) pressEnter(el);
      await settle(msg.submit ? 2500 : 800);
      const where = accName(el) || el.tagName.toLowerCase();
      const change = msg.submit ? ` ${describeChange(before, fingerprint())}` : '';
      return { ok: true, data: `Typed into "${where.slice(0, 40)}"${msg.submit ? ' and submitted.' : '.'}${change}` };
    }

    case 'attach_file': {
      const name = String(msg.name ?? 'file');
      const mime = String(msg.mime ?? 'application/octet-stream');
      if (!msg.base64) return { ok: false, error: 'No file contents were passed.' };
      const input = pickFileInput(mime, msg.ref);
      if (!input) {
        return {
          ok: false,
          error:
            'No file input on this page. Click the page\'s "Add photo"/attach button first — the input usually only exists once the composer is open — then try again.',
        };
      }
      const before = fingerprint();
      const file = new File([base64ToBytes(String(msg.base64))], name, { type: mime });
      // The page is watching for a user pick, and a user pick sets .files and
      // fires input+change. DataTransfer is the only way to build a FileList.
      const dt = new DataTransfer();
      if (msg.append) for (const f of Array.from(input.files ?? [])) dt.items.add(f);
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // Uploads render a preview, which takes longer than a click does.
      await settle(6000);
      const change = describeChange(before, fingerprint());
      return {
        ok: true,
        data: `Attached "${name}". ${change}`,
        changed: !change.startsWith(NO_CHANGE),
      };
    }

    case 'list_images':
      return { ok: true, data: collectImages() };

    case 'fetch_asset': {
      if (!msg.url) return { ok: false, error: 'No url given.' };
      return { ok: true, data: await fetchAsset(String(msg.url)) };
    }

    case 'save_blob': {
      if (!msg.dataUrl) return { ok: false, error: 'Nothing to save.' };
      anchorSave(String(msg.dataUrl), String(msg.filename || 'download'));
      return { ok: true, data: `Saved ${msg.filename}` };
    }

    case 'list_actions': {
      // Kept for compatibility; snapshot supersedes it.
      return { ok: true, data: { tree: snapshot().tree } };
    }

    // Support for the background's trusted (CDP) clicks, which happen outside
    // this script: mark_before snapshots "what the screen was", describe_change
    // settles and reports what the click did against that mark.
    case 'mark_before': {
      lastBefore = fingerprint();
      return { ok: true, data: 'ok' };
    }

    case 'describe_change': {
      await settle();
      const change = lastBefore ? describeChange(lastBefore, fingerprint()) : 'done';
      return { ok: true, data: change, changed: !change.startsWith(NO_CHANGE) };
    }

    case 'viewport':
      return { ok: true, data: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } };

    default:
      return { ok: false, error: `Unknown action: ${msg.action}` };
  }
}

export function registerActions() {
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== 'tidra-action') return;
    handle(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async response
  });
}
