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

// The counter is NEVER reset. Each snapshot clears the registry but keeps
// counting from where the last one stopped, so a number is only ever handed out
// once per page lifetime.
//
// This matters more than it looks. When the counter restarted at 0 every
// snapshot, a ref the model was still carrying from an older tree — ref_12, say
// — resolved against the NEW tree's ref_12, which is a different element that
// happens to sit at the same index. The click succeeded, on the wrong thing, and
// nothing anywhere reported a problem. Monotonic numbering turns that silent
// misfire into an honest "stale — take a new snapshot", because the old number
// simply isn't in the registry any more.
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
  // Drop the old tree's refs but keep counting — see the note on `refSeq`.
  registry.clear();
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
  // Structural signal, for everything a label set cannot see.
  states: string;   // checked / expanded / selected / value, per control
  textLen: number;  // visible character count
  count: number;    // how many interactive elements exist
  scrollY: number;
  focus: string;
}

// Cheap "what's on screen" signature, so an action can report what it actually
// changed instead of just claiming success.
//
// Labels alone are not enough, and the gap was doing real damage. Clicking Like
// leaves a button still labelled "Like"; ticking a checkbox, opening a menu
// whose items are named the same, incrementing a counter — none of them move a
// label. Every one of those came back "no visible change", which is the string
// that triggers the background's trusted-click retry. So a click that HAD
// worked was silently performed a second time: liked then unliked, sent twice.
// It also fed `badStreak` and escalated the run to the expensive model for no
// reason. Hence the state/length/count/scroll/focus bits below.
function fingerprint(): Fingerprint {
  const labels: string[] = [];
  const states: string[] = [];
  const all = Array.from(document.querySelectorAll(INTERACTIVE));
  for (const el of all.slice(0, 400)) {
    if (!renderable(el)) continue;
    if (labels.length < 120) {
      const n = accName(el);
      if (n) labels.push(n);
    }
    if (states.length < 120) {
      const anyEl = el as HTMLInputElement;
      const bits = [
        el.getAttribute('aria-checked') ?? (typeof anyEl.checked === 'boolean' ? String(anyEl.checked) : ''),
        el.getAttribute('aria-expanded') ?? '',
        el.getAttribute('aria-selected') ?? '',
        typeof anyEl.value === 'string' ? String(anyEl.value.length) : '',
      ].join('');
      if (bits) states.push(bits);
    }
  }
  const active = document.activeElement;
  return {
    url: location.href,
    title: document.title,
    labels,
    states: states.join('|'),
    textLen: (document.body?.innerText || '').length,
    count: all.length,
    scrollY: Math.round(scrollY),
    focus: active && active !== document.body ? accName(active) || active.tagName : '',
  };
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

  // Only consulted when nothing above fired: these are quieter signals, and
  // saying "the page grew by 40 characters" over the top of "navigated to …"
  // would bury the useful half of the report.
  if (!bits.length) {
    if (before.states !== after.states) bits.push('a control changed state (toggled, expanded or edited)');
    if (before.count !== after.count) {
      const d = after.count - before.count;
      bits.push(`${Math.abs(d)} interactive element(s) ${d > 0 ? 'appeared' : 'went away'}`);
    }
    const dText = after.textLen - before.textLen;
    if (Math.abs(dText) > 20) bits.push(`page text ${dText > 0 ? 'grew' : 'shrank'} by ${Math.abs(dText)} characters`);
    if (before.focus !== after.focus && after.focus) bits.push(`focus moved to "${after.focus}"`);
    if (Math.abs(after.scrollY - before.scrollY) > 40) bits.push(`the page scrolled to ${after.scrollY}px`);
  }
  return bits.length ? bits.join('; ') : 'no visible change — the action may not have registered';
}

/* ── Real input events ────────────────────────────────────────────────────── */

// A single el.click() is one synthetic event; plenty of UIs listen for the whole
// gesture. Fire the sequence a real mouse produces. Returns where it clicked
// (CSS viewport coords) so the background can retry the same spot as a trusted
// CDP click if nothing happened.
/**
 * Where on this element a real mouse could actually land.
 *
 * The centre is the obvious choice and usually right, but a sticky header, a
 * cookie banner or an open modal will sit on top of it — and the click then
 * goes to the overlay, not the button. That mattered doubly because the
 * background's trusted-click retry re-dispatches at these exact coordinates, so
 * a covered point got hit twice and still did nothing.
 *
 * Tries the centre, then points inset from each edge. Returns what is actually
 * on top, so a blocked click can say WHAT is in the way instead of just
 * failing — the model can then dismiss the banner and carry on.
 */
function hitPoint(el: HTMLElement): { x: number; y: number; blockedBy: string | null } {
  const r = el.getBoundingClientRect();
  const inset = (f: number, size: number) => Math.max(2, Math.min(size * f, 12));
  const candidates: [number, number][] = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + inset(0.25, r.width), r.top + r.height / 2],
    [r.right - inset(0.25, r.width), r.top + r.height / 2],
    [r.left + r.width / 2, r.top + inset(0.25, r.height)],
    [r.left + r.width / 2, r.bottom - inset(0.25, r.height)],
  ];

  let blocker: Element | null = null;
  for (const [x, y] of candidates) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    const top = document.elementFromPoint(x, y);
    // The element itself, something inside it (an icon, a label span), or a
    // shadow host that contains it — all of these deliver the click correctly.
    if (top && (top === el || el.contains(top) || top.contains(el))) {
      return { x: Math.round(x), y: Math.round(y), blockedBy: null };
    }
    if (top && !blocker) blocker = top;
  }

  const name = blocker ? accName(blocker) || blocker.tagName.toLowerCase() : 'something';
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    blockedBy: name.slice(0, 60),
  };
}

function realClick(el: HTMLElement): { x: number; y: number; blockedBy: string | null } {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const spot = hitPoint(el);
  const clientX = spot.x;
  const clientY = spot.y;
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
  return { x: clientX, y: clientY, blockedBy: spot.blockedBy };
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

/** What a field actually contains now — the only honest way to know a write
 *  landed. React and Lexical both accept a write and silently discard it often
 *  enough that reporting "typed" without looking is a lie about half the time. */
function readBack(el: HTMLElement): string {
  if (el.isContentEditable || el.getAttribute('role') === 'textbox') return textOf(el);
  return String((el as HTMLInputElement).value ?? '');
}

/** Empty a field the way a person does — select-all, then delete. Setting
 *  value = '' skips the events rich editors need, and leaves React's tracker
 *  believing the old text is still there. */
function clearField(el: HTMLElement) {
  el.focus();
  if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    if (!document.execCommand('delete')) {
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    }
    return;
  }
  const field = el as HTMLInputElement;
  setNativeValue(field, '');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

// Menus that open on mouseover, tooltips, hover-revealed action rows. Without
// this the tree simply never contains the thing the user is asking for, and the
// model loops taking snapshots of a page whose menu it cannot open.
function hoverOver(el: HTMLElement) {
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  const { x: clientX, y: clientY } = hitPoint(el);
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY };
  const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerover', ptr));
  el.dispatchEvent(new MouseEvent('mouseover', base));
  el.dispatchEvent(new PointerEvent('pointermove', ptr));
  el.dispatchEvent(new MouseEvent('mousemove', base));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
}

// Keys the agent is allowed to press. A closed list, not free text: the point
// is to reach combobox/modal/date-picker behaviour, not to hand the model a
// general keyboard it could type a submit into.
const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
};

function pressKey(el: HTMLElement, name: string): boolean {
  const k = KEYS[name];
  if (!k) return false;
  const init = { ...k, which: k.keyCode, bubbles: true, cancelable: true, composed: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
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
      const { x, y, blockedBy } = realClick(el);
      await settle();
      const change = describeChange(before, fingerprint());
      // Say what is covering the button. "no visible change" sends the model
      // back to click the same thing again; "a cookie banner is on top of it"
      // sends it to close the banner, which is the move that actually works.
      const note = blockedBy ? ` Note: "${blockedBy}" is on top of it and may have taken the click instead.` : '';
      return {
        ok: true,
        data: `Clicked "${name}". ${change}${note}`,
        coords: { x, y },
        changed: !change.startsWith(NO_CHANGE),
      };
    }

    case 'fill': {
      const el = msg.ref ? get(msg.ref) : findInput(msg.field);
      if (!el) return { ok: false, error: msg.ref ? STALE(msg.ref) : 'No matching text field.' };
      const name = accName(el) || el.tagName.toLowerCase();
      const before = fingerprint();
      const wanted = String(msg.text ?? '');
      writeInto(el, wanted);
      if (msg.submit) pressEnter(el);
      await settle(msg.submit ? 2500 : 800);

      // Verify, rather than assume. A submitted field is usually empty again by
      // now (that is what sending does), so read-back only judges a plain write.
      if (!msg.submit) {
        const got = readBack(el);
        if (got.trim() !== wanted.trim()) {
          return {
            ok: false,
            error: got
              ? `"${name}" did not take the text — it now reads "${got.slice(0, 80)}". It may be a rich editor that needs a click first, or a field that reformats input.`
              : `"${name}" is still empty — the text did not go in. Click the field first, then try again.`,
          };
        }
        return { ok: true, data: `Typed into "${name}". Verified: it now contains the text.` };
      }
      return { ok: true, data: `Typed into "${name}" and submitted. ${describeChange(before, fingerprint())}` };
    }

    case 'hover': {
      const el = get(msg.ref);
      if (!el) return { ok: false, error: STALE(msg.ref) };
      const name = accName(el) || el.tagName.toLowerCase();
      const before = fingerprint();
      hoverOver(el);
      await settle(1200);
      const change = describeChange(before, fingerprint());
      return { ok: true, data: `Hovered "${name}". ${change}`, changed: !change.startsWith(NO_CHANGE) };
    }

    case 'press_key': {
      const key = String(msg.key ?? '');
      // No ref means "send it to the page" — Escape closing a modal, PageDown
      // scrolling a list. The focused element is the right target for those.
      const el = msg.ref ? get(msg.ref) : ((document.activeElement as HTMLElement) ?? document.body);
      if (!el) return { ok: false, error: STALE(msg.ref) };
      const before = fingerprint();
      if (!pressKey(el, key)) {
        return { ok: false, error: `"${key}" is not a key I can press. Try one of: ${Object.keys(KEYS).join(', ')}.` };
      }
      await settle(1500);
      const change = describeChange(before, fingerprint());
      return { ok: true, data: `Pressed ${key}. ${change}`, changed: !change.startsWith(NO_CHANGE) };
    }

    case 'clear': {
      const el = msg.ref ? get(msg.ref) : findInput(msg.field);
      if (!el) return { ok: false, error: msg.ref ? STALE(msg.ref) : 'No matching text field.' };
      const name = accName(el) || el.tagName.toLowerCase();
      clearField(el);
      await settle(800);
      const left = readBack(el);
      if (left.trim()) return { ok: false, error: `"${name}" still contains "${left.slice(0, 60)}".` };
      return { ok: true, data: `Cleared "${name}".` };
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
      const { x, y, blockedBy } = realClick(el);
      await settle();
      const change = describeChange(before, fingerprint());
      const note = blockedBy ? ` Note: "${blockedBy}" is on top of it and may have taken the click instead.` : '';
      return {
        ok: true,
        data: `Clicked "${name.slice(0, 60)}". ${change}${note}`,
        coords: { x, y },
        changed: !change.startsWith(NO_CHANGE),
      };
    }

    case 'type_text': {
      const el = findInput(msg.field);
      if (!el) return { ok: false, error: 'No matching text field found on this page' };
      const before = fingerprint();
      const wanted = String(msg.text ?? '');
      writeInto(el, wanted);
      if (msg.submit) pressEnter(el);
      await settle(msg.submit ? 2500 : 800);
      const where = (accName(el) || el.tagName.toLowerCase()).slice(0, 40);
      if (!msg.submit) {
        const got = readBack(el);
        if (got.trim() !== wanted.trim()) {
          return {
            ok: false,
            error: got
              ? `"${where}" did not take the text — it now reads "${got.slice(0, 80)}".`
              : `"${where}" is still empty — the text did not go in.`,
          };
        }
        return { ok: true, data: `Typed into "${where}". Verified: it now contains the text.` };
      }
      return { ok: true, data: `Typed into "${where}" and submitted. ${describeChange(before, fingerprint())}` };
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
