import {
  GROQ_MODELS,
  callModel,
  supportsVision,
  tierFor,
  type ContentBlock,
  type Message,
  type ImageBlock,
  type TextBlock,
  type Tool,
  type ToolResultBlock,
} from '../lib/llm';
import {
  MAX_ITEMS,
  allItems,
  claimNext,
  clearJob,
  estimate,
  humanDuration,
  itemsFromCsv,
  loadJob,
  newJob,
  reconcile,
  requeue,
  retrySweep,
  saveJob,
  setItems,
  settle,
  type Job,
  type JobItem,
} from '../lib/jobs';
import { parsePrintedConfirm } from '../lib/confirm';
import { base64ToBlob, transcribe } from '../lib/voice';

interface PageContext {
  title: string;
  url: string;
  text: string;
}

/** A file the user attached to their message. */
export interface Attachment {
  kind: 'image' | 'text';
  name: string;
  /** Images: base64 (no data: prefix). Text files: the text itself. */
  data: string;
  mime: string;
}

interface AskRequest {
  type: 'tidra-ask';
  prompt: string;
  page: PageContext;
  intent?: 'chat' | 'act';
  attachments?: Attachment[];
}

// Key + models. Read fresh on every request so a settings change takes effect
// without reloading the extension.
async function modelSetup(): Promise<{
  apiKey: string;
  tier: { chat: string; act: string; router: string };
} | null> {
  const store = await browser.storage.local.get(['tidraGroqKey', 'tidraTier']);
  const apiKey = store.tidraGroqKey as string | undefined;
  if (!apiKey) return null;
  return { apiKey, tier: tierFor(store.tidraTier as string) };
}

interface TabState {
  tabId: number | undefined;
}

const SYSTEM_PROMPT = `You are Tidra, a highly capable AI assistant that lives in the user's browser as a floating "island". You don't just chat — you get things done by taking real actions on the page.

If the current page is Tidra's own new tab, there is no web page to read yet — your first move is open_url to the site the task is about. Never tell the user you can't access a site: open it.

By default, actions happen on the user's CURRENT tab. Respect their wording: if they say "in a new tab" / "keep this page", open a new tab instead.

How you see and touch a page:
- snapshot() returns every interactive element as a tree, each with a ref like ref_0-12:
    # Inbox
    button "Compose" [ref_0-4]
    textbox "To" value:"" [ref_0-9]
    textbox "Message Body" [ref_0-11]
  Act on refs — click(ref_0-4), fill(ref_0-11, "…") — never guess at labels.
- Refs go stale the moment the page changes. After any click that opens, navigates or re-renders, take a fresh snapshot before acting again. If a tool says a ref is stale, snapshot and retry.
- Every action tells you what changed ("new on screen: …"). Read it. "No visible change" means it didn't work — try a different element rather than continuing as if it succeeded.
- Elements marked "offscreen" need scroll() first. Lists that load more as you scroll need scroll(direction:"down") then a fresh snapshot.
- Sub-frames appear as FRAME sections with their own refs; use them exactly like the main page's.
- go_back() returns to the previous page — use it to get back to a list of results after opening one item, instead of re-navigating from scratch.
- You have plenty of steps. Work through a task item by item: do the first one completely, go_back, then the next. Don't abandon a task half-done, and don't try to shortcut by guessing URLs for things you found in a list.

If a task can't actually be done on the site — the feature doesn't exist, or it needs something only the user has — say so in one line instead of clicking around hoping. Don't fake completion.

Tools:
- open_url(url, new_tab): open a website; returns its snapshot. Full https URLs. Current tab by default; new_tab=true only if asked. Go directly to well-known sites (https://www.linkedin.com, https://mail.google.com, https://www.facebook.com, https://x.com). To search, go to https://www.google.com/search?q=... .
- snapshot(): the interactive tree described above. Your default way of looking at a page.
- click(ref) / fill(ref, text, submit) / select(ref, option) / scroll(ref | direction, amount).
- get_page(): the page's visible TEXT — for reading and understanding content (an email thread, an article), not for finding things to click.
- screenshot(): a picture of the page. Expensive — only when the snapshot genuinely isn't enough (canvas, custom widgets) or an action failed twice and you need to see why.
- click_text(text) / type_text(text, field, submit): label-matching fallbacks for when a full snapshot isn't worth it.

How to behave — be decisive and intelligent:
- Reply in the language the user writes in.
- EXECUTE multi-step tasks yourself. "Reply to this email" → open the reply, understand the thread from the page, write a fitting reply into the body. "Write a new post about X" → open the composer, write a genuinely good post, fill it in. Don't narrate a plan and stop — do the steps.
- Draft real, high-quality content that fits the context and the user's voice. Don't ask them what to write unless the task is truly impossible without a specific detail (then ask ONE tight question).
- Don't over-ask or over-confirm. Take reasonable actions (navigating, opening composers, writing drafts, filling fields) without asking permission.

THE ONE HARD RULE — confirm before the irreversible send:
- After you've drafted/filled everything, STOP right before the final irreversible action — sending an email, publishing a post/tweet, submitting a comment, purchasing, transferring money, or deleting. Do NOT click Send/Post/Publish/Submit/Buy/Delete yet.
- This includes submit=true on fill/type_text. In a message or post composer, Enter IS the send button. Write the draft with submit omitted, then call confirm_action.
- Instead, call the confirm_action tool with a short summary (quote the key content briefly) and a confirm_label like "Send" or "Post". This shows the user a Confirm/Cancel bar.
- When the user then confirms (their next message will say something like "Confirmed — send it"), immediately click the Send/Post button on the page to complete it. Do NOT call confirm_action again — the user already approved.

- Be concise. After acting, say in one or two lines what you did.
- Never invent facts about the page or the email/thread — base drafts on what's actually there.`;

const TOOLS: Tool[] = [
  {
    name: 'open_url',
    description:
      'Open a website and return its interactive snapshot. Use full https URLs. By default navigates the CURRENT tab; set new_tab=true to open a new tab instead.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full https URL to open' },
        new_tab: {
          type: 'boolean',
          description:
            'Open in a NEW tab (true) only if the user asked for a new tab / to keep the current page; otherwise navigate the current tab (false).',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'go_back',
    description:
      'Go back to the previous page — e.g. to return to a list of search results after opening one of them. Returns the snapshot of where you land.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'snapshot',
    description:
      "Read the page's interactive elements as an indented tree. Every element gets a ref like ref_0-12; use those refs with click/fill/select/scroll. Take a fresh snapshot after anything changes the page — refs from an old snapshot go stale.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'click',
    description: 'Click the element with this ref. Returns what changed on the page afterwards.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'A ref from the latest snapshot, e.g. ref_0-12' } },
      required: ['ref'],
    },
  },
  {
    name: 'fill',
    description:
      'Type into the field with this ref (replacing what is there). Works with plain inputs and rich editors. submit=true presses Enter — in a search box that runs the search, but in a MESSAGE OR POST COMPOSER Enter SENDS IT. Leave submit out when writing a message, comment or post; draft it and call confirm_action instead.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest snapshot' },
        text: { type: 'string', description: 'The text to type' },
        submit: {
          type: 'boolean',
          description:
            'Press Enter after typing. Only for search boxes and similar. Never for a message/post/comment composer — Enter sends there, and sending needs confirm_action first.',
        },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown (a <select>) by its visible text or value.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest snapshot' },
        option: { type: 'string', description: 'Visible text (or value) of the option to choose' },
      },
      required: ['ref', 'option'],
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page, or bring one element into view. Use this when a snapshot says elements are offscreen, or when a list loads more as you scroll.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Scroll this element into view (optional)' },
        direction: { type: 'string', enum: ['down', 'up'], description: 'Which way to scroll the page' },
        amount: { type: 'number', description: 'Pixels to scroll; defaults to about one screen' },
      },
    },
  },
  {
    name: 'screenshot',
    description:
      "Take a picture of the visible part of the page. Use ONLY when the snapshot isn't enough — canvas apps, custom drop-downs, or when an action failed twice and you need to see why. Costs far more than a snapshot. Only works on the tab in front.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_page',
    description: "Read the page's visible text (title, url, text). Use for reading and understanding content, not for finding things to click.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'click_text',
    description:
      'Fallback: click a link/button whose visible text contains this string. Prefer snapshot + click(ref) — use this only for something obvious when a snapshot is not worth the tokens.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Visible text of the element to click' } },
      required: ['text'],
    },
  },
  {
    name: 'type_text',
    description:
      'Fallback: type into a field picked by a label hint. Prefer snapshot + fill(ref). Omit "field" to target the main/largest editable area.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type' },
        field: {
          type: 'string',
          description: 'Optional hint to pick the right field (e.g. "subject", "message body", "to", "search").',
        },
        submit: { type: 'boolean', description: 'Press Enter / submit after typing' },
      },
      required: ['text'],
    },
  },
  {
    name: 'confirm_action',
    description:
      'Call this AFTER drafting/filling everything, right before an irreversible action (send email, publish post, submit, buy, delete). It pauses and shows the user a Confirm/Cancel bar. Do not click the Send/Post button yourself — call this instead and wait.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'Short message telling the user what you drafted and what will happen, ending by asking them to confirm.',
        },
        confirm_label: {
          type: 'string',
          description: 'Label for the confirm button, e.g. "Send", "Post", "Publish", "Submit".',
        },
      },
      required: ['summary'],
    },
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One-time cleanup of keys from the previous provider, so a stale credential
// isn't left sitting in storage — and can never be sent to Groq.
browser.storage.local.remove(['tidraApiKey', 'tidraProvider', 'tidraMcp']).catch(() => {});

// ─── The user's profile ─────────────────────────────────────────────────────
// Lives only in browser.storage.local — never uploaded, never synced. Every
// field is typed by the user in settings; Tidra never collects any of it on
// its own. It leaves the device only as part of a prompt the user triggered.

interface Profile {
  name?: string;
  email?: string;
  role?: string;
  company?: string;
  location?: string;
  languages?: string;
  about?: string;
}

async function getProfile(): Promise<Profile> {
  const { tidraProfile } = await browser.storage.local.get('tidraProfile');
  return (tidraProfile as Profile | undefined) ?? {};
}

// Appended to the system prompt so drafts are signed and toned correctly.
async function profilePreamble(): Promise<string> {
  const p = await getProfile();
  const bits: string[] = [];
  const add = (label: string, v?: string) => {
    if (v?.trim()) bits.push(`${label}: ${v.trim()}`);
  };
  add('Name', p.name);
  add('Email', p.email);
  add('Role', p.role);
  add('Company', p.company);
  add('Location', p.location);
  add('Languages', p.languages);
  add('Notes', p.about);
  if (!bits.length) return '';
  return `\n\nAbout the user (from their own profile — use it for their voice, sign-offs and tone):\n${bits.join('\n')}`;
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

interface ChatMsg {
  role: 'user' | 'assistant' | 'error';
  text: string;
}
interface ChatState {
  messages: ChatMsg[];
  loading: boolean;
}

// ─── Routine learning ──────────────────────────────────────────────────────
// Log which domains the user visits (domain + time only — no page content, no
// full URLs), group them into sessions, and when a new session starts (browser
// reopened / long gap) offer to reopen the recurring routine.
const SESSION_GAP = 4 * 60 * 60 * 1000; // a new "session" after 4h of no activity
const MAX_VISITS = 800;
const ROUTINE_FIRST = 5; // first N distinct domains of each session
const ROUTINE_MIN_SESSIONS = 3; // need at least this much history to suggest
const ROUTINE_FREQ = 0.5; // domain must appear in ≥50% of past sessions

interface Visit {
  d: string;
  t: number;
}

const KNOWN_NAMES: Record<string, string> = {
  'mail.google.com': 'Gmail',
  'calendar.google.com': 'Calendar',
  'drive.google.com': 'Drive',
  'www.linkedin.com': 'LinkedIn',
  'linkedin.com': 'LinkedIn',
  'www.youtube.com': 'YouTube',
  'github.com': 'GitHub',
  'x.com': 'X',
  'twitter.com': 'X',
  'web.whatsapp.com': 'WhatsApp',
  'www.facebook.com': 'Facebook',
  'www.notion.so': 'Notion',
  'app.slack.com': 'Slack',
};

function prettyDomain(d: string): string {
  if (KNOWN_NAMES[d]) return KNOWN_NAMES[d];
  const parts = d.replace(/^www\./, '').split('.');
  const name = parts.length >= 2 ? parts[parts.length - 2] : d;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Split the visit log into sessions and reduce each to its first distinct domains.
function sessionStarts(visits: Visit[]): string[][] {
  const sorted = [...visits].sort((a, b) => a.t - b.t);
  const sessions: string[][] = [];
  let cur: Visit[] = [];
  let lastT = 0;
  const flush = () => {
    if (!cur.length) return;
    const seen = new Set<string>();
    const first: string[] = [];
    for (const v of cur) {
      if (!seen.has(v.d)) {
        seen.add(v.d);
        first.push(v.d);
        if (first.length >= ROUTINE_FIRST) break;
      }
    }
    sessions.push(first);
    cur = [];
  };
  for (const v of sorted) {
    if (lastT && v.t - lastT > SESSION_GAP) flush();
    cur.push(v);
    lastT = v.t;
  }
  flush();
  return sessions;
}

// From history, find the recurring start-of-session routine (ordered domains).
function detectRoutine(visits: Visit[]): { domain: string; url: string }[] {
  const sessions = sessionStarts(visits);
  const past = sessions.slice(0, -1).slice(-12); // exclude the current session
  if (past.length < ROUTINE_MIN_SESSIONS) return [];
  const count: Record<string, number> = {};
  const posSum: Record<string, number> = {};
  for (const s of past) {
    s.forEach((d, i) => {
      count[d] = (count[d] || 0) + 1;
      posSum[d] = (posSum[d] || 0) + i;
    });
  }
  return Object.keys(count)
    .filter((d) => count[d] / past.length >= ROUTINE_FREQ)
    .sort((a, b) => posSum[a] / count[a] - posSum[b] / count[b])
    .slice(0, 5)
    .map((d) => ({ domain: prettyDomain(d), url: 'https://' + d }));
}

async function handleVisit(domain: string) {
  const store = await browser.storage.local.get(['tidraVisits', 'tidraRoutineEnabled']);
  if (store.tidraRoutineEnabled === false) return; // routine learning is opt-out
  const visits = (store.tidraVisits as Visit[]) || [];
  const now = Date.now();
  const last = visits.length ? visits[visits.length - 1] : null;
  if (last && last.d === domain && now - last.t < 30000) return; // dedup SPA reloads
  const gap = last ? now - last.t : Infinity;

  visits.push({ d: domain, t: now });
  if (visits.length > MAX_VISITS) visits.splice(0, visits.length - MAX_VISITS);

  const data: Record<string, unknown> = { tidraVisits: visits };
  // A fresh session just began — offer the learned routine (once per session).
  if (gap > SESSION_GAP) {
    const routine = detectRoutine(visits);
    if (routine.length >= 2) data.tidraRoutine = { sites: routine, ts: now };
  }
  await browser.storage.local.set(data);
}

// The in-flight request's abort controller, so the UI's Stop button can cancel it.
let currentAbort: AbortController | null = null;

// Clear the loading flag (used when the user stops, or a request is aborted).
async function clearLoading() {
  const { tidraChat } = await browser.storage.local.get('tidraChat');
  const chat = (tidraChat as ChatState) || { messages: [], loading: false };
  chat.loading = false;
  await browser.storage.local.set({ tidraChat: chat, tidraPending: null });
}

// Append a message to the persisted chat and clear the loading flag.
// The island renders from storage, so this survives page navigation.
// A short "what I'm doing right now" line for the collapsed island, so the
// user sees progress without keeping the panel open. Cleared when the turn ends.
function setStatus(text: string | null) {
  return browser.storage.local.set({ tidraStatus: text });
}

// Snapshots are big (thousands of tokens) and go stale the moment the page
// changes. Keeping every past one in history costs a fortune AND actively hurts:
// the model can see refs from old trees and cite one that no longer exists. So
// once a newer snapshot exists, blank out the older ones.
//
// Which results were snapshots is tracked in a Set of tool_use ids, NOT as a
// field on the block — anything added to a block is sent to the API verbatim,
// and an unknown field is a 400.
const SNAPSHOT_TOOLS = new Set(['snapshot', 'list_actions', 'open_url', 'go_back', 'screenshot']);

function pruneOldSnapshots(messages: Message[], snapshotIds: Set<string>) {
  let seenNewest = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !snapshotIds.has(block.tool_use_id)) continue;
      if (!seenNewest) {
        seenNewest = true; // keep the most recent one intact
        continue;
      }
      block.content = '[superseded snapshot removed — take a fresh one if you need refs]';
    }
  }
}

function statusFor(tool: string, input: any): string {
  switch (tool) {
    case 'snapshot':
    case 'list_actions':
      return 'Looking at the page';
    case 'click':
      return 'Clicking';
    case 'fill':
      return 'Writing the draft';
    case 'select':
      return 'Choosing an option';
    case 'scroll':
      return 'Scrolling';
    case 'screenshot':
      return 'Taking a look';
    case 'open_url': {
      let host = String(input?.url ?? '');
      try {
        host = new URL(host).hostname.replace(/^www\./, '');
      } catch {
        /* keep the raw string */
      }
      return `Opening ${host}`;
    }
    case 'get_page':
      return 'Reading the page';
    case 'list_actions':
      return 'Looking at what\'s on the page';
    case 'click_text':
      return `Clicking “${String(input?.text ?? '').slice(0, 30)}”`;
    case 'type_text':
      return input?.field ? `Filling in ${String(input.field).slice(0, 24)}` : 'Writing the draft';
    default:
      return 'Working';
  }
}

async function pushChat(text: string, role: 'assistant' | 'error') {
  const { tidraChat } = await browser.storage.local.get('tidraChat');
  const chat = (tidraChat as ChatState) || { messages: [], loading: false };
  chat.messages.push({ role, text });
  chat.loading = false;
  // Mark unread so the collapsed island can surface the new result.
  await browser.storage.local.set({ tidraChat: chat, tidraUnread: true, tidraStatus: null });
}

// Cheap Haiku router: decide "act" (needs browser tools) vs "chat" (answer
// about the page). Uses only the prompt + a little history — no page text —
// so it's a few dozen tokens. Errs toward "act" so capability isn't lost.
async function classify(
  apiKey: string,
  routerModel: string,
  prompt: string,
  history: ChatMsg[],
  signal?: AbortSignal,
): Promise<'chat' | 'act'> {
  try {
    const recent = history
      .slice(-4)
      .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
      .join('\n');
    const res = await callModel(
      apiKey,
      {
      model: routerModel,
      max_tokens: 5,
      system:
        [
          'Reply with exactly one word: act or chat.',
          '',
          'act — answering needs the browser. That covers doing things (open, go, search, click, type, reply, post, fill, buy) AND looking things up that only exist behind a website or the user\'s own account: their inbox, messages, notifications, orders, calendar, profile, feed, or anything current on a specific site.',
          '',
          'chat — can be answered from general knowledge alone, or is about text already in this conversation.',
          '',
          'Being phrased as a question does NOT make it chat. Examples:',
          '"do I have new messages on LinkedIn?" -> act',
          '"what did Marco reply?" -> act',
          '"any new emails?" -> act',
          '"summarise this page" -> act',
          '"what is the capital of Albania?" -> chat',
          '"rewrite that paragraph more formally" -> chat',
          '',
          'If unsure, answer act.',
        ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `${recent ? recent + '\n' : ''}Request: ${prompt}\nAnswer (act or chat):`,
        },
      ],
      },
      signal,
    );
    const t = extractText(res.content).toLowerCase();
    return t.includes('chat') ? 'chat' : 'act';
  } catch {
    return 'act'; // safe default: keep full capability
  }
}

function waitForTabLoad(tabId: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    function listener(id: number, info: { status?: string }) {
      if (id === tabId && info.status === 'complete') finish();
    }
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish();
      })
      .catch(() => {});
    setTimeout(finish, timeoutMs);
  });
}

// Send an action to a tab's content script, retrying until it's ready.
async function sendAction(
  tabId: number,
  payload: Record<string, unknown>,
  retries = 10,
  frameId = 0,
): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      return await browser.tabs.sendMessage(tabId, payload, { frameId });
    } catch {
      await sleep(350);
    }
  }
  throw new Error('Page not reachable (content script not ready).');
}

// Refs are per-frame, so the model sees them namespaced: "ref_0-12" is ref_12
// in the top frame, "ref_7-3" is ref_3 inside frame 7. Splitting here keeps the
// content script frame-agnostic — it never has to know its own id.
function parseRef(ref: string): { frameId: number; local: string } {
  const m = /^ref_(\d+)-(\d+)$/.exec(String(ref || '').trim());
  if (!m) return { frameId: 0, local: String(ref || '').trim() };
  return { frameId: Number(m[1]), local: `ref_${m[2]}` };
}

// One snapshot per frame, concatenated. Cross-origin iframes are separate
// content-script instances, so this is the only way to see inside them.
async function snapshotAllFrames(tabId: number): Promise<string> {
  let frames: { frameId: number; url: string }[] = [];
  try {
    frames = ((await browser.webNavigation.getAllFrames({ tabId })) ?? []) as typeof frames;
  } catch {
    frames = [{ frameId: 0, url: '' }];
  }
  if (!frames.length) frames = [{ frameId: 0, url: '' }];

  const parts: string[] = [];
  for (const f of frames.slice(0, 12)) {
    let res: any;
    try {
      // Sub-frames may have no content script (about:blank, sandboxed); skip
      // them quietly rather than stalling the whole snapshot on retries.
      res = await sendAction(tabId, { type: 'tidra-action', action: 'snapshot' }, f.frameId === 0 ? 10 : 1, f.frameId);
    } catch {
      continue;
    }
    const data = res?.data as { tree: string; url: string; title: string; truncated: boolean } | undefined;
    if (!data?.tree) continue;
    // Namespace this frame's refs.
    const tree = data.tree.replace(/\[ref_(\d+)\]/g, `[ref_${f.frameId}-$1]`);
    const head =
      f.frameId === 0
        ? `PAGE: ${data.title} — ${data.url}`
        : `\nFRAME ${f.frameId}: ${f.url}`;
    parts.push(`${head}\n${tree}${data.truncated ? '\n(… truncated — scroll or narrow the task)' : ''}`);
  }
  return parts.join('\n') || 'Nothing interactive found on this page.';
}

// Vision fallback: only when the tree isn't enough. Requires the tab to be the
// visible one in its window, which is why routine tabs can't use it.
async function captureTab(tabId: number): Promise<string> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) throw new Error('Screenshots only work on the tab in front.');
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId!, { format: 'jpeg', quality: 60 });
  return dataUrl.replace(/^data:image\/jpeg;base64,/, '');
}

type ToolContent = string | (TextBlock | ImageBlock)[];

async function execTool(
  name: string,
  input: any,
  tabState: TabState,
  // Pressing Enter in a composer sends. That is irreversible, so it is gated in
  // code here — not left to the model remembering a rule in the prompt.
  allowSubmit = false,
): Promise<{ content: ToolContent; isError: boolean }> {
  if ((name === 'fill' || name === 'type_text') && input?.submit && !allowSubmit) {
    return {
      content:
        'Refused: submit=true would send/post this, which is irreversible. Call confirm_action first and wait for the user. If they confirm, you may submit.',
      isError: true,
    };
  }
  try {
    if (name === 'open_url') {
      let url: string = String(input.url || '');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (input.new_tab) {
        const tab = await browser.tabs.create({ url, active: true });
        tabState.tabId = tab.id; // subsequent actions target the new tab
      } else {
        if (tabState.tabId == null) return { content: 'No active tab.', isError: true };
        await browser.tabs.update(tabState.tabId, { url });
      }
      if (tabState.tabId == null) return { content: 'Could not open tab.', isError: true };
      await waitForTabLoad(tabState.tabId);
      await sleep(400);
      const tree = await snapshotAllFrames(tabState.tabId);
      return { content: `Opened ${url}${input.new_tab ? ' (new tab)' : ''}\n\n${tree}`, isError: false };
    }

    if (tabState.tabId == null) return { content: 'No working tab.', isError: true };

    // Extension pages (the new tab, options) and about: pages run no content
    // script, so nothing can be read or clicked there. Say so immediately
    // instead of retrying a message that can never be delivered.
    const current = await browser.tabs.get(tabState.tabId).catch(() => null);
    if (current?.url && !/^https?:/i.test(current.url)) {
      return {
        content: 'There is no web page open in this tab yet. Call open_url first to go to the site.',
        isError: true,
      };
    }

    if (name === 'get_page') {
      const res = await sendAction(tabState.tabId, { type: 'tidra-action', action: 'get_page' });
      const page = res?.data as PageContext;
      return { content: `Title: ${page?.title}\nURL: ${page?.url}\n\n${(page?.text || '').slice(0, 6000)}`, isError: false };
    }
    if (name === 'go_back') {
      await browser.tabs.goBack(tabState.tabId);
      await waitForTabLoad(tabState.tabId);
      await sleep(400);
      return { content: `Went back.\n\n${await snapshotAllFrames(tabState.tabId)}`, isError: false };
    }

    if (name === 'snapshot' || name === 'list_actions') {
      return { content: await snapshotAllFrames(tabState.tabId), isError: false };
    }

    if (name === 'screenshot') {
      const b64 = await captureTab(tabState.tabId);
      return {
        content: [
          { type: 'text', text: 'Screenshot of the visible part of the page:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        ],
        isError: false,
      };
    }

    // Ref-based actions — the primary path.
    if (name === 'click' || name === 'fill' || name === 'select' || name === 'scroll') {
      const { frameId, local } = parseRef(input.ref ?? '');
      const res = await sendAction(
        tabState.tabId,
        {
          type: 'tidra-action',
          action: name,
          ref: input.ref ? local : undefined,
          text: input.text,
          option: input.option,
          submit: !!input.submit,
          direction: input.direction,
          amount: input.amount,
        },
        10,
        input.ref ? frameId : 0,
      );
      return { content: res?.ok ? res.data : res?.error, isError: !res?.ok };
    }
    if (name === 'click_text') {
      const res = await sendAction(tabState.tabId, { type: 'tidra-action', action: 'click_text', text: input.text });
      return { content: res?.ok ? res.data : res?.error, isError: !res?.ok };
    }
    if (name === 'type_text') {
      const res = await sendAction(tabState.tabId, {
        type: 'tidra-action',
        action: 'type_text',
        text: input.text,
        field: input.field,
        submit: !!input.submit,
      });
      return { content: res?.ok ? res.data : res?.error, isError: !res?.ok };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

async function handleAsk(message: AskRequest, senderTabId: number | undefined) {
  const setup = await modelSetup();
  if (!setup) {
    await pushChat('No API key set. Open settings and add a key for your chosen provider.', 'error');
    return;
  }
  const { apiKey, tier } = setup;

  // Build conversation memory from persisted chat so multi-turn flows work
  // (e.g. Tidra drafts an email, user later says "yes, send it").
  const { tidraChat } = await browser.storage.local.get('tidraChat');
  const history = ((tidraChat as ChatState | undefined)?.messages ?? []).filter(
    (m) => m.role !== 'error',
  );

  const messages: Message[] = [];
  history.forEach((m, i) => {
    const isLastUser = i === history.length - 1 && m.role === 'user';
    if (isLastUser) {
      messages.push({
        role: 'user',
        content: [
          `Current page:`,
          `Title: ${message.page.title}`,
          `URL: ${message.page.url}`,
          ``,
          `Page content (truncated):`,
          message.page.text,
          ``,
          `---`,
          `User request: ${m.text}`,
        ].join('\n'),
      });
    } else {
      messages.push({ role: m.role as 'user' | 'assistant', content: m.text });
    }
  });
  // Safety net: if history was empty for some reason, use the incoming prompt.
  if (messages.length === 0) {
    messages.push({ role: 'user', content: message.prompt });
  }

  // The new-tab page may not report a sender tab, and without one every tool
  // fails with "No working tab" — silently, since the new tab isn't rendering
  // the agent's chat. Fall back to whatever tab is in front.
  let workingTabId = senderTabId;
  if (workingTabId == null) {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    workingTabId = active?.id;
  }
  const tabState: TabState = { tabId: workingTabId };
  // The island sends "Confirmed — …" after the user presses the confirm button.
  // Only then may this turn submit anything.
  const userConfirmed = /^Confirmed\s+—/.test(message.prompt.trim());
  // Auto mode: the user has said, up front, to go ahead without asking each
  // time. Manual (the default) stops at every irreversible step.
  const { tidraAuto } = await browser.storage.local.get('tidraAuto');
  const autoMode = tidraAuto === true;
  const mayAct = userConfirmed || autoMode;

  // Cancellation: the UI's Stop button aborts the in-flight request via `currentAbort`.
  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;
  const reqOpts = { signal: abort.signal };

  try {
  // Repeated work over many targets can't run as one conversation — it becomes
  // a durable job instead. Only "act" requests are ever candidates.
  if (message.intent !== 'chat' && (await maybeStartJob(apiKey, tier, message, abort.signal))) {
    await clearLoading();
    return;
  }

  // Decide route: explicit hint (quick actions) or the cheap Haiku router.
  const route: 'chat' | 'act' =
    message.intent ?? (await classify(apiKey, tier.router, message.prompt, history, abort.signal));

  // Attachments ride on the newest user turn. Text files are inlined; images
  // become image blocks, which only the vision model can actually read.
  const attachments = message.attachments ?? [];
  const images = attachments.filter((a) => a.kind === 'image');
  if (attachments.length) {
    const last = messages[messages.length - 1];
    const parts: ContentBlock[] = [];
    const files = attachments.filter((a) => a.kind === 'text');
    if (files.length) {
      parts.push({
        type: 'text',
        text: files
          .map((f) => `Attached file "${f.name}":\n${f.data.slice(0, 20000)}`)
          .join('\n\n'),
      });
    }
    for (const img of images) {
      parts.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
    }
    const existing = typeof last?.content === 'string' ? last.content : '';
    messages[messages.length - 1] = {
      role: 'user',
      content: [...parts, { type: 'text', text: existing }],
    };
  }

  // Chat → cheap model, no tools. Act → stronger model with the browser tools.
  // An attached image forces the vision model — it is the only one that can see
  // it, and it supports tools too, so the agent loop still works.
  const actModel = images.length ? GROQ_MODELS.vision : route === 'act' ? tier.act : tier.chat;
  // The vision fallback is only offered to models that can actually see.
  const tools: any[] = route === 'act' ? TOOLS.filter((t) => t.name !== 'screenshot' || supportsVision(actModel)) : [];

  const profileText = await profilePreamble();
  const modeNote = autoMode
    ? '\n\nAUTO MODE IS ON for this request: the user has already approved irreversible actions in advance. Do not call confirm_action and do not ask — finish the job, including the final click, then report what you did.'
    : '';
  const base = {
    model: actModel,
    max_tokens: 2048,
    system: SYSTEM_PROMPT + profileText + modeNote,
  };

  await setStatus(route === 'act' ? 'Getting started' : 'Thinking');

  const snapshotIds = new Set<string>();
  let guard = 0;
  while (guard++ < 30) {
    const params: any = { ...base, messages };
    if (tools.length) params.tools = tools;
    const response = await callModel(apiKey, params, abort.signal);

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content as any });
      continue;
    }
    if (response.stop_reason !== 'tool_use') {
      await pushChat(extractText(response.content as ContentBlock[]), 'assistant');
      return;
    }

    // Confirmation checkpoint: if Tidra asks to confirm, end the turn and
    // show the Confirm/Cancel bar instead of continuing to click Send.
    const confirmBlock = (response.content as any[]).find(
      (b) => b.type === 'tool_use' && b.name === 'confirm_action',
    );
    // Weaker models sometimes *describe* the confirm tool instead of calling
    // it — as an XML-ish tag, or as a JSON blob of the call. Either way the
    // Confirm bar would never appear and the safety checkpoint would silently
    // not exist, which is the one failure this whole flow is here to prevent.
    // So a printed confirmation is honoured exactly like a real tool call.
    if (!confirmBlock && response.stop_reason !== 'tool_use') {
      const said = extractText(response.content as ContentBlock[]);
      const printed = parsePrintedConfirm(said);
      if (printed) {
        if (autoMode) {
          messages.push({ role: 'assistant', content: said });
          messages.push({
            role: 'user',
            content: 'Approved automatically (auto mode is on). Complete the action now.',
          });
          continue;
        }
        await pushChat(printed.summary, 'assistant');
        await browser.storage.local.set({ tidraPending: { label: printed.label } });
        return;
      }
    }

    if (confirmBlock && !autoMode) {
      const pre = extractText(response.content as ContentBlock[]);
      const summary = confirmBlock.input?.summary || 'Ready. Do you want me to proceed?';
      await pushChat([pre, summary].filter(Boolean).join('\n\n'), 'assistant');
      await browser.storage.local.set({
        tidraPending: { label: confirmBlock.input?.confirm_label || 'Send' },
      });
      return;
    }
    // Auto mode: approve it ourselves and let the same turn carry on, rather
    // than making the model ask a question nobody is going to answer.
    if (confirmBlock) {
      messages.push({ role: 'assistant', content: response.content as any });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: confirmBlock.id,
            content: 'Approved automatically (auto mode is on). Go ahead and complete the action now.',
          },
        ],
      });
      continue;
    }

    messages.push({ role: 'assistant', content: response.content as any });

    const toolResults: ToolResultBlock[] = [];
    for (const block of response.content as any[]) {
      if (block.type !== 'tool_use') continue;
      await setStatus(statusFor(block.name, block.input));
      const result = await execTool(block.name, block.input, tabState, mayAct);
      if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }
    if (toolResults.length === 0) {
      await pushChat(extractText(response.content as ContentBlock[]), 'assistant');
      return;
    }
    messages.push({ role: 'user', content: toolResults });
    pruneOldSnapshots(messages, snapshotIds);
  }

  await pushChat(
    "I ran out of steps before finishing. Tell me what's left and I'll carry on, or break it into smaller pieces.",
    'assistant',
  );
  } catch (err) {
    if (abort.signal.aborted) {
      await setStatus(null);
      await clearLoading(); // user pressed Stop — end quietly, no error bubble
      return;
    }
    throw err;
  } finally {
    if (currentAbort === abort) currentAbort = null;
    await setStatus(null);
  }
}

// ─── Routine execution ──────────────────────────────────────────────────────
// "Start routine" runs each learned site's saved task, in the background, on a
// hidden tab — drafting/preparing only, never sending, and reporting back.

const ROUTINE_SYSTEM = `You are Tidra, running one step of the user's saved routine on a website — in the background, on their behalf.

Do exactly what the task describes, using the page. Be decisive and take the needed steps (open the composer, read the thread, write a draft, etc.).

Use snapshot() to see the page's interactive elements — each carries a ref like ref_0-12 — then click(ref) / fill(ref, text). Refs go stale whenever the page changes, so snapshot again after anything that navigates or re-renders. Every action reports what changed; if it says "no visible change", it did not work.

HARD RULES:
- NEVER send, post, submit, publish, buy, or delete anything. Only prepare/draft and leave it for the user to review later.
- Do not ask the user questions — do your best with what's on the page.
- When finished, reply with a SHORT report: 1–3 sentences or a few bullets of what you found or drafted. No preamble.
- Base everything strictly on the actual page content — never invent.`;

const ROUTINE_TASK_DEFAULTS: Record<string, string> = {
  'mail.google.com': 'Check for new important emails and draft replies I can review before sending.',
  'linkedin.com': 'Check new messages and notifications, and summarize anything that needs a response.',
  'github.com': 'Check my notifications and open pull requests, and summarize what needs my attention.',
  'calendar.google.com': "Summarize today's meetings and what I should prepare.",
  'x.com': 'Summarize the top posts from the people I follow.',
  'twitter.com': 'Summarize the top posts from the people I follow.',
  'notion.so': 'Summarize what changed in my workspace since I last checked.',
  'www.youtube.com': 'List the new videos from channels I follow.',
};
function defaultTaskFor(domain: string): string {
  return ROUTINE_TASK_DEFAULTS[domain] ?? "Look at this page and tell me what's new or needs my attention.";
}

async function getPageOf(tabId: number): Promise<PageContext> {
  const res = await sendAction(tabId, { type: 'tidra-action', action: 'get_page' });
  return (res?.data as PageContext) || { title: '', url: '', text: '' };
}

// Run one site's task to completion and return Tidra's short report.
async function runSiteAgent(
  apiKey: string,
  actModel: string,
  task: string,
  tabId: number,
  profileText = '',
): Promise<string> {
  const tabState: TabState = { tabId };
  const page = await getPageOf(tabId);
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        `Routine task: ${task}`,
        ``,
        `Current page:`,
        `Title: ${page.title}`,
        `URL: ${page.url}`,
        ``,
        `Page content (truncated):`,
        (page.text || '').slice(0, 8000),
      ].join('\n'),
    },
  ];
  // No confirm_action / open_url — routine tasks stay on the opened tab and never
  // send. Screenshots need vision, and a background tab can't be captured anyway.
  const tools = TOOLS.filter(
    (t) => !['confirm_action', 'open_url', 'screenshot', 'go_back'].includes(t.name),
  );
  const snapshotIds = new Set<string>();
  let guard = 0;
  while (guard++ < 24) {
    const res = await callModel(apiKey, {
      model: actModel,
      max_tokens: 1500,
      system: ROUTINE_SYSTEM + profileText,
      messages,
      tools,
    });
    if (res.stop_reason !== 'tool_use') {
      return extractText(res.content as ContentBlock[]) || 'Done.';
    }
    messages.push({ role: 'assistant', content: res.content as any });
    const toolResults: ToolResultBlock[] = [];
    for (const block of res.content as any[]) {
      if (block.type !== 'tool_use') continue;
      // No allowSubmit: a background routine drafts, never sends.
      const r = await execTool(block.name, block.input, tabState);
      if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError });
    }
    if (!toolResults.length) return extractText(res.content as ContentBlock[]) || 'Done.';
    messages.push({ role: 'user', content: toolResults });
    pruneOldSnapshots(messages, snapshotIds);
  }
  return 'Stopped after too many steps.';
}

let routineRunning = false;
async function runRoutine() {
  if (routineRunning) return;
  routineRunning = true;
  try {
    const store = await browser.storage.local.get([
      'tidraVisits',
      'tidraRoutineHidden',
      'tidraRoutineTasks',
      'tidraRoutineManual',
    ]);
    const setup = await modelSetup();
    if (!setup) {
      await pushChat('No API key set. Open settings and add a key for your chosen provider.', 'error');
      return;
    }
    const { apiKey, tier } = setup;
    const visits = (store.tidraVisits as Visit[]) || [];
    const hidden = new Set((store.tidraRoutineHidden as string[]) || []);
    const manual = (store.tidraRoutineManual as { domain: string; url: string }[]) || [];
    // Learned routine + manually-added sites, de-duplicated, minus removed ones.
    const seen = new Set<string>();
    const sites = [...detectRoutine(visits), ...manual].filter((s) => {
      if (hidden.has(s.domain) || seen.has(s.domain)) return false;
      seen.add(s.domain);
      return true;
    });
    const tasks = (store.tidraRoutineTasks as Record<string, string>) || {};
    if (!sites.length) {
      await pushChat("You have no learned routine yet, so there's nothing to run.", 'assistant');
      return;
    }

    const profileText = await profilePreamble();
    await browser.storage.local.set({ tidraOpen: true });
    await pushChat(
      `Running your routine across ${sites.length} site${sites.length > 1 ? 's' : ''} — I'll draft, never send, and report back.`,
      'assistant',
    );

    for (const site of sites) {
      const name = prettyDomain(site.domain);
      const task = (tasks[site.domain] || defaultTaskFor(site.domain)).trim();
      try {
        const tab = await browser.tabs.create({ url: site.url, active: false });
        if (tab.id == null) {
          await pushChat(`**${name}** — couldn't open the tab.`, 'error');
          continue;
        }
        await waitForTabLoad(tab.id);
        await sleep(700);
        const report = await runSiteAgent(apiKey, tier.act, task, tab.id, profileText);
        await pushChat(`**${name}**\n${report}`, 'assistant');
      } catch (err) {
        await pushChat(`**${name}** — ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    }
    await pushChat('✅ Routine finished. Review the drafts in the tabs I opened before sending anything.', 'assistant');
  } finally {
    routineRunning = false;
  }
}

// ─── Batch jobs ─────────────────────────────────────────────────────────────
// "Send 10 connection requests", "write 1000 emails". One agent conversation
// cannot do this: the step budget runs out, the context grows without bound,
// and the service worker is killed long before item 1000. So the model stops
// being the orchestrator and becomes a per-item function — deterministic code
// owns the loop, and the loop's state lives in storage (see lib/jobs.ts).
//
// Shape of a run:
//   plan  → one cheap call: is this a batch, and what is ONE item?
//   collect → build the real work list (from an attachment, or off the page)
//   approve → show the count, the cost, and a real drafted sample
//   pump  → one item per turn, each claimed and settled on its own
//   report → what landed, what failed, what needs eyes

const JOB_ALARM = 'tidra-job-tick';
/** A pump that hasn't touched its job in this long is presumed dead. */
const BEAT_STALE_MS = 90_000;

/** Cheap prefilter, so an ordinary message never pays for a planner call. */
function looksBatch(prompt: string): boolean {
  const p = prompt.toLowerCase();
  if (/^confirmed\s+—/.test(p.trim())) return false;
  if (/\b(all|each|every|everyone|everybody|bulk|mass)\b/.test(p)) return true;
  // A standalone count of 3 or more: "send 10 …", "write 1000 emails".
  return /\b([3-9]|\d{2,})\b/.test(p);
}

interface JobPlan {
  batch: boolean;
  count?: number;
  task?: string;
  site?: string;
  source?: 'attachment' | 'page' | 'prompt' | 'unknown';
  irreversible?: boolean;
  labels?: string[];
  missing?: string;
}

/** Pull the first JSON object out of a reply that may be wrapped in prose. */
function extractJson<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const PLANNER_SYSTEM = `You split a user's request into a repeated unit of work, if it is one. Reply with JSON only — no prose, no code fence.

{
  "batch": true | false,
  "count": <how many times, best estimate; 0 if unknown>,
  "task": "<the instruction for ONE item, written so it reads correctly with that item's details appended>",
  "site": "<https:// URL where the work happens, or omit>",
  "source": "attachment" | "page" | "prompt" | "unknown",
  "irreversible": true | false,
  "labels": ["<item>", "..."],
  "missing": "<one short question, only when source is unknown>"
}

batch is true only for genuinely repeated work over MULTIPLE targets (3 or more). A single multi-step task ("book a flight", "reply to this email") is NOT a batch — it is one item, so batch is false.

source — where the list of targets comes from:
- "attachment": the user attached a file holding the list (a CSV of recipients, etc).
- "page": the targets are on a website and must be collected from it first (people in a LinkedIn list, emails in an inbox, rows in a dashboard).
- "prompt": the user named every target themselves; put them in "labels".
- "unknown": there is no list anywhere. NEVER invent the targets — set "missing" to the one question that would produce them.

irreversible is true when finishing ONE item sends, posts, submits, buys, applies for, connects, or deletes something. Drafting, saving, reading and collecting are not irreversible.`;

async function planJob(
  apiKey: string,
  model: string,
  prompt: string,
  page: PageContext,
  hasAttachment: boolean,
  signal?: AbortSignal,
): Promise<JobPlan | null> {
  try {
    const res = await callModel(
      apiKey,
      {
        model,
        max_tokens: 700,
        system: PLANNER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              `Request: ${prompt}`,
              `Current page: ${page.title} — ${page.url}`,
              hasAttachment ? 'The user attached a file with this message.' : 'No file attached.',
            ].join('\n'),
          },
        ],
      },
      signal,
    );
    return extractJson<JobPlan>(extractText(res.content));
  } catch {
    return null; // planning is an optimisation — never block the normal path on it
  }
}

const RECORD_ITEMS: Tool = {
  name: 'record_items',
  description:
    'Write down the list of things to work through, once you can see all of them. Call this exactly once, then stop.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One entry per target, in the order they should be handled.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'How a human identifies it — a name, an email, a subject line.' },
            url: { type: 'string', description: 'Direct link to this item, if the page gives one.' },
            note: { type: 'string', description: 'Anything about this item the task will need (role, company, context).' },
          },
          required: ['label'],
        },
      },
    },
    required: ['items'],
  },
};

const COLLECT_SYSTEM = `You are Tidra, building a work list before a batch runs. Your ONLY job right now is to find the targets and write them down — do not act on any of them.

Use snapshot() to read the page, scroll() and a fresh snapshot to reach ones that are offscreen or lazily loaded, and get_page() to read text. Keep going until you can see the number asked for, or until the page has no more to give.

Then call record_items once with everything you found, in page order. Never invent an entry, and never pad the list to hit the number — fewer real targets is correct, made-up ones are not.`;

/** Walk the site and let the model write down the actual targets. */
async function collectItems(
  apiKey: string,
  model: string,
  job: Job,
  want: number,
  tabId: number,
): Promise<{ label: string; key: string; data: Record<string, string> }[]> {
  const tabState: TabState = { tabId };
  const tools = [
    ...TOOLS.filter((t) => ['snapshot', 'scroll', 'get_page', 'click_text', 'go_back'].includes(t.name)),
    RECORD_ITEMS,
  ];
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        `The user asked: ${job.goal}`,
        ``,
        `Find the ${want > 0 ? want : ''} targets this applies to on this page and record them.`,
        `Each item will later be handled with: ${job.task}`,
        ``,
        await snapshotAllFrames(tabId),
      ].join('\n'),
    },
  ];

  const snapshotIds = new Set<string>();
  let guard = 0;
  while (guard++ < 16) {
    const res = await callModel(apiKey, { model, max_tokens: 2000, system: COLLECT_SYSTEM, messages, tools });
    if (res.stop_reason !== 'tool_use') return [];

    const recorded = (res.content as any[]).find((b) => b.type === 'tool_use' && b.name === 'record_items');
    if (recorded) {
      const raw = Array.isArray(recorded.input?.items) ? recorded.input.items : [];
      return raw.slice(0, MAX_ITEMS).map((r: any) => {
        const label = String(r?.label ?? '').trim();
        const data: Record<string, string> = {};
        if (r?.url) data.url = String(r.url);
        if (r?.note) data.note = String(r.note);
        return { label, key: (r?.url ? String(r.url) : label).toLowerCase(), data };
      });
    }

    messages.push({ role: 'assistant', content: res.content as any });
    const results: ToolResultBlock[] = [];
    for (const block of res.content as any[]) {
      if (block.type !== 'tool_use') continue;
      await setStatus('Building the list');
      const r = await execTool(block.name, block.input, tabState);
      if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError });
    }
    if (!results.length) return [];
    messages.push({ role: 'user', content: results });
    pruneOldSnapshots(messages, snapshotIds);
  }
  return [];
}

const FINISH_ITEM: Tool = {
  name: 'finish_item',
  description:
    'End your work on this ONE item. Call it as soon as the item is complete, or as soon as you are certain it cannot be done.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['done', 'failed', 'skipped'],
        description: 'done = finished. failed = tried and could not. skipped = it should not be done at all.',
      },
      result: { type: 'string', description: 'One line: what you did, or why you could not.' },
    },
    required: ['status', 'result'],
  },
};

const JOB_ITEM_SYSTEM = `You are Tidra, working through a long list of near-identical tasks. This turn handles exactly ONE item and nothing else.

You are on a tab opened for this job. Ignore everything on the page that belongs to other items — do not wander, do not "helpfully" handle the next one, do not summarise the list.

Use snapshot() to see the page's interactive elements (refs like ref_0-12), then click(ref) / fill(ref, text). Refs go stale whenever the page changes, so snapshot again after anything that navigates or re-renders. Every action reports what changed; "no visible change" means it did not work — try something else rather than continuing as if it had.

Write real content that fits this specific item. It is one of many, but the person receiving it only ever sees this one, so it must not read as a form letter — use the item's own details.

Work fast and finish: you have a small step budget per item. Call finish_item as soon as this item is complete, or as soon as you are sure it cannot be done. Do not ask the user questions — there is nobody watching an individual item.`;

const JOB_SAMPLE_RULE = `\n\nTHIS ITEM IS THE SAMPLE. Draft everything, then STOP before the irreversible step — do not click Send/Post/Submit/Connect. Call confirm_action with a summary that QUOTES what you drafted, so the user can approve this one and the rest of the batch from it.`;

const JOB_APPROVED_RULE = `\n\nThe user has already approved this batch, including the final send. Complete the item all the way — click the Send/Post/Submit button yourself. Do not call confirm_action.`;

/** Run one item to completion in the job's tab. */
async function runJobItem(
  apiKey: string,
  model: string,
  job: Job,
  item: JobItem,
  profileText: string,
): Promise<{ status: 'done' | 'failed' | 'review'; result: string; sample?: string }> {
  const tabId = job.tabId!;
  const tabState: TabState = { tabId };

  // Deterministic setup: put the tab where the item starts before the model
  // gets a turn. This is a step the model no longer has to spend, times N.
  const start = item.data?.url || job.site;
  if (start) {
    try {
      await browser.tabs.update(tabId, { url: start });
      await waitForTabLoad(tabId);
      await sleep(400);
    } catch {
      return { status: 'failed', result: `Could not open ${start}` };
    }
  }

  const details = Object.entries(item.data ?? {})
    .filter(([k]) => k !== 'url')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const messages: Message[] = [
    {
      role: 'user',
      content: [
        `Item ${item.i + 1} of ${job.total}: ${item.label}`,
        details ? `\nWhat is known about it:\n${details}` : '',
        `\nTask for this item: ${job.task}`,
        `\nThe wider goal, for context only: ${job.goal}`,
        ``,
        await snapshotAllFrames(tabId),
      ].join('\n'),
    },
  ];

  const sampling = job.irreversible && !job.approved;
  const tools = [
    ...TOOLS.filter((t) => {
      if (t.name === 'screenshot') return false; // a background tab cannot be captured
      if (t.name === 'confirm_action') return sampling;
      return true;
    }),
    FINISH_ITEM,
  ];
  const system =
    JOB_ITEM_SYSTEM + profileText + (sampling ? JOB_SAMPLE_RULE : job.approved ? JOB_APPROVED_RULE : '');

  const snapshotIds = new Set<string>();
  let guard = 0;
  while (guard++ < job.stepsPerItem) {
    const res = await callModel(apiKey, { model, max_tokens: 1600, system, messages, tools });

    if (res.stop_reason !== 'tool_use') {
      // Ended with prose. Treat it as the outcome rather than losing the work.
      return { status: 'done', result: extractText(res.content as ContentBlock[]).slice(0, 300) || 'Done.' };
    }

    const blocks = res.content as any[];
    const confirm = blocks.find((b) => b.type === 'tool_use' && b.name === 'confirm_action');
    if (confirm) {
      const pre = extractText(res.content as ContentBlock[]);
      const summary = confirm.input?.summary || pre || 'Ready to go.';
      return { status: 'review', result: 'Drafted, waiting for approval.', sample: summary };
    }

    const finish = blocks.find((b) => b.type === 'tool_use' && b.name === 'finish_item');
    if (finish) {
      const status = finish.input?.status === 'done' ? 'done' : 'failed';
      return { status, result: String(finish.input?.result ?? '').slice(0, 300) || 'Done.' };
    }

    messages.push({ role: 'assistant', content: blocks as any });
    const results: ToolResultBlock[] = [];
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      await setStatus(`${job.done + 1}/${job.total} · ${item.label.slice(0, 28)}`);
      const r = await execTool(block.name, block.input, tabState, job.approved);
      if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError });
    }
    if (!results.length) {
      return { status: 'done', result: extractText(res.content as ContentBlock[]).slice(0, 300) || 'Done.' };
    }
    messages.push({ role: 'user', content: results });
    pruneOldSnapshots(messages, snapshotIds);
  }

  // Out of steps on ONE item. That is a stuck item, not a stuck job — the rest
  // of the list is unaffected, which is the entire point of the per-item budget.
  return { status: 'failed', result: `Ran out of steps on this one after ${job.stepsPerItem} tries.` };
}

/** The job's own tab, so a long run never fights the user for the page in front. */
async function ensureJobTab(job: Job): Promise<number> {
  if (job.tabId != null) {
    const tab = await browser.tabs.get(job.tabId).catch(() => null);
    if (tab?.id != null) return tab.id;
  }
  const tab = await browser.tabs.create({ url: job.site || 'about:blank', active: false });
  if (tab.id == null) throw new Error('Could not open a tab for the job.');
  job.tabId = tab.id;
  await waitForTabLoad(tab.id);
  await saveJob(job);
  return tab.id;
}

async function setJobState(job: Job, state: Job['state']): Promise<Job> {
  job.state = state;
  await saveJob(job);
  return job;
}

/**
 * The pump. Runs items back-to-back while the worker is alive, re-reading the
 * job each lap so Pause and Cancel from the UI take effect immediately. If the
 * worker dies mid-run, the watchdog alarm restarts this within a minute.
 */
let pumping = false;
async function pumpJob(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const setup = await modelSetup();
    if (!setup) {
      // Park the job rather than returning: the watchdog would otherwise wake
      // every minute forever, retrying something that cannot succeed, silently.
      const stalled = await loadJob();
      if (stalled) {
        await setJobState(stalled, 'paused');
        await browser.alarms.clear(JOB_ALARM).catch(() => {});
        await pushChat('The batch is paused — there is no API key set. Add one in settings and press Resume.', 'error');
      }
      return;
    }
    const profileText = await profilePreamble();

    for (;;) {
      let job = await loadJob();
      if (!job || job.state !== 'running') return;

      const item = await claimNext(job);
      if (!item) {
        if (await retrySweep(job)) continue; // one sweep over reversible failures
        await finishJob(job);
        return;
      }

      await ensureJobTab(job);
      let outcome: { status: 'done' | 'failed' | 'review'; result: string; sample?: string };
      try {
        outcome = await runJobItem(setup.apiKey, setup.tier.act, job, item, profileText);
      } catch (err) {
        outcome = { status: 'failed', result: err instanceof Error ? err.message : String(err) };
      }

      // The sample came back drafted, not sent — park the job on the user.
      if (outcome.sample) {
        job.sample = outcome.sample;
        await requeue(job, item); // nothing was sent, so this item is untouched work
        await setJobState(job, 'sampling');
        await pushChat(
          `${outcome.sample}\n\nThis is item 1 of ${job.total}. Approve it and I'll run the remaining ${job.total - 1} the same way.`,
          'assistant',
        );
        await setStatus(null);
        return;
      }

      await settle(job, item, outcome.status, outcome.result);
      const after = await loadJob();
      if (!after || after.state !== 'running') return;
      if (job.throttleMs) await sleep(job.throttleMs);
    }
  } finally {
    pumping = false;
  }
}

/** Final report: counts first, then the handful of things that need a human. */
async function finishJob(job: Job): Promise<void> {
  job.state = 'done';
  job.finishedAt = Date.now();
  job.current = undefined;
  await saveJob(job);
  await browser.alarms.clear(JOB_ALARM).catch(() => {});

  const items = await allItems(job);
  const failed = items.filter((i) => i.state === 'failed');
  const review = items.filter((i) => i.state === 'review');
  const lines = [`✅ Finished — ${job.done} of ${job.total} done.`];
  if (failed.length) {
    lines.push(
      `\n**${failed.length} failed:**\n` +
        failed.slice(0, 8).map((i) => `- ${i.label} — ${i.result ?? 'no reason recorded'}`).join('\n') +
        (failed.length > 8 ? `\n- …and ${failed.length - 8} more` : ''),
    );
  }
  if (review.length) {
    lines.push(
      `\n**${review.length} need checking** (interrupted mid-action, so I won't retry them):\n` +
        review.slice(0, 8).map((i) => `- ${i.label}`).join('\n') +
        (review.length > 8 ? `\n- …and ${review.length - 8} more` : ''),
    );
  }
  await pushChat(lines.join('\n'), 'assistant');
  await setStatus(null);
}

/**
 * Decide whether a request is a batch and, if so, take it over. Returns true
 * when the job path has claimed the request — the normal agent never runs.
 */
async function maybeStartJob(
  apiKey: string,
  tier: { chat: string; act: string; router: string },
  message: AskRequest,
  signal: AbortSignal,
): Promise<boolean> {
  if (!looksBatch(message.prompt)) return false;
  const existing = await loadJob();
  if (existing && ['collecting', 'sampling', 'running', 'paused'].includes(existing.state)) return false;
  // A finished job the user never dismissed still owns its item chunks. Drop
  // them here or every batch ever run stays in storage forever.
  if (existing) await clearJob(existing);

  const textFiles = (message.attachments ?? []).filter((a) => a.kind === 'text');
  const plan = await planJob(apiKey, tier.act, message.prompt, message.page, textFiles.length > 0, signal);
  if (!plan?.batch || !plan.task) return false;

  // No list, and no way to get one. Asking beats inventing 1000 addresses.
  if (plan.source === 'unknown') {
    await pushChat(
      plan.missing?.trim() ||
        'I can run that as a batch, but I need the list first — attach a CSV, or point me at the page the targets are on.',
      'assistant',
    );
    return true;
  }

  const job = newJob({
    goal: message.prompt,
    task: plan.task,
    site: plan.site || (/^https?:/i.test(message.page.url) ? message.page.url : undefined),
    irreversible: plan.irreversible !== false,
  });
  await saveJob(job);
  await setStatus('Building the list');

  // Build the work list. Where it comes from decides how much this costs: a
  // file or an enumerated prompt is free, a page costs one collection turn.
  let items: { label: string; key: string; data: Record<string, string> }[] = [];
  if (plan.source === 'attachment' && textFiles.length) {
    items = textFiles.flatMap((f) => itemsFromCsv(f.data));
  } else if (plan.source === 'prompt' && plan.labels?.length) {
    items = plan.labels.map((l) => ({ label: String(l), key: String(l).toLowerCase(), data: {} }));
  } else {
    const tabId = await ensureJobTab(job);
    if (job.site) {
      await browser.tabs.update(tabId, { url: job.site }).catch(() => {});
      await waitForTabLoad(tabId);
      await sleep(500);
    }
    items = await collectItems(apiKey, tier.act, job, plan.count ?? 0, tabId);
  }

  if (!items.length) {
    await clearJob(job);
    await pushChat(
      "I couldn't build the list for that — I didn't find the targets on the page, and nothing was attached. Point me at the right page, or attach a CSV, and I'll run it.",
      'assistant',
    );
    await setStatus(null);
    return true;
  }

  await setItems(job, items);
  await setJobState(job, 'sampling');

  const est = estimate(job);
  const cost = est.dollars < 0.01 ? 'under a cent' : `about $${est.dollars.toFixed(2)}`;
  await pushChat(
    [
      `**${job.total} item${job.total === 1 ? '' : 's'}** to work through: ${items
        .slice(0, 3)
        .map((i) => i.label)
        .join(', ')}${job.total > 3 ? `, +${job.total - 3} more` : ''}.`,
      ``,
      `Each one: ${job.task}`,
      ``,
      `Roughly ${humanDuration(est.minutes)} and ${cost} in model usage.` +
        (job.irreversible ? " I'll draft the first one and show it to you before anything is sent." : ''),
    ].join('\n'),
    'assistant',
  );
  await setStatus(null);
  return true;
}

/** Start (or restart) the pump, with the watchdog alarm behind it. */
async function startPump(job: Job): Promise<void> {
  job.state = 'running';
  job.startedAt ??= Date.now();
  job.beat = Date.now();
  await saveJob(job);
  // The alarm is a resurrection mechanism, not the clock: alarms are clamped to
  // minutes, and 1000 items at a minute each would take a week. The pump runs
  // flat out in memory; the alarm only matters if the worker is killed.
  browser.alarms.create(JOB_ALARM, { periodInMinutes: 1 });
  void pumpJob();
}

/** Watchdog: did a pump die holding the job? */
async function jobWatchdog(): Promise<void> {
  const job = await loadJob();
  if (!job) {
    await browser.alarms.clear(JOB_ALARM).catch(() => {});
    return;
  }
  if (job.state !== 'running') return;
  // `pumping` is per worker instance: if this worker has a live pump, the job
  // is fine and a second pump would double-run items. If the flag is false
  // while the job says "running", the worker that owned it is gone.
  if (pumping) return;
  if (Date.now() - (job.beat ?? 0) < BEAT_STALE_MS) return; // a fresh start still settling
  await reconcile(job);
  void pumpJob();
}

async function handleJobControl(action: string): Promise<void> {
  const job = await loadJob();
  if (!job) return;

  if (action === 'start' || action === 'approve') {
    // "approve" is the user signing off on the drafted sample — from here the
    // batch may complete its own sends. Manual mode gets the draft first; auto
    // mode said up front that it doesn't want to be asked.
    const { tidraAuto } = await browser.storage.local.get('tidraAuto');
    if (action === 'approve' || tidraAuto === true || !job.irreversible) {
      job.approved = true;
      job.sample = undefined;
    }
    await startPump(job);
    return;
  }
  if (action === 'pause') {
    job.current = undefined;
    await setJobState(job, 'paused');
    await setStatus(null);
    await browser.alarms.clear(JOB_ALARM).catch(() => {});
    return;
  }
  if (action === 'resume') {
    await reconcile(job);
    await startPump(job);
    return;
  }
  if (action === 'cancel') {
    await setJobState(job, 'cancelled');
    await browser.alarms.clear(JOB_ALARM).catch(() => {});
    await setStatus(null);
    if (job.tabId != null) browser.tabs.remove(job.tabId).catch(() => {});
    await pushChat(
      job.done ? `Stopped. ${job.done} of ${job.total} were done before I stopped.` : 'Stopped — nothing was sent.',
      'assistant',
    );
    await clearJob(job);
    return;
  }
  if (action === 'dismiss') {
    await clearJob(job);
  }
}

// ─── Voice input ────────────────────────────────────────────────────────────
// The island can't hold a microphone — it's a content script, so getUserMedia
// there belongs to whatever site it's sitting on. The offscreen document does
// the listening at the extension's own origin; this is just the relay.

const OFFSCREEN_PATH = 'offscreen.html';
let offscreenReady: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // Creating one twice throws, and the worker can restart at any time, so the
  // in-flight promise is cached rather than a boolean.
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    if (!(browser as any).offscreen) throw new Error('offscreen-unsupported');
    const existing = await (browser.runtime as any).getContexts?.({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existing?.length) return;
    try {
      await (browser as any).offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Record the microphone so the user can talk to Tidra instead of typing.',
      });
    } catch (err) {
      // A worker that restarted while the document survived lands here on
      // browsers without getContexts. The document is what we wanted anyway.
      if (!/single offscreen|already exists/i.test(String(err))) throw err;
    }
  })().catch((err) => {
    offscreenReady = null; // let the next attempt try again
    throw err;
  });
  return offscreenReady;
}

/**
 * Which island asked to listen, kept IN STORAGE rather than in a variable.
 *
 * This looks like over-engineering and isn't. Between "start listening" and the
 * words coming back, this worker has nothing to do — and a worker with nothing
 * to do is killed within ~30 seconds. It then restarts to handle the result
 * with every variable reset, so an in-memory id would be null exactly when it
 * was needed, the island would reject its own transcript as belonging to
 * someone else, and the mic would never reset. Storage outlives the worker.
 */
async function voiceRelay(action: string, sid?: string): Promise<any> {
  if (action === 'start') await browser.storage.local.set({ tidraVoiceSid: sid ?? null });
  await ensureOffscreen();
  // createDocument resolves once the document exists, which is not the same as
  // its module script having run and registered a listener. A message that
  // arrives in that gap fails with "receiving end does not exist" — so give the
  // page a moment and try again rather than reporting a broken microphone.
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      return await browser.runtime.sendMessage({ type: 'tidra-voice-offscreen', action });
    } catch (err) {
      lastErr = err;
      if (!/receiving end|establish connection/i.test(String(err))) throw err;
      await sleep(120);
    }
  }
  throw lastErr;
}

/** Offscreen finished (or gave up). Publish it for the island that asked. */
async function publishVoice(msg: { state?: string; text?: string; error?: string }): Promise<void> {
  const { tidraVoiceSid } = await browser.storage.local.get('tidraVoiceSid');
  const sid = (tidraVoiceSid as string | null) ?? null;
  await browser.storage.local.set({
    tidraVoice: { sid, state: msg.state ?? 'idle', error: msg.error },
    // Only stamp heard text when there is some — an empty result should leave
    // the last thing the user said alone.
    ...(msg.text ? { tidraHeard: { sid, text: msg.text, ts: Date.now() } } : {}),
  });
}

export default defineBackground(() => {
  // A worker that was killed mid-job comes back here. Anything left `doing` is
  // judged before a single new item starts.
  void (async () => {
    const job = await loadJob();
    if (job?.state === 'running') {
      await reconcile(job);
      void pumpJob();
    }
  })();

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === JOB_ALARM) void jobWatchdog();
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-island') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      browser.tabs.sendMessage(tab.id, { type: 'tidra-toggle' }).catch(() => {});
    }
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'tidra-ask') {
      handleAsk(message as AskRequest, sender.tab?.id)
        .catch((err: unknown) => pushChat(err instanceof Error ? err.message : String(err), 'error'))
        .finally(() => sendResponse({ ok: true }));
      return true; // keep the worker alive for the async work
    }
    // The new tab asks which kind of request this is: something it can answer
    // inline, or something that needs the browser (and so needs the agent).
    if (message?.type === 'tidra-route' && typeof message.prompt === 'string') {
      (async () => {
        const setup = await modelSetup();
        if (!setup) return sendResponse({ route: 'chat' });
        const route = await classify(setup.apiKey, setup.tier.router, message.prompt, []);
        sendResponse({ route });
      })().catch(() => sendResponse({ route: 'chat' }));
      return true;
    }
    // Voice input: the island asks to listen. What it HEARD comes back later,
    // through storage, because the mic usually closes itself.
    if (message?.type === 'tidra-voice' && typeof message.action === 'string') {
      voiceRelay(message.action, message.sid)
        .then((res) => sendResponse(res ?? { ok: false, error: 'no-response' }))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      return true; // async response
    }
    if (message?.type === 'tidra-voice-result') {
      publishVoice(message).catch(() => {});
      return;
    }
    // Transcribe a clip recorded inside a page. The content script can't call
    // Groq itself — no cross-origin privileges under MV3, and the site's CSP
    // governs the request — so the audio comes here instead.
    if (message?.type === 'tidra-transcribe' && typeof message.audio === 'string') {
      (async () => {
        const { tidraGroqKey } = await browser.storage.local.get('tidraGroqKey');
        if (!tidraGroqKey) return sendResponse({ ok: false, error: 'no-key' });
        try {
          const clip = base64ToBlob(message.audio, message.mime || 'audio/webm');
          sendResponse({ ok: true, text: await transcribe(tidraGroqKey as string, clip) });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true; // async response
    }
    // Batch job controls from the island: start / approve / pause / resume /
    // cancel / dismiss.
    if (message?.type === 'tidra-job' && typeof message.action === 'string') {
      handleJobControl(message.action)
        .catch((err) => pushChat(err instanceof Error ? err.message : String(err), 'error'))
        .finally(() => sendResponse({ ok: true }));
      return true; // keep the worker alive for the async work
    }
    if (message?.type === 'tidra-stop') {
      currentAbort?.abort(); // cancel the in-flight API request
      clearLoading().catch(() => {}); // reset the UI (storage change re-renders)
      return;
    }
    if (message?.type === 'tidra-visit' && typeof message.domain === 'string') {
      handleVisit(message.domain).catch(() => {});
      return;
    }
    if (message?.type === 'tidra-open-routine') {
      browser.storage.local.get('tidraRoutine').then(({ tidraRoutine }) => {
        const sites = (tidraRoutine as { sites?: { url: string }[] } | undefined)?.sites ?? [];
        sites.forEach((s) => browser.tabs.create({ url: s.url, active: false }).catch(() => {}));
        browser.storage.local.set({ tidraRoutine: null });
      });
      return;
    }
    if (message?.type === 'tidra-open-options') {
      browser.runtime.openOptionsPage();
    }
    // Return the currently-learned routine (freshly computed), minus any sites
    // the user has removed. Used by the new-tab "Your routine" panel.
    if (message?.type === 'tidra-get-routine') {
      (async () => {
        const store = await browser.storage.local.get([
          'tidraVisits',
          'tidraRoutineHidden',
          'tidraRoutineEnabled',
        ]);
        const enabled = store.tidraRoutineEnabled !== false;
        const visits = (store.tidraVisits as Visit[]) || [];
        const hidden = new Set((store.tidraRoutineHidden as string[]) || []);
        const sites = detectRoutine(visits).filter((s) => !hidden.has(s.domain));
        sendResponse({ enabled, sites });
      })();
      return true; // async response
    }
    // Run the whole routine in the background (draft-only, reports into the chat).
    if (message?.type === 'tidra-run-routine') {
      runRoutine()
        .catch((err) => pushChat(err instanceof Error ? err.message : String(err), 'error'))
        .finally(() => sendResponse({ ok: true }));
      return true; // keep the worker alive for the async work
    }
  });
});
