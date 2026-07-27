import { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { streamText, tierFor } from '../../lib/llm';
import { record, transcribe, type Recorder } from '../../lib/voice';
import { expandSkill, filterSkills, loadSkills, matchSkill, type Skill } from '../../lib/skills';
import { defaultTaskFor, faviconUrl, prettyDomain } from '../../lib/routine';
import { archiveChat, reportUrl } from '../../lib/library';
import {
  connectFolder,
  folderAccess,
  listFolders,
  removeFolder,
  requestFolderAccess,
  type FolderAccess,
  type FolderRecord,
} from '../../lib/folders';
import { Wordmark } from '../../components/Wordmark';
import { renderBlocks } from '../../components/richtext';
import '../content/font.css';
import './newtab.css';

// The new tab only ever chats (no tools), so it uses the tier's chat model —
// same table the background uses, so both stay in step with the provider.

const SYSTEM = `You are Tidra, a warm, sharp assistant living in the user's browser new-tab page.
Answer questions directly and concisely — a few tight sentences or short bullets, no filler preamble.
Answer from what you know.
If answering would need the browser — opening a website, or looking at the user's own account (their inbox, messages, notifications, feed, orders, calendar) — do NOT say you can't access it. Reply with exactly NEEDS_BROWSER and nothing else, and it will be handed to the part of Tidra that can.
The same goes for the user's own files: any request that names a folder of theirs, or their files, documents, PDFs, photos or downloads, is NEEDS_BROWSER. Tidra can read folders the user connected — you just can't do it from here.
If the request hangs on something only the user knows — audience, tone, goal, scope — ask ONE short clarifying question instead of guessing; never more than one.
Never ask the user for something Tidra could look up itself. "What files are in that folder?" or "what does the page say?" are not clarifying questions — they are the job. Reply NEEDS_BROWSER instead.
Reply in the language the user writes in.`;

// The local chat model emits this alone when a request turns out to need the
// browser after all — a backstop for when the cheap router guessed wrong.
const HANDOFF = 'NEEDS_BROWSER';

interface Visit {
  d: string;
  t: number;
}
interface TileData {
  domain: string;
  label: string;
  url: string;
}

/** What Tidra knows about you — read-only here, edited in settings. */
interface NtProfile {
  name?: string;
  email?: string;
  role?: string;
  company?: string;
  location?: string;
  languages?: string;
  about?: string;
}

// Order they appear in the profile card; name and role head the card instead.
const NT_PROFILE_FIELDS: { key: keyof NtProfile; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'company', label: 'Company' },
  { key: 'location', label: 'Location' },
  { key: 'languages', label: 'Languages' },
];

// The most-visited domains, freshness-weighted, for the quick-launch arc.
function topSites(visits: Visit[], limit = 7): TileData[] {
  const now = Date.now();
  const HALF_LIFE = 14 * 24 * 60 * 60 * 1000; // 14 days
  const score: Record<string, number> = {};
  for (const v of visits) {
    if (!v.d || /^(localhost|127\.|new)/.test(v.d)) continue;
    const age = Math.max(0, now - v.t);
    score[v.d] = (score[v.d] || 0) + Math.pow(0.5, age / HALF_LIFE);
  }
  return Object.keys(score)
    .sort((a, b) => score[b] - score[a])
    .slice(0, limit)
    .map((d) => ({ domain: d, label: prettyDomain(d), url: 'https://' + d }));
}

// Treat the input as a destination if it's a URL or a bare domain like "github.com".
function asUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(s)) return 'https://' + s;
  return null;
}

// A query that reads like a question / request defaults to Chat; otherwise Google.
// Only ever asked about the first thing typed — see `chatMode`. A reply in an
// open conversation is a reply whatever it looks like.
const QUESTION_RE =
  /^(who|what|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|should|would|will|explain|summar|write|draft|help|tell|give|make|translate|fix|generate|compare|define)\b/i;
function looksLikeChat(q: string): boolean {
  const t = q.trim();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  if (QUESTION_RE.test(t)) return true;
  return t.split(/\s+/).length >= 5; // long phrases lean conversational
}

function googleUrl(q: string): string {
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}

// Popular sites to offer as a direct "open the website" option while typing.
const POPULAR: { name: string; domain: string }[] = [
  { name: 'Facebook', domain: 'facebook.com' },
  { name: 'YouTube', domain: 'youtube.com' },
  { name: 'Gmail', domain: 'mail.google.com' },
  { name: 'LinkedIn', domain: 'linkedin.com' },
  { name: 'GitHub', domain: 'github.com' },
  { name: 'Notion', domain: 'notion.so' },
  { name: 'Reddit', domain: 'reddit.com' },
  { name: 'Instagram', domain: 'instagram.com' },
  { name: 'WhatsApp', domain: 'web.whatsapp.com' },
  { name: 'Amazon', domain: 'amazon.com' },
  { name: 'Wikipedia', domain: 'wikipedia.org' },
  { name: 'ChatGPT', domain: 'chatgpt.com' },
  { name: 'X', domain: 'x.com' },
];
// Match a one-word query against the sites you visit + popular sites, by prefix.
function matchSite(q: string, visits: Visit[]): { name: string; domain: string } | null {
  const t = q.trim().toLowerCase();
  if (t.length < 2 || /\s/.test(t) || t.includes('.')) return null;
  for (const v of topSites(visits, 24)) {
    if (v.label.toLowerCase().startsWith(t) || v.domain.toLowerCase().startsWith(t))
      return { name: v.label, domain: v.domain };
  }
  for (const p of POPULAR) {
    if (p.name.toLowerCase().startsWith(t) || p.domain.toLowerCase().startsWith(t)) return p;
  }
  return null;
}

// The Tidra caret mark. Bobs gently while thinking.
function Orb({ thinking }: { thinking?: boolean }) {
  return (
    <span className={'nt-orb' + (thinking ? ' nt-orb-thinking' : '')} aria-hidden="true">
      <svg viewBox="0 0 128 128">
        <rect width="128" height="128" rx="28" fill="#0a0a0a" />
        <path
          d="M34 88 L64 42 L94 88"
          fill="none"
          stroke="#ffffff"
          strokeWidth="20"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

const IconArrowUp = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconMic = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
    <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);
const IconNew = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 5.5A1.5 1.5 0 0 1 5.5 4h7L20 11.5v7A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-13Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M12.5 4v6.5H20" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

// Books-on-a-shelf mark for the library chip.
const IconLib = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 4.5h4v15H4v-15Zm6 0h4v15h-4v-15Zm7.2.6 3.4 14.1-3.9 1-3.4-14.2 3.9-.9Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);
const IconPlay = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path d="M7 4.8v14.4l12-7.2L7 4.8Z" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

const IconPerson = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.9" />
    <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

const IconSearch = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
    <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const IconPlus = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const IconCopy = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <rect x="9" y="9" width="11" height="11" rx="2.4" stroke="currentColor" strokeWidth="1.6" />
    <path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const IconThumb = ({ down }: { down?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={down ? { transform: 'rotate(180deg)' } : undefined}>
    <path
      d="M7 10v10H4.5a1.5 1.5 0 0 1-1.5-1.5V11.5A1.5 1.5 0 0 1 4.5 10H7Zm0 0 3.4-6.2A1.8 1.8 0 0 1 13.7 4.7l-.6 3.3h4.6a2 2 0 0 1 2 2.4l-1.1 6a2 2 0 0 1-2 1.6H7"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

// Feather "settings" gear — same mark the island uses.
const IconGear = () => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const IconBolt = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M13 2 4.5 13.5H11L9.5 22 19 10.5h-6.5L13 2Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
);
const IconChat = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path
      d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.2A7.5 7.5 0 1 1 20 11.5Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
);
const IconGlobe = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M3.5 12h17M12 3.5c2.5 2.3 2.5 14 0 17M12 3.5c-2.5 2.3-2.5 14 0 17" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
const IconEnter = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M20 5v6a3 3 0 0 1-3 3H5m0 0 4-4m-4 4 4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconChevron = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// One learned-routine site: grey card with the favicon + name. Clicking it opens
// the routine editor; the ✕ removes it.
function RoutineChip({
  site,
  onSelect,
  onRemove,
}: {
  site: TileData;
  onSelect: (domain: string) => void;
  onRemove: (domain: string) => void;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="nt-rchip">
      <button className="nt-rchip-open" onClick={() => onSelect(site.domain)} title={`Edit ${site.label} routine`}>
        {broken ? (
          <span className="nt-rchip-ico nt-rchip-letter">{site.label.charAt(0)}</span>
        ) : (
          <img className="nt-rchip-ico" src={faviconUrl(site.url)} alt="" onError={() => setBroken(true)} />
        )}
        <span className="nt-rchip-name">{site.label}</span>
      </button>
      <button className="nt-rchip-x" onClick={() => onRemove(site.domain)} title="Remove from routine" aria-label="Remove">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

// A connected folder, plus whether it can be read right now. The two are stored
// apart because only the handle is durable — the permission has to be re-checked
// every time this page loads.
type FolderRow = { rec: FolderRecord; access: FolderAccess };

// One connected folder. Unlike a site chip, this one can be in a state the user
// has to fix: Chrome hands back the handle after a restart but not the
// permission, so the chip becomes a one-click "Reconnect" rather than quietly
// failing the next time a routine runs.
function FolderChip({
  row,
  onFix,
  onRemove,
}: {
  row: FolderRow;
  onFix: (row: FolderRow) => void;
  onRemove: (row: FolderRow) => void;
}) {
  const ok = row.access === 'granted';
  return (
    <span className={'nt-rchip nt-fchip' + (ok ? '' : ' nt-fchip-stale')}>
      <button
        className="nt-rchip-open"
        onClick={() => !ok && onFix(row)}
        title={ok ? `${row.rec.name} — Tidra can read this folder` : 'Give Tidra access to this folder again'}
      >
        <span className="nt-rchip-ico nt-fchip-ico">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="nt-rchip-name">{row.rec.label}</span>
        {!ok && <span className="nt-fchip-fix">{row.access === 'missing' ? 'Missing' : 'Reconnect'}</span>}
      </button>
      <button className="nt-rchip-x" onClick={() => onRemove(row)} title="Disconnect this folder" aria-label="Disconnect">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

type Turn = { role: 'user' | 'assistant'; text: string };

// The shared conversation, as the background writes it. This page only ever
// adds plain turns, but it must carry the rest through untouched — `summary` is
// the thread's memory of everything older than the last dozen messages, `route`
// is what stops a bare follow-up being re-routed onto a different path, and
// `trace` is how the next turn knows what "it" refers to.
type ChatMsg = {
  role: 'user' | 'assistant' | 'error';
  text: string;
  trace?: string[];
  page?: { title: string; url: string };
};
type ChatState = {
  messages: ChatMsg[];
  loading: boolean;
  summary?: { text: string; covers: number };
  route?: 'chat' | 'look' | 'act';
};

/** Write this page's turns back to the shared store, preserving everything the
 *  background owns. Without this, a chat answered here left no trace at all —
 *  the island, and the next agent run, had never heard of it.
 *
 *  Turns this page did not author are reused as the stored objects rather than
 *  rebuilt from `{role, text}`: local state has no field for a trace, so
 *  rebuilding would strip one off every message the agent had written. */
async function persistTurns(turns: Turn[]): Promise<void> {
  const { tidraChat } = await browser.storage.local.get('tidraChat');
  const existing = (tidraChat as ChatState | undefined) ?? { messages: [], loading: false };
  const stored = existing.messages ?? [];
  const messages = turns
    .filter((t) => t.text.trim())
    .map((t, i) => {
      const prev = stored[i];
      return prev && prev.role === t.role && prev.text === t.text ? prev : { role: t.role, text: t.text };
    });
  await browser.storage.local.set({ tidraChat: { ...existing, messages, loading: false } });
}

function NewTab() {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined);
  const [tier, setTier] = useState('balanced');
  const [visits, setVisits] = useState<Visit[]>([]);
  const [reactions, setReactions] = useState<Record<number, 'up' | 'down' | undefined>>({});
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [activeOpt, setActiveOpt] = useState(0);
  const [routine, setRoutine] = useState<TileData[]>([]);
  const [routineEnabled, setRoutineEnabled] = useState(false);
  const [routinePending, setRoutinePending] = useState(false);
  const [routineOpen, setRoutineOpen] = useState(true);
  const [manual, setManual] = useState<TileData[]>([]);
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [taskDomain, setTaskDomain] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState('');
  const [routineFolders, setRoutineFolders] = useState<Record<string, string>>({});
  const [folderDraft, setFolderDraft] = useState('');
  const [addMode, setAddMode] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [routineStarted, setRoutineStarted] = useState(false);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const [profile, setProfile] = useState<NtProfile>({});
  const [profileOpen, setProfileOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mic, setMic] = useState<'off' | 'listening' | 'thinking'>('off');
  const [micNote, setMicNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  // The mic can close itself long after it was opened, so the auto-send path
  // runs from a callback captured back then. These refs keep it looking at the
  // present rather than at whatever was on screen when recording started.
  const liveRef = useRef({ input: '', streaming: false });
  const suggestSeq = useRef(0);

  useEffect(() => {
    browser.storage.local
      .get(['tidraGroqKey', 'tidraTier', 'tidraVisits', 'tidraRoutineCollapsed', 'tidraChat'])
      .then(({ tidraGroqKey, tidraTier, tidraVisits, tidraRoutineCollapsed, tidraChat }) => {
        setApiKey((tidraGroqKey as string) || null);
        if (typeof tidraTier === 'string') setTier(tidraTier);
        if (Array.isArray(tidraVisits)) setVisits(tidraVisits as Visit[]);
        setRoutineOpen(!tidraRoutineCollapsed);
        // Pick up the conversation wherever it was last spoken. This page used
        // to start blank and then, on the first handoff, overwrite `tidraChat`
        // with its own turns — so a thread begun in the island was destroyed by
        // a question asked here, and the agent lost everything before it.
        const stored = (tidraChat as { messages?: Turn[] } | undefined)?.messages;
        if (Array.isArray(stored) && stored.length) {
          setTurns(stored.filter((m) => m.role === 'user' || m.role === 'assistant'));
        }
      });
    inputRef.current?.focus();
  }, []);

  // Pull the learned routine (computed in the background from your visit log),
  // and whether a fresh session just began (a pending "continue?" prompt).
  useEffect(() => {
    browser.runtime
      .sendMessage({ type: 'tidra-get-routine' })
      .then((res: { enabled?: boolean; sites?: { domain: string; url: string }[] } | undefined) => {
        setRoutineEnabled(!!res?.enabled);
        if (res?.sites)
          setRoutine(res.sites.map((s) => ({ domain: s.domain, label: prettyDomain(s.domain), url: s.url })));
      })
      .catch(() => {});
    browser.storage.local.get('tidraRoutine').then(({ tidraRoutine }) => {
      const pending = (tidraRoutine as { sites?: unknown[] } | null)?.sites;
      setRoutinePending(Array.isArray(pending) && pending.length > 0);
    });
    browser.storage.local.get('tidraRoutineTasks').then(({ tidraRoutineTasks }) => {
      if (tidraRoutineTasks && typeof tidraRoutineTasks === 'object')
        setTasks(tidraRoutineTasks as Record<string, string>);
    });
    browser.storage.local.get('tidraRoutineManual').then(({ tidraRoutineManual }) => {
      if (Array.isArray(tidraRoutineManual)) setManual(tidraRoutineManual as TileData[]);
    });
    browser.storage.local.get('tidraRoutineFolders').then(({ tidraRoutineFolders }) => {
      if (tidraRoutineFolders && typeof tidraRoutineFolders === 'object')
        setRoutineFolders(tidraRoutineFolders as Record<string, string>);
    });
    browser.storage.local.get('tidraProfile').then(({ tidraProfile }) => {
      if (tidraProfile && typeof tidraProfile === 'object') setProfile(tidraProfile as NtProfile);
    });
    loadSkills().then(setSkills).catch(() => {});
  }, []);

  // Connected folders. Re-checked whenever this page comes back into view: the
  // permission can lapse between two looks at the new tab (a browser restart is
  // all it takes), and a chip claiming "connected" when it isn't would send the
  // user's daily routine off to fail out of sight.
  const refreshFolders = useCallback(async () => {
    const recs = await listFolders();
    const rows = await Promise.all(recs.map(async (rec) => ({ rec, access: await folderAccess(rec) })));
    setFolders(rows);
  }, []);

  useEffect(() => {
    void refreshFolders();
    const onShow = () => {
      if (document.visibilityState === 'visible') void refreshFolders();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [refreshFolders]);

  // Pick a folder. Only a real click can do this — there is no way to open the
  // picker from the background, which is why this button exists at all.
  async function addFolder() {
    setFolderNote(null);
    try {
      const rec = await connectFolder();
      if (!rec) return; // cancelled — not an error
      await refreshFolders();
      setFolderNote(
        `Tidra can now read “${rec.label}”. Say what to do with it — e.g. “every day, post the next picture from ${rec.label} to LinkedIn”.`,
      );
    } catch (err) {
      setFolderNote(err instanceof Error ? err.message : 'That folder could not be opened.');
    }
  }

  // Win the access back. A lapsed permission takes one click; a folder that has
  // actually moved or been deleted needs picking again, and the dead row goes.
  async function fixFolder(row: FolderRow) {
    setFolderNote(null);
    if ((await requestFolderAccess(row.rec)) === 'granted') {
      await refreshFolders();
      return;
    }
    const rec = await connectFolder(row.rec.label).catch(() => null);
    if (rec && rec.id !== row.rec.id) await removeFolder(row.rec.id);
    await refreshFolders();
  }

  async function disconnectFolder(row: FolderRow) {
    await removeFolder(row.rec.id);
    // Routines pointing at it go with it — a binding to a folder that no longer
    // exists would fail at 8am with nothing on screen to explain why.
    setRoutineFolders((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([, id]) => id !== row.rec.id));
      browser.storage.local.set({ tidraRoutineFolders: next });
      return next;
    });
    setFolderNote(null);
    await refreshFolders();
  }

  // The routine shown = learned sites + ones you added manually, de-duplicated.
  const routineSites: TileData[] = (() => {
    const seen = new Set<string>();
    const out: TileData[] = [];
    for (const s of [...routine, ...manual]) {
      if (seen.has(s.domain)) continue;
      seen.add(s.domain);
      out.push(s);
    }
    return out;
  })();

  // Which folder each site's routine may use, by folder id — an id rather than a
  // label so renaming a folder doesn't silently unbind the routine.
  function bindFolder(domain: string, folderId: string) {
    setRoutineFolders((prev) => {
      const next = { ...prev };
      if (folderId) next[domain] = folderId;
      else delete next[domain];
      browser.storage.local.set({ tidraRoutineFolders: next });
      return next;
    });
  }

  // Open the per-site routine editor (falls back to a suggested description).
  function openTask(domain: string) {
    const site = routineSites.find((s) => s.domain === domain);
    setAddMode(false);
    setTaskDomain(domain);
    setTaskDraft(tasks[domain] ?? defaultTaskFor(domain, site?.label ?? domain));
    setFolderDraft(routineFolders[domain] ?? '');
  }
  function saveTask() {
    if (!taskDomain) return;
    const next = { ...tasks, [taskDomain]: taskDraft.trim() };
    setTasks(next);
    browser.storage.local.set({ tidraRoutineTasks: next });
    bindFolder(taskDomain, folderDraft);
    setTaskDomain(null);
  }
  const taskSite = taskDomain ? routineSites.find((s) => s.domain === taskDomain) : null;

  // Add a routine manually — pick a site and describe what Tidra should do.
  function openAdd() {
    setTaskDomain(null);
    setAddMode(true);
    setAddUrl('');
    setTaskDraft('');
    setFolderDraft('');
  }
  function saveAdd() {
    const raw = addUrl.trim();
    const url = asUrl(raw) || (/\.[a-z]{2,}$/i.test(raw) ? 'https://' + raw : null);
    if (!url) return; // not a valid site
    let domain: string;
    try {
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return;
    }
    const site: TileData = { domain, label: prettyDomain(domain), url };
    const nextManual = [...manual.filter((m) => m.domain !== domain), site];
    setManual(nextManual);
    browser.storage.local.set({ tidraRoutineManual: nextManual });
    if (taskDraft.trim()) {
      const nextTasks = { ...tasks, [domain]: taskDraft.trim() };
      setTasks(nextTasks);
      browser.storage.local.set({ tidraRoutineTasks: nextTasks });
    }
    bindFolder(domain, folderDraft);
    // un-hide it if it had been removed before
    browser.storage.local.get('tidraRoutineHidden').then(({ tidraRoutineHidden }) => {
      const hidden = new Set((tidraRoutineHidden as string[]) || []);
      if (hidden.delete(domain)) browser.storage.local.set({ tidraRoutineHidden: [...hidden] });
    });
    setAddMode(false);
  }
  function closeModal() {
    setTaskDomain(null);
    setAddMode(false);
  }

  // Clear the pending session prompt (it's been acted on or dismissed).
  function clearRoutinePrompt() {
    setRoutinePending(false);
    browser.storage.local.set({ tidraRoutine: null });
  }
  // Run the routine: Tidra works each site in the background and reports in its panel.
  function startRoutine() {
    setRoutineStarted(true);
    browser.runtime.sendMessage({ type: 'tidra-run-routine' }).catch(() => {});
    clearRoutinePrompt();
  }
  // Remove a site from the routine — remembered so it doesn't come back.
  function removeRoutine(domain: string) {
    setRoutine((prev) => prev.filter((s) => s.domain !== domain));
    setManual((prev) => {
      const next = prev.filter((s) => s.domain !== domain);
      browser.storage.local.set({ tidraRoutineManual: next });
      return next;
    });
    browser.storage.local.get('tidraRoutineHidden').then(({ tidraRoutineHidden }) => {
      const hidden = new Set((tidraRoutineHidden as string[]) || []);
      hidden.add(domain);
      browser.storage.local.set({ tidraRoutineHidden: [...hidden] });
    });
  }
  function toggleRoutine() {
    setRoutineOpen((v) => {
      browser.storage.local.set({ tidraRoutineCollapsed: v });
      return !v;
    });
  }

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Live Google autocomplete for the ask box (debounced). Fails quietly when
  // offline/blocked — the Google/Chat/website options still work without it.
  useEffect(() => {
    const q = input.trim();
    setActiveOpt(0);
    // No Google autocomplete for URLs or slash commands — nothing useful comes back.
    if (!q || q.startsWith('/') || asUrl(q)) {
      setSuggestions([]);
      return;
    }
    const seq = ++suggestSeq.current;
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`,
        );
        const data = await res.json();
        if (seq === suggestSeq.current && Array.isArray(data?.[1])) {
          setSuggestions(
            (data[1] as string[]).filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, 4),
          );
        }
      } catch {
        /* ignore — offline or blocked */
      }
    }, 130);
    return () => window.clearTimeout(id);
  }, [input]);

  const active = turns.length > 0 || streaming;

  function go(url: string) {
    window.location.href = url;
  }

  function runGoogle(q: string) {
    if (q.trim()) go(googleUrl(q.trim()));
  }

  async function runChat(raw: string) {
    const text = raw.trim();
    if (!text || streaming) return;

    if (!apiKey) {
      browser.runtime.sendMessage({ type: 'tidra-open-options' });
      return;
    }

    // Slash skills: "/outline dutch golden age" expands into the skill's saved
    // prompt. The thread shows what was typed; only the request sent to the
    // model is expanded. An 'act' skill skips the router — it told us already.
    const sk = matchSkill(text, skills);
    const payload = sk ? await expandSkill(sk.skill, sk.rest) : text;

    setInput('');
    setSuggestions([]);
    const history = [...turns, { role: 'user' as const, text }];
    setTurns([...history, { role: 'assistant', text: '' }]);
    setStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      if (sk?.skill.mode === 'act') {
        await handOff(text); // the background expands the slash command itself
        return;
      }

      // The new tab has no tools of its own. If the request needs the browser,
      // hand it to the background agent — which drives THIS tab, so the island
      // picks the conversation up on whatever site it opens.
      const routed =
        sk?.skill.mode === 'chat'
          ? null // the skill said chat — no need to ask the router
          : ((await browser.runtime
              .sendMessage({
                type: 'tidra-route',
                prompt: payload,
                // The router needs the thread too — a follow-up like "what are
                // these?" carries none of its own meaning.
                history: turns.filter((t) => t.text.trim()).map((t) => ({ role: t.role, text: t.text })),
              })
              .catch(() => null)) as { route?: string } | null);

      if (routed?.route === 'act' || routed?.route === 'look') {
        await handOff(text, routed.route);
        return;
      }

      // Buffer the reply so a NEEDS_BROWSER handoff never flashes on screen:
      // while what has arrived is still a prefix of it, render nothing.
      let acc = '';
      await streamText(
        apiKey,
        {
          model: tierFor(tier).chat,
          max_tokens: 1024,
          system: SYSTEM,
          // The newest turn goes out expanded (if it was a skill); older turns
          // ride along as they were typed.
          messages: history.map((t, i) => ({
            role: t.role,
            content: i === history.length - 1 ? payload : t.text,
          })),
        },
        (delta) => {
          acc += delta;
          if (HANDOFF.startsWith(acc.trim())) return; // might still become a handoff
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') next[next.length - 1] = { ...last, text: acc };
            return next;
          });
        },
        abort.signal,
      );

      if (acc.trim() === HANDOFF) {
        await handOff(text);
        return;
      }
      // Answered here, so nothing else has written this exchange down. Persist
      // once, at the end — the shared store is what the next turn reads, on
      // whichever surface it happens.
      void persistTurns([...history, { role: 'assistant', text: acc }]);
    } catch (err) {
      if (!abort.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant' && !last.text)
            next[next.length - 1] = { ...last, text: `⚠️ ${msg}` };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }

  // Give the request to the background agent, which drives THIS tab — so the
  // island picks the conversation up on whatever site it opens. `intent` passes
  // the router's verdict through, so a pure lookup keeps its read-only,
  // out-of-sight treatment instead of being forced down the act path.
  async function handOff(text: string, intent: 'look' | 'act' = 'act') {
    setTurns((prev) => {
      const next = [...prev];
      next[next.length - 1] = { role: 'assistant', text: 'On it — opening the page…' };
      return next;
    });
    // Everything said so far goes WITH the request. The background rebuilds its
    // conversation from tidraChat, so seeding it with only the new message is
    // what makes a follow-up land in an empty room: "what are these?" arrives
    // with nothing to resolve "these" against, and the agent asks for a URL.
    //
    // Append to what is already stored rather than replacing it with this page's
    // `turns`. The two are normally the same thread — this page seeds itself
    // from the store on mount — but the store is the one that also carries the
    // rolling summary, the last route, and each turn's trace, and rebuilding it
    // from local state threw all of that away.
    const { tidraChat } = await browser.storage.local.get('tidraChat');
    const existing = (tidraChat as ChatState | undefined) ?? { messages: [], loading: false };
    const prior = existing.messages?.length
      ? existing.messages
      : turns.filter((t) => t.text.trim()).map((t) => ({ role: t.role, text: t.text }) as ChatMsg);
    await browser.storage.local.set({
      tidraChat: { ...existing, messages: [...prior, { role: 'user', text }], loading: true },
      tidraPending: null,
      tidraUnread: false,
      tidraOpen: true,
      tidraStatus: 'Getting started',
    });
    // Follow the agent's chat from here on. Without this the page would sit on
    // "On it…" forever, showing neither the answer nor any error, because the
    // agent reports into tidraChat and this page keeps its own state.
    const follow = (changes: Record<string, { newValue?: unknown }>) => {
      if (!changes.tidraChat) return;
      const chat = changes.tidraChat.newValue as
        | { messages?: { role: string; text: string }[]; loading?: boolean }
        | undefined;
      const msgs = chat?.messages ?? [];
      // Nothing back yet — leave "On it…" alone rather than blanking the thread.
      if (!msgs.some((m) => m.role !== 'user')) return;
      // Rebuild from the WHOLE store, not just this turn's replies: tidraChat is
      // now the conversation, and rendering a slice of it would erase on screen
      // the same history the agent is still reasoning over.
      setTurns(
        msgs.map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), text: m.text })),
      );
      if (chat?.loading === false) {
        setStreaming(false);
        browser.storage.onChanged.removeListener(follow);
      }
    };
    browser.storage.onChanged.addListener(follow);

    browser.runtime
      .sendMessage({
        type: 'tidra-ask',
        prompt: text,
        page: { title: 'Tidra new tab', url: 'about:newtab', text: '' },
        intent,
      })
      .catch(() => {});
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  function reset() {
    stop();
    // Keep the finished conversation in the library rather than losing it.
    if (turns.length) void archiveChat('newtab', turns);
    setTurns([]);
    setInput('');
    setReactions({});
    // Clear the shared thread too, summary and all. "New chat" has to mean the
    // same thing here as it does in the island, or the next question inherits a
    // conversation the user believes they just ended.
    void browser.storage.local.set({
      tidraChat: { messages: [], loading: false },
      tidraPending: null,
      tidraUnread: false,
      tidraLastImages: null,
    });
    inputRef.current?.focus();
  }

  function copyText(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }
  function react(i: number, r: 'up' | 'down') {
    setReactions((prev) => ({ ...prev, [i]: prev[i] === r ? undefined : r }));
  }

  // ── Ask-box options: Google / Chat / open a website / autocomplete ────────
  const q = input.trim();
  // Mid-conversation, there is nothing to guess: you are talking to Tidra, and
  // the next thing you type is a reply. The heuristic only gets a say on the
  // FIRST input, where the box genuinely is both a search bar and a chat — read
  // any later, it sends "yes please" or "the second one" to Google and drops the
  // conversation, because a short answer looks nothing like a question.
  const chatMode = active || looksLikeChat(q);
  const directUrl = q ? asUrl(q) : null;
  const site = q && !directUrl ? matchSite(q, visits) : null;

  interface Opt {
    key: string;
    kind: 'google' | 'chat' | 'url' | 'skill';
    label: string;
    sub?: string;
    hint?: string;
    run: () => void;
  }
  const opts: Opt[] = [];
  // "/" invokes a skill — the dropdown becomes the skill picker. An unmatched
  // slash query falls through to the ordinary Google/Chat options.
  if (q.startsWith('/')) {
    const sm = /^\/([a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(q);
    const nameQ = (sm?.[1] ?? '').toLowerCase();
    const rest = (sm?.[2] ?? '').trim();
    for (const s of filterSkills(nameQ, skills)) {
      opts.push({
        key: 'k' + s.name,
        kind: 'skill',
        label: '/' + s.name,
        sub: s.description,
        run: () => runChat('/' + s.name + (s.name === nameQ && rest ? ' ' + rest : '')),
      });
    }
  }
  if (q && !opts.length) {
    const googleOpt: Opt = { key: 'g', kind: 'google', label: q, sub: 'Google', hint: '⇧⌘⏎', run: () => runGoogle(q) };
    const chatOpt: Opt = { key: 'c', kind: 'chat', label: q, sub: 'Chat', hint: '⌃⌘⏎', run: () => runChat(q) };
    if (directUrl) {
      opts.push({ key: 'u', kind: 'url', label: q, sub: directUrl.replace(/^https?:\/\//, ''), run: () => go(directUrl) });
      opts.push(chatMode ? chatOpt : googleOpt, chatMode ? googleOpt : chatOpt);
    } else {
      opts.push(chatMode ? chatOpt : googleOpt, chatMode ? googleOpt : chatOpt);
      if (site) opts.push({ key: 's', kind: 'url', label: site.name, sub: site.domain, run: () => go('https://' + site.domain) });
      for (const s of suggestions) {
        opts.push(
          chatMode
            ? { key: 'q' + s, kind: 'chat', label: s, run: () => runChat(s) }
            : { key: 'q' + s, kind: 'google', label: s, run: () => runGoogle(s) },
        );
      }
    }
  }
  const showDrop = focused && q.length > 0 && opts.length > 0;
  const curOpt = Math.min(activeOpt, Math.max(0, opts.length - 1));
  const primary = opts[0];

  // Speak instead of type. This page is at the extension's own origin, so it
  // records directly — and granting the microphone here is also what unlocks it
  // for the island, which has to borrow the same grant via its offscreen page.
  async function toggleMic() {
    if (mic === 'thinking') return;
    setMicNote(null);

    if (mic === 'off') {
      if (!apiKey) {
        setMicNote('Add a Groq API key in settings to use voice.');
        return;
      }
      try {
        recorderRef.current = await record({
          // Stops on its own when you stop talking — the button is the override.
          onDone: (clip, reason) => {
            recorderRef.current = null;
            void useClip(clip, reason === 'no-speech');
          },
        });
        setMic('listening');
      } catch (err) {
        const name = (err as { name?: string })?.name;
        setMicNote(
          name === 'NotAllowedError'
            ? 'Microphone blocked. Allow it for this page in the address bar, then try again.'
            : name === 'NotFoundError'
              ? 'No microphone found.'
              : 'Could not start the microphone.',
        );
      }
      return;
    }

    const rec = recorderRef.current;
    recorderRef.current = null;
    await useClip((await rec?.stop()) ?? null);
  }

  /** Whichever way the recording ended, the clip goes through here. */
  async function useClip(clip: Blob | null, silent = false) {
    setMic('thinking');
    try {
      // Under ~1 KB is a click, not a sentence — don't pay to transcribe silence.
      if (!clip || clip.size < 1200) {
        if (silent) setMicNote("Didn't catch anything — try again.");
        return;
      }
      const heard = (await transcribe(apiKey!, clip)).trim();
      if (!heard) return;
      // Whatever was already typed keeps its place in front of what was said.
      const typed = liveRef.current.input.trim();
      const said = typed ? `${typed} ${heard}` : heard;
      setInput(said);
      inputRef.current?.focus();
      // Finishing the sentence IS the send. Nobody says a thing out loud and
      // then reaches for the keyboard to confirm they meant it.
      //
      // Speech goes to Tidra, never to Google — talking to something is
      // addressing it. A dictated web address is the one sensible exception,
      // since "open github.com" out loud plainly means go there.
      const url = asUrl(said);
      if (url) go(url);
      else runChat(said);
    } catch (err) {
      setMicNote(err instanceof Error ? err.message : 'Could not transcribe that.');
    } finally {
      setMic('off');
    }
  }

  useEffect(() => {
    liveRef.current = { input, streaming };
  });

  // Never leave the mic light on if the page goes away mid-recording.
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const micButton = (
    <button
      type="button"
      className={'nt-icon' + (mic === 'listening' ? ' nt-mic-live' : '') + (mic === 'thinking' ? ' nt-mic-busy' : '')}
      onClick={toggleMic}
      title={mic === 'listening' ? 'Stop and use what you said' : 'Speak instead of typing'}
      aria-label={mic === 'listening' ? 'Stop listening' : 'Speak'}
      aria-pressed={mic === 'listening'}
    >
      <IconMic />
    </button>
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey) return; // Shift+Enter = newline
    if (!showDrop) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveOpt((a) => Math.min(a + 1, opts.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveOpt((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setInput('');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey && e.shiftKey) runGoogle(q); // ⇧⌘⏎ → Google
      else if (e.metaKey) runChat(q); // ⌘⏎ / ⌃⌘⏎ → Chat
      else opts[curOpt].run(); // ⏎ → highlighted option
    }
  }

  const profileName = profile.name?.trim() ?? '';
  const profileEmpty = !Object.values(profile).some((v) => typeof v === 'string' && v.trim());

  const sendBtn = streaming ? (
    <button className="nt-send nt-send-stop" onClick={stop} aria-label="Stop">
      <span className="nt-stop-sq" />
    </button>
  ) : (
    <button className="nt-send" onClick={() => runChat(input)} disabled={!input.trim()} aria-label="Ask Tidra">
      <IconArrowUp />
    </button>
  );

  return (
    <div className={'nt' + (active ? ' nt-chatting' : '')}>
      {/* Background video — home screen only. Once a chat starts the page goes
          plain white (and the video unmounts, so it stops decoding). */}
      {!active && (
        <video
          className="nt-video"
          src="/bg.mp4"
          autoPlay
          muted
          loop
          playsInline
          aria-hidden="true"
        />
      )}

      <header className="nt-mark">
        <button className="nt-mark-btn" onClick={reset} title="New chat" aria-label="Tidra — new chat">
          <Orb thinking={streaming} />
          {active ? <span className="nt-crumb">New chat</span> : <Wordmark className="nt-wordmark" />}
        </button>
      </header>

      {/* Your profile — kept on this device only. Click to see everything
          Tidra has; "Edit" hands off to settings, the one place it changes. */}
      {!active && (
        <div className="nt-profile-wrap">
          <button
            className={'nt-profile' + (profileName ? '' : ' nt-profile-empty')}
            onClick={() => {
              // Re-read on open — settings may have been edited in another tab.
              if (!profileOpen)
                browser.storage.local.get('tidraProfile').then(({ tidraProfile }) => {
                  if (tidraProfile && typeof tidraProfile === 'object')
                    setProfile(tidraProfile as NtProfile);
                });
              setProfileOpen((v) => !v);
            }}
            aria-expanded={profileOpen}
            title="Your profile — stored on this device only"
          >
            {profileName ? (
              <>
                <span className="nt-profile-av">{profileName.charAt(0).toUpperCase()}</span>
                <span className="nt-profile-txt">
                  <b>{profileName}</b>
                  {profile.role?.trim() && <i>{profile.role}</i>}
                </span>
              </>
            ) : (
              <>
                <span className="nt-profile-av nt-profile-av-empty">
                  <IconPerson />
                </span>
                <span className="nt-profile-txt">
                  <b>Profile</b>
                </span>
              </>
            )}
          </button>

          {profileOpen && (
            <>
              <div className="nt-profile-catch" onMouseDown={() => setProfileOpen(false)} />
              <div className="nt-profile-card">
                <div className="nt-profile-card-head">
                  <span className={'nt-profile-av' + (profileName ? '' : ' nt-profile-av-flat')}>
                    {profileName ? profileName.charAt(0).toUpperCase() : <IconPerson />}
                  </span>
                  <div className="nt-profile-card-id">
                    <b>{profileName || 'No profile yet'}</b>
                    <i>{profile.role?.trim() || 'Stored on this device only'}</i>
                  </div>
                </div>

                {profileEmpty ? (
                  <p className="nt-profile-blank">
                    Tidra doesn't know anything about you yet. Add your name, email and how you
                    like things written, and it'll sign drafts and match your voice.
                  </p>
                ) : (
                  <div className="nt-profile-body">
                    <dl className="nt-profile-fields">
                      {NT_PROFILE_FIELDS.filter((f) => profile[f.key]?.trim()).map((f) => (
                        <div key={f.key}>
                          <dt>{f.label}</dt>
                          <dd>{profile[f.key]}</dd>
                        </div>
                      ))}
                    </dl>
                    {profile.about?.trim() && (
                      <section>
                        <h4>Notes</h4>
                        <p>{profile.about}</p>
                      </section>
                    )}
                  </div>
                )}

                <p className="nt-profile-note">
                  Saved in this browser only — never uploaded or synced.
                </p>

                <button
                  className="nt-profile-edit"
                  onClick={() => {
                    setProfileOpen(false);
                    browser.runtime.sendMessage({ type: 'tidra-open-options' });
                  }}
                >
                  Edit
                </button>
              </div>
            </>
          )}
          <button
            className="nt-gear"
            onClick={() => browser.runtime.sendMessage({ type: 'tidra-open-options' })}
            title="Settings"
            aria-label="Open Tidra settings"
          >
            <IconGear />
          </button>
        </div>
      )}

      {active ? (
        <>
          <div className="nt-thread" ref={threadRef}>
            {turns.map((t, i) => {
              if (t.role === 'user') {
                return (
                  <div key={i} className="nt-turn nt-turn-user">
                    {t.text}
                  </div>
                );
              }
              const showActions = !!t.text && !(streaming && i === turns.length - 1);
              return (
                <div key={i} className="nt-turn nt-turn-tidra">
                  <div className="nt-turn-text">
                    {t.text ? (
                      renderBlocks(t.text)
                    ) : (
                      <span className="nt-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </div>
                  {showActions && (
                    <div className="nt-msg-actions">
                      <button
                        className={'nt-msg-act' + (reactions[i] === 'up' ? ' nt-msg-act-on' : '')}
                        onClick={() => react(i, 'up')}
                        title="Good response"
                      >
                        <IconThumb />
                      </button>
                      <button
                        className={'nt-msg-act' + (reactions[i] === 'down' ? ' nt-msg-act-on' : '')}
                        onClick={() => react(i, 'down')}
                        title="Bad response"
                      >
                        <IconThumb down />
                      </button>
                      <button className="nt-msg-act" onClick={() => copyText(t.text)} title="Copy">
                        <IconCopy />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="nt-dock">
            <div className="nt-dockbar">
              <button className="nt-icon" title="Attach (coming soon)" tabIndex={-1}>
                <IconPlus />
              </button>
              <textarea
                ref={inputRef}
                className="nt-input nt-dock-input"
                rows={1}
                value={input}
                placeholder="Ask another question…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {micButton}
              {sendBtn}
            </div>
            {micNote && <div className="nt-mic-note">{micNote}</div>}
          </div>
        </>
      ) : (
        <main className="nt-main">
          <div className="nt-boxwrap">
            <div className={'nt-box' + (showDrop ? ' nt-box-open' : '')}>
            <div className="nt-box-head">
              <span className="nt-box-search">{chatMode && q ? <IconChat /> : <IconSearch />}</span>
              <textarea
                ref={inputRef}
                className="nt-input"
                rows={1}
                value={input}
                placeholder="Ask anything…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
              />
            </div>

            {showDrop && (
              <div className="nt-suggest" role="listbox">
                {opts.map((o, i) => (
                  <div
                    key={o.key}
                    className={'nt-sug' + (i === curOpt ? ' nt-sug-active' : '')}
                    style={{ ['--i' as string]: String(i) } as React.CSSProperties}
                    role="option"
                    aria-selected={i === curOpt}
                    onMouseEnter={() => setActiveOpt(i)}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep focus / avoid blur before the click
                      o.run();
                    }}
                  >
                    <span className="nt-sug-icon">
                      {o.kind === 'skill' ? (
                        <IconBolt />
                      ) : o.kind === 'chat' ? (
                        <IconChat />
                      ) : o.kind === 'url' ? (
                        <IconGlobe />
                      ) : (
                        <IconSearch />
                      )}
                    </span>
                    <span className="nt-sug-text">
                      <span className="nt-sug-label">{o.label}</span>
                      {o.sub && <span className="nt-sug-sub"> — {o.sub}</span>}
                    </span>
                    {o.hint && <span className="nt-sug-hint">{o.hint}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="nt-box-row">
              {routineSites.length > 0 && (
                <button
                  className="nt-chip nt-chip-run"
                  onClick={startRoutine}
                  title="Run your routine in the background"
                >
                  <IconPlay />
                  <span>Start routine</span>
                </button>
              )}
              <button className="nt-chip" onClick={() => browser.tabs.create({})} title="Open a new tab">
                <IconNew />
                <span>New tab</span>
              </button>
              <button
                className="nt-chip"
                onClick={() => browser.tabs.create({ url: reportUrl() })}
                title="Your reports and saved chats"
              >
                <IconLib />
                <span>Library</span>
              </button>
              <button
                className="nt-chip"
                onClick={() =>
                  browser.tabs.create({ url: browser.runtime.getURL('/options.html') + '?tab=skills' })
                }
                title="Your slash-command skills — /summarize, /fact-check, …"
              >
                <IconBolt size={15} />
                <span>Skills</span>
              </button>
              <div className="nt-box-actions">
                {micButton}
                {q && primary ? (
                  <button
                    className={
                      'nt-go ' +
                      (primary.kind === 'chat' || primary.kind === 'skill' ? 'nt-go-chat' : 'nt-go-google')
                    }
                    onMouseDown={(e) => {
                      e.preventDefault();
                      primary.run();
                    }}
                    aria-label={
                      primary.kind === 'skill'
                        ? 'Run skill'
                        : primary.kind === 'chat'
                          ? 'Chat'
                          : primary.kind === 'url'
                            ? 'Open'
                            : 'Google'
                    }
                  >
                    {primary.kind === 'skill'
                      ? 'Run'
                      : primary.kind === 'chat'
                        ? 'Chat'
                        : primary.kind === 'url'
                          ? 'Open'
                          : 'Google'}
                    <IconEnter />
                  </button>
                ) : (
                  sendBtn
                )}
              </div>
            </div>
            </div>
            {micNote && <div className="nt-mic-note">{micNote}</div>}
          </div>

          {!q && (
            <h1 className="nt-tag">
              Your <span className="nt-pixel">AI assistant</span> for the web.
              <br />
              Summarize, draft, and act — <span className="nt-pixel">instantly</span>.
            </h1>
          )}

          {!q && apiKey === null && (
            <div className="nt-connect">
              <div className="nt-connect-info">
                <Orb />
                <span>Add your Groq API key to start using Tidra.</span>
              </div>
              <button
                className="nt-connect-btn"
                onClick={() => browser.runtime.sendMessage({ type: 'tidra-open-options' })}
              >
                Connect
              </button>
            </div>
          )}

          {!q && (routineEnabled || routineSites.length > 0 || folders.length > 0) && (
            <div
              className={
                'nt-routine' +
                (routineOpen ? '' : ' nt-routine-closed') +
                (routinePending && routineSites.length > 0 ? ' nt-routine-prompt' : '')
              }
            >
              <div className="nt-routine-head">
                <button className="nt-routine-toggle" onClick={toggleRoutine} aria-expanded={routineOpen}>
                  <span className="nt-routine-chev">
                    <IconChevron />
                  </span>
                  {routinePending && routineSites.length > 0 ? 'Continue your routine?' : 'Your routine'}
                </button>
              </div>
              {routineOpen && (
                <div className="nt-routine-actions">
                  <button className="nt-routine-add" onClick={openAdd}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                    </svg>
                    Add
                  </button>
                  <button className="nt-routine-add" onClick={addFolder} title="Let Tidra read a folder on your computer">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Add folder
                  </button>
                </div>
              )}
              {routineOpen && folders.length > 0 && (
                <div className="nt-routine-list nt-folder-list">
                  {folders.map((row) => (
                    <FolderChip key={row.rec.id} row={row} onFix={fixFolder} onRemove={disconnectFolder} />
                  ))}
                </div>
              )}
              {routineOpen && folders.some((f) => f.access !== 'granted') && (
                <p className="nt-routine-note">
                  Chrome forgets folder access every time it restarts — the handle is still here, so one
                  click on the folder above restores it. Tidra can't do that click for you.
                </p>
              )}
              {routineOpen && folderNote && <p className="nt-routine-note">{folderNote}</p>}
              {routineOpen &&
                (routineSites.length > 0 ? (
                  <>
                    <div className="nt-routine-list">
                      {routineSites.map((s) => (
                        <RoutineChip key={s.domain} site={s} onSelect={openTask} onRemove={removeRoutine} />
                      ))}
                    </div>
                    {routineStarted && (
                      <p className="nt-routine-note">
                        Tidra is working through your routine in the background — open it on any tab
                        (⌘⇧Space) to watch it draft and report.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="nt-routine-empty">
                    No routine yet — Tidra will learn your usual sites as you browse, or add one
                    yourself with “Add a routine”.
                  </p>
                ))}
            </div>
          )}
        </main>
      )}

      {/* Routine editor — describe, in plain words, what Tidra should do.
          Two modes: add a new site, or edit an existing one. */}
      {(taskSite || addMode) && (
        <div className="nt-modal-scrim" onMouseDown={closeModal}>
          <div className="nt-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="nt-modal-head">
              {taskSite ? (
                <img className="nt-modal-ico" src={faviconUrl(taskSite.url)} alt="" />
              ) : (
                <span className="nt-modal-ico nt-modal-ico-add">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                </span>
              )}
              <span className="nt-modal-title">{taskSite ? `${taskSite.label} routine` : 'Add a routine'}</span>
              <button className="nt-modal-x" onClick={closeModal} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {addMode && (
              <>
                <label className="nt-modal-label">Website</label>
                <input
                  className="nt-modal-input"
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder="e.g. gmail.com or notion.so"
                  autoFocus
                  spellCheck={false}
                />
              </>
            )}

            <label className="nt-modal-label">What should Tidra do here?</label>
            <textarea
              className="nt-modal-textarea"
              value={taskDraft}
              onChange={(e) => setTaskDraft(e.target.value)}
              placeholder={
                taskSite
                  ? `e.g. ${defaultTaskFor(taskSite.domain, taskSite.label)}`
                  : 'e.g. Check new emails and draft replies I can review before sending.'
              }
              autoFocus={!addMode}
              rows={4}
            />
            <p className="nt-modal-hint">
              Tidra will follow this when it runs your routine — describe it however you like.
            </p>

            {/* Binding a folder is what makes "open that folder and analyse the
                last file" resolvable — without it the routine has no idea which
                folder "that" is. Offered only when one is connected: an empty
                dropdown would just raise a question it can't answer. */}
            <label className="nt-modal-label">Folder from your computer</label>
            {folders.length > 0 ? (
              <select
                className="nt-modal-input nt-modal-select"
                value={folderDraft}
                onChange={(e) => setFolderDraft(e.target.value)}
              >
                <option value="">None — this routine only uses the website</option>
                {folders.map((f) => (
                  <option key={f.rec.id} value={f.rec.id}>
                    {f.rec.label}
                    {f.access === 'granted' ? '' : ' (needs reconnecting)'}
                  </option>
                ))}
              </select>
            ) : (
              <p className="nt-modal-hint">
                No folder connected yet. Close this and use “Add folder” if the routine should read
                files from your computer.
              </p>
            )}
            {folderDraft && (
              <p className="nt-modal-hint">
                Tidra can list and read this folder while the routine runs — e.g. “open that folder
                and analyse the last file”.
              </p>
            )}
            <div className="nt-modal-foot">
              {taskSite ? (
                <button className="nt-modal-open" onClick={() => go(taskSite.url)}>
                  Open site
                </button>
              ) : (
                <span />
              )}
              <div className="nt-modal-foot-right">
                <button className="nt-modal-cancel" onClick={closeModal}>
                  Cancel
                </button>
                {taskSite ? (
                  <button className="nt-modal-save" onClick={saveTask}>
                    Save
                  </button>
                ) : (
                  <button className="nt-modal-save" onClick={saveAdd} disabled={!addUrl.trim()}>
                    Add
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<NewTab />);
