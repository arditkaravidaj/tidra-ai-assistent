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
    // Weaker models sometimes *describe* the confirm tool instead of calling it,
    // emitting "<confirm_action summary=... />" as plain text. That would leave
    // the safety gate silently absent, so treat it as if the tool had been
    // called: parse the summary out and stop the turn.
    if (!confirmBlock && response.stop_reason !== 'tool_use') {
      const said = extractText(response.content as ContentBlock[]);
      const fake = /<\s*confirm[_\s]?action\b([^>]*)>/i.exec(said);
      if (fake) {
        const summary =
          /summary\s*=\s*"([^"]+)"/i.exec(fake[1])?.[1] ||
          said.replace(fake[0], '').trim() ||
          'Ready. Do you want me to proceed?';
        const label = /label\s*=\s*"([^"]+)"/i.exec(fake[1])?.[1] || 'Confirm';
        if (autoMode) {
          messages.push({ role: 'assistant', content: said });
          messages.push({
            role: 'user',
            content: 'Approved automatically (auto mode is on). Complete the action now.',
          });
          continue;
        }
        await pushChat(said.replace(fake[0], '').trim() || summary, 'assistant');
        await browser.storage.local.set({ tidraPending: { label } });
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

export default defineBackground(() => {
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
