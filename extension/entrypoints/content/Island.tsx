import { useEffect, useRef, useState } from 'react';
import { Wordmark } from '../../components/Wordmark';
import { renderBlocks, renderRich } from '../../components/richtext';
import { blobToBase64, record, type Recorder } from '../../lib/voice';
import { filterSkills, loadSkills, type Skill } from '../../lib/skills';
import { archiveChat } from '../../lib/library';

interface Attachment {
  kind: 'image' | 'text';
  name: string;
  /** Images: base64, no data: prefix. Text files: the text itself. */
  data: string;
  mime: string;
  /** A tiny copy for the chat bubble — the full one is never persisted. */
  thumb?: string;
}

interface ChatMsg {
  role: 'user' | 'assistant' | 'error';
  text: string;
  /** Thumbnails/names kept so the bubble still shows what was attached. */
  files?: { kind: 'image' | 'text'; name: string; thumb?: string }[];
}

const MAX_ATTACHMENTS = 4;
const TEXT_LIKE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/;

// Big photos would blow past storage quota and cost a fortune in tokens, so
// they are re-encoded to fit a 1024px box before they go anywhere.
function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const encode = (max: number, quality: number) => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not read that image.');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    };
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        resolve({
          kind: 'image',
          name: file.name,
          mime: 'image/jpeg',
          data: encode(1024, 0.75).split(',')[1], // what the model sees
          thumb: encode(96, 0.6), // what history keeps
        });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}

function readTextFile(file: File): Promise<Attachment> {
  return file.text().then((text) => ({
    kind: 'text' as const,
    name: file.name,
    mime: file.type || 'text/plain',
    data: text,
  }));
}

interface ChatState {
  messages: ChatMsg[];
  loading: boolean;
}

const EMPTY: ChatState = { messages: [], loading: false };

function extractPageContext() {
  const text = document.body?.innerText ?? '';
  return {
    title: document.title,
    url: location.href,
    text: text.replace(/\n{3,}/g, '\n\n').slice(0, 15000),
  };
}

interface Pending {
  label: string;
}

/** Mirror of the batch job in storage — see lib/jobs.ts. Read-only here. */
interface JobView {
  id: string;
  goal: string;
  total: number;
  done: number;
  failed: number;
  review: number;
  state: 'collecting' | 'sampling' | 'running' | 'paused' | 'done' | 'cancelled';
  irreversible: boolean;
  approved: boolean;
  sample?: string;
  current?: string;
}

function jobControl(action: string) {
  browser.runtime.sendMessage({ type: 'tidra-job', action }).catch(() => {});
}

const IconArrowUp = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
    <path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconPlus = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const IconMic = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
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
const IconCopy = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <rect x="9" y="9" width="11" height="11" rx="2.4" stroke="currentColor" strokeWidth="1.6" />
    <path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const IconStop = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);
const IconNewChat = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <path
      d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4.2v4.3h-4.3"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
// Feather "settings" gear
const IconGear = () => (
  <svg
    width="19"
    height="19"
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
const IconClose = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
    <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

// One icon per agent step, matched on the status text the background writes
// (see statusFor there). Same stroke weight and tone as the other icons.
function StepIcon({ step }: { step: string }) {
  const s = step.toLowerCase();
  const svg = (children: React.ReactNode) => (
    <span className="tidra-step-ic">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );

  // Opening a site — globe
  if (s.startsWith('opening')) {
    return svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3Z" />
      </>,
    );
  }
  // Clicking — pointer
  if (s.includes('clicking')) {
    return svg(<path d="M5.5 3.5 19 10.8l-6 1.7-3.5 5.3-4-14.3Z" />);
  }
  // Report / PDF / downloading — arrow into tray. Checked before "writing"
  // so "Writing the report" lands here, not on the pencil.
  if (s.includes('report') || s.includes('pdf') || s.includes('downloading')) {
    return svg(<path d="M12 4v10M8 10.5l4 4 4-4M5 19.5h14" />);
  }
  // Writing / filling a field — pencil
  if (s.includes('writing') || s.includes('filling') || s.includes('draft')) {
    return svg(<path d="M4.5 19.5l.9-3.6L16.8 4.5a2 2 0 0 1 2.8 2.8L8.1 18.6l-3.6.9Z" />);
  }
  // Choosing an option — checkmark
  if (s.includes('choosing')) {
    return svg(<path d="M4.5 12.5l5 5L19.5 7" />);
  }
  // Looking at the page / screenshot — eye
  if (s.includes('looking') || s.includes('taking a look')) {
    return svg(
      <>
        <path d="M2.5 12S6 6.4 12 6.4 21.5 12 21.5 12 18 17.6 12 17.6 2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.6" />
      </>,
    );
  }
  // Reading content — document with lines
  if (s.includes('reading')) {
    return svg(
      <>
        <path d="M6.5 3h8l4 4v14h-12V3Z" />
        <path d="M9.5 12h5M9.5 15.5h5" />
      </>,
    );
  }
  // Finding an element / building the work list — magnifier
  if (s.includes('finding') || s.includes('building')) {
    return svg(
      <>
        <circle cx="11" cy="11" r="6.2" />
        <path d="M20 20l-4.4-4.4" />
      </>,
    );
  }
  // Scrolling — vertical arrows
  if (s.includes('scrolling')) {
    return svg(<path d="M12 4v16M8.5 7.5 12 4l3.5 3.5M8.5 16.5 12 20l3.5-3.5" />);
  }
  // Batch progress ("3 of 10 · …") — loop
  if (/\d+\s*\/\s*\d+/.test(s)) {
    return svg(<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4.2v4.3h-4.3" />);
  }
  // Thinking / getting started / anything else — sparkle
  return svg(<path d="M12 3.5 13.9 10l6.6 2-6.6 2L12 20.5 10.1 14l-6.6-2 6.6-2L12 3.5Z" />);
}

// Tidra brand mark — the caret logo. Bobs gently while thinking.
function Orb({
  sm,
  thinking,
  className = '',
}: {
  sm?: boolean;
  thinking?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={
        'tidra-orb' +
        (sm ? ' tidra-orb-sm' : '') +
        (thinking ? ' tidra-orb-thinking' : '') +
        (className ? ' ' + className : '')
      }
    >
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

// "Tidra" wordmark — set in the PP Mondwest pixel font (styling in island.css).

export function Island() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [chat, setChat] = useState<ChatState>(EMPTY);
  const [pending, setPending] = useState<Pending | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [unread, setUnread] = useState(false);
  const [reactions, setReactions] = useState<Record<number, 'up' | 'down' | undefined>>({});
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null);
  const [panelSize, setPanelSize] = useState<{ w: number; h: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const [entered, setEntered] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // The step trail behind the one-line status — expandable "watch Tidra work".
  const [steps, setSteps] = useState<string[]>([]);
  // Manual (default): stop and ask before anything irreversible.
  // Auto: the user has approved those in advance — just do it.
  const [auto, setAuto] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  // Slash skills: the saved commands ("/summarize", "/fact-check") offered as
  // an autocomplete menu while the input starts with "/".
  const [skills, setSkills] = useState<Skill[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  // 'off' → idle, 'listening' → mic open, 'thinking' → Whisper has the clip.
  const [mic, setMic] = useState<'off' | 'listening' | 'thinking'>('off');
  // Mic trouble is shown as its own line. It must never be written into the
  // composer: that overwrites what the user typed and reads like a message
  // they are about to send.
  const [micNote, setMicNote] = useState<{ text: string; fixable?: boolean } | null>(null);
  /** Identifies this island's listening session — see toggleMic. */
  const voiceSid = useRef<string | null>(null);
  /** Set only when falling back to recording in this page — see startLocalMic. */
  const localRec = useRef<Recorder | null>(null);
  // Heard speech arrives through a storage listener registered once, so it
  // would otherwise be stuck with the very first render's state. This keeps the
  // send path pointed at the present.
  const liveRef = useRef<{ input: string; ask: (p: string, i?: 'chat' | 'act') => void }>({
    input: '',
    ask: () => {},
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef(false);
  const islandRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const panelPosRef = useRef<{ x: number; y: number } | null>(null);
  const panelSizeRef = useRef<{ w: number; h: number } | null>(null);

  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    posRef.current = pos;
  }, [pos]);
  useEffect(() => {
    panelPosRef.current = panelPos;
  }, [panelPos]);
  useEffect(() => {
    panelSizeRef.current = panelSize;
  }, [panelSize]);

  // While the panel is open, clicking anywhere outside it collapses it back
  // to the island. Uses composedPath so clicks inside the shadow DOM count as
  // "inside" even though the event retargets to the shadow host.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = panelRef.current;
      if (el && !e.composedPath().includes(el)) requestClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Keep the wheel inside the panel.
  //
  // Two separate things send a scroll to the page instead of the chat:
  //  1. Nothing under the pointer can scroll (the header, the empty thread), so
  //     the browser walks up and scrolls the page — our shadow root is no
  //     barrier to that.
  //  2. The site runs a smooth-scroll library (Lenis, Locomotive, ScrollSmoother
  //     and friends). Those listen for `wheel` on window and scroll the page
  //     themselves, without ever looking at where the pointer is — so the page
  //     moves even when the chat scrolls correctly.
  //
  // stopPropagation answers (2): the event never reaches window, so the library
  // never runs. preventDefault answers (1), but only when nothing inside the
  // panel could have used the scroll — otherwise it would block our own lists.
  useEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (!el) return;

    const canScroll = (path: EventTarget[], dx: number, dy: number) => {
      // A trackpad sends both axes at once; the bigger one is the gesture. This
      // matters for the wide tables in answers, which scroll sideways.
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const delta = horizontal ? dx : dy;
      if (!delta) return true; // no movement to absorb — nothing to block
      for (const node of path) {
        if (node === el) break;
        if (!(node instanceof HTMLElement)) continue;
        const style = getComputedStyle(node);
        const overflow = horizontal ? style.overflowX : style.overflowY;
        if (!/(auto|scroll)/.test(overflow)) continue;
        const room = horizontal
          ? node.scrollWidth - node.clientWidth
          : node.scrollHeight - node.clientHeight;
        if (room <= 1) continue;
        const at = horizontal ? node.scrollLeft : node.scrollTop;
        // Already hard against that end — it cannot absorb any more this way.
        if (delta < 0 && at <= 0) continue;
        if (delta > 0 && at >= room - 1) continue;
        return true;
      }
      return false;
    };

    const onWheel = (e: WheelEvent) => {
      e.stopPropagation();
      if (!canScroll(e.composedPath(), e.deltaX, e.deltaY)) e.preventDefault();
    };
    const onTouchMove = (e: TouchEvent) => e.stopPropagation();

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [open]);

  // Drag the open panel by its header to reposition it anywhere on screen.
  function onPanelDragStart(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return; // let header buttons work
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    let moved = false;
    const start = { x: e.clientX, y: e.clientY };

    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true;
      if (!moved) return;
      el.classList.add('tidra-panel-dragging');
      let nx = ev.clientX - offX;
      let ny = ev.clientY - offY;
      nx = Math.max(6, Math.min(nx, window.innerWidth - rect.width - 6));
      ny = Math.max(6, Math.min(ny, window.innerHeight - rect.height - 6));
      const p = { x: nx, y: ny };
      panelPosRef.current = p;
      setPanelPos(p);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.classList.remove('tidra-panel-dragging');
      if (moved && panelPosRef.current) browser.storage.local.set({ tidraPanelPos: panelPosRef.current });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Drag the bottom-right corner to grow the panel — keeps the 400:540 ratio.
  function onPanelResizeStart(e: React.PointerEvent) {
    e.stopPropagation();
    const el = panelRef.current;
    if (!el) return;
    const RATIO = 540 / 400;
    const startW = el.getBoundingClientRect().width;
    const start = { x: e.clientX, y: e.clientY };
    const minW = 320;
    const maxW = Math.min(620, window.innerWidth - 28, (window.innerHeight - 28) / RATIO);
    el.classList.add('tidra-panel-dragging');

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let w = startW + Math.max(dx, dy / RATIO); // grow from whichever axis pulled more
      w = Math.max(minW, Math.min(w, maxW));
      const s = { w: Math.round(w), h: Math.round(w * RATIO) };
      panelSizeRef.current = s;
      setPanelSize(s);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.classList.remove('tidra-panel-dragging');
      if (panelSizeRef.current) browser.storage.local.set({ tidraPanelSize: panelSizeRef.current });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Stop the in-flight request (the Stop button shown while Tidra is working).
  function stop() {
    browser.runtime.sendMessage({ type: 'tidra-stop' }).catch(() => {});
    setChat((c) => ({ ...c, loading: false }));
    setPending(null);
    browser.storage.local.get('tidraChat').then(({ tidraChat }) => {
      const chat = (tidraChat as ChatState) || EMPTY;
      browser.storage.local.set({ tidraChat: { ...chat, loading: false }, tidraPending: null });
    });
  }

  // Drag to reposition; a click (no drag) opens the panel.
  function onPointerDown(e: React.PointerEvent) {
    const el = islandRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    let last: { x: number; y: number } | null = null;

    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) moved = true;
      if (!moved) return;
      // Freeze the 3D tilt while dragging so it doesn't fight the position.
      el.classList.add('tidra-dragging');
      el.style.transform = posRef.current ? 'none' : 'translateX(-50%)';
      let nx = ev.clientX - offX;
      let ny = ev.clientY - offY;
      nx = Math.max(6, Math.min(nx, window.innerWidth - rect.width - 6));
      ny = Math.max(6, Math.min(ny, window.innerHeight - rect.height - 6));
      last = { x: nx, y: ny };
      setPos(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.classList.remove('tidra-dragging');
      if (!moved) setOpenPersist(true);
      else if (last) browser.storage.local.set({ tidraIslandPos: last });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Restore persisted state (survives navigation) + subscribe to changes
  useEffect(() => {
    loadSkills().then(setSkills).catch(() => {});
    browser.storage.local
      .get([
        'tidraOpen',
        'tidraChat',
        'tidraPending',
        'tidraIslandPos',
        'tidraPanelPos',
        'tidraPanelSize',
        'tidraUnread',
        'tidraStatus',
        'tidraSteps',
        'tidraAuto',
        'tidraJob',
      ])
      .then(({ tidraOpen, tidraChat, tidraPending, tidraIslandPos, tidraPanelPos, tidraPanelSize, tidraUnread, tidraStatus, tidraSteps, tidraAuto, tidraJob }) => {
        if (typeof tidraStatus === 'string') setStatus(tidraStatus);
        if (Array.isArray(tidraSteps)) setSteps(tidraSteps as string[]);
        setAuto(tidraAuto === true);
        if (tidraJob) setJob(tidraJob as JobView);
        if (tidraOpen) setOpen(true);
        if (tidraChat) setChat(tidraChat as ChatState);
        if (tidraPending) setPending(tidraPending as Pending);
        if (tidraIslandPos) setPos(tidraIslandPos as { x: number; y: number });
        if (tidraPanelPos) setPanelPos(tidraPanelPos as { x: number; y: number });
        if (tidraPanelSize) setPanelSize(tidraPanelSize as { w: number; h: number });
        if (tidraUnread) setUnread(true);
      });

    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (changes.tidraChat) setChat((changes.tidraChat.newValue as ChatState) ?? EMPTY);
      if (changes.tidraStatus) setStatus((changes.tidraStatus.newValue as string) ?? null);
      if (changes.tidraSteps) setSteps((changes.tidraSteps.newValue as string[]) ?? []);
      if (changes.tidraAuto) setAuto(changes.tidraAuto.newValue === true);
      if (changes.tidraOpen) setOpen(!!changes.tidraOpen.newValue);
      if (changes.tidraPending) setPending((changes.tidraPending.newValue as Pending) ?? null);
      if (changes.tidraJob) setJob((changes.tidraJob.newValue as JobView) ?? null);
      // The mic can close itself the moment you stop talking, so its state and
      // its result both arrive here rather than as the reply to a click.
      //
      // The session id is read ONCE, up front, and both branches use that copy.
      // Reading it per-branch is a trap: state and text land in the same
      // storage write, the state branch runs first and ends the session, and
      // the text that came with it is then thrown away as belonging to nobody.
      const sid = voiceSid.current;
      if (changes.tidraHeard && sid) {
        const h = changes.tidraHeard.newValue as { sid?: string; text?: string } | undefined;
        const heard = (h?.text ?? '').trim();
        if (heard && h?.sid === sid) {
          // Finishing the sentence is the send — saying something out loud and
          // then having to press a button would defeat the point of speaking.
          const typed = liveRef.current.input.trim();
          setInput('');
          liveRef.current.ask(typed ? `${typed} ${heard}` : heard);
        }
      }
      if (changes.tidraVoice) {
        const v = changes.tidraVoice.newValue as { sid?: string; state?: string; error?: string } | undefined;
        if (v && v.sid === sid) {
          setMic(v.state === 'listening' ? 'listening' : v.state === 'thinking' ? 'thinking' : 'off');
          if (v.error) setMicNote(micError(v.error));
          if (v.state === 'idle') voiceSid.current = null;
        }
      }
      if (changes.tidraUnread) setUnread(!!changes.tidraUnread.newValue);
      // Skills edited in settings show up here without a reload.
      if (changes.tidraSkills && Array.isArray(changes.tidraSkills.newValue)) {
        setSkills(changes.tidraSkills.newValue as Skill[]);
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  // Toggle from the global shortcut
  useEffect(() => {
    const listener = (message: { type?: string }) => {
      if (message?.type === 'tidra-toggle') {
        if (openRef.current) requestClose();
        else setOpenPersist(true);
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    // Always land on the latest message when the panel opens (not the top).
    // rAF so it runs after the panel/messages have laid out.
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat]);

  function setOpenPersist(v: boolean) {
    setOpen(v);
    const data: Record<string, unknown> = { tidraOpen: v };
    if (v) {
      setEntered(false); // let the panel play its enter animation once on open
      setUnread(false);
      data.tidraUnread = false;
    }
    browser.storage.local.set(data);
  }

  // Close with the iOS-style shrink-and-fade: keep the panel mounted, play the
  // exit animation, then actually collapse to the island on animationend.
  function requestClose() {
    setClosing(true);
  }

  function onPanelAnimEnd(e: React.AnimationEvent) {
    if (e.target !== e.currentTarget) return; // ignore child (orb/typing) animations
    if (closing) {
      setClosing(false);
      setOpenPersist(false);
    } else {
      // Enter animation finished — freeze animation so later class changes
      // (e.g. becoming "free" on drag) don't restart it and flash the panel.
      setEntered(true);
    }
  }

  async function ask(prompt: string, intent?: 'chat' | 'act') {
    if ((!prompt.trim() && !files.length) || chat.loading) return;
    const sending = files;
    setInput('');
    setFiles([]);
    setPending(null);
    const next: ChatState = {
      messages: [
        ...chat.messages,
        {
          role: 'user',
          text: prompt,
          files: sending.length
            ? sending.map((f) => ({
                kind: f.kind,
                name: f.name,
                thumb: f.thumb, // the 96px copy, so history stays small
              }))
            : undefined,
        },
      ],
      loading: true,
    };
    setChat(next);
    // Collapse the panel and get out of the way: the island itself reports what
    // Tidra is doing, and the answer arrives as a card you can tap to reopen.
    setClosing(false);
    setOpen(false);
    setUnread(false);
    // Persist BEFORE sending so the background reads the up-to-date chat,
    // and so the panel can restore this state after any navigation.
    await browser.storage.local.set({
      tidraChat: next,
      tidraPending: null,
      tidraOpen: false,
      tidraUnread: false,
      tidraStatus: 'Thinking',
    });
    // Fire-and-forget: the result is delivered via storage (survives navigation).
    browser.runtime
      .sendMessage({
        type: 'tidra-ask',
        prompt,
        page: extractPageContext(),
        intent,
        attachments: sending,
      })
      .catch(() => {});
  }

  useEffect(() => {
    liveRef.current = { input, ask };
  });

  // Navigating away must never leave the page's recording light on.
  useEffect(() => () => localRec.current?.cancel(), []);

  // Last resort: the mic must always come back. Every step between pressing it
  // and the words arriving happens in another context — an offscreen page, a
  // service worker that may be killed mid-sentence — and any of them can go
  // quiet. A button stuck mid-state is unusable, and 'thinking' ignores clicks,
  // so nothing would ever free it again.
  useEffect(() => {
    if (mic === 'off') return;
    const limit = mic === 'listening' ? 75_000 : 30_000; // clip cap + slack, or a transcription
    const id = setTimeout(() => {
      setMic('off');
      voiceSid.current = null;
      localRec.current?.cancel();
      localRec.current = null;
      setMicNote({ text: 'The microphone stopped responding. Press it to try again.' });
    }, limit);
    return () => clearTimeout(id);
  }, [mic]);

  function confirmSend() {
    const label = pending?.label ?? 'Send';
    setPending(null);
    ask(`Confirmed — ${label.toLowerCase()} it now by clicking the button on the page.`, 'act');
  }

  async function confirmCancel() {
    setPending(null);
    setUnread(false);
    const next: ChatState = {
      messages: [...chat.messages, { role: 'assistant', text: 'Okay — cancelled. Nothing was sent.' }],
      loading: false,
    };
    setChat(next);
    await browser.storage.local.set({ tidraChat: next, tidraPending: null, tidraUnread: false });
  }

  // Hide the answer preview card without opening the panel (message stays in
  // history; it's just no longer surfaced as unread).
  function dismissCard() {
    setUnread(false);
    browser.storage.local.set({ tidraUnread: false });
  }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const picked: Attachment[] = [];
    for (const file of Array.from(list).slice(0, MAX_ATTACHMENTS - files.length)) {
      try {
        if (file.type.startsWith('image/')) picked.push(await readImage(file));
        else if (TEXT_LIKE.test(file.type) || file.size < 512 * 1024) picked.push(await readTextFile(file));
      } catch {
        /* skip anything unreadable rather than failing the whole batch */
      }
    }
    if (picked.length) setFiles((prev) => [...prev, ...picked].slice(0, MAX_ATTACHMENTS));
  }

  // Talking to Tidra instead of typing. Click to listen, click again to send
  // it to Whisper — the words land in the input so they can be edited before
  // they go, rather than firing off a misheard sentence.
  /**
   * Fallback microphone, recorded by the page itself.
   *
   * The offscreen document is the better route — one grant, every site. But if
   * it can't record (a browser that withholds the extension-origin grant from
   * an invisible document, say), the choice is between asking THIS site for the
   * microphone and having the button silently do nothing. A prompt the user can
   * answer wins every time, even though it has to be answered per site.
   */
  async function startLocalMic(): Promise<boolean> {
    try {
      localRec.current = await record({
        onDone: (clip) => {
          localRec.current = null;
          void useLocalClip(clip);
        },
      });
      setMic('listening');
      return true;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setMicNote({
        text:
          name === 'NotAllowedError'
            ? `Allow the microphone for ${location.hostname} in the address bar, then press the mic again.`
            : name === 'NotFoundError'
              ? 'No microphone found.'
              : 'Could not start the microphone here.',
      });
      return false;
    }
  }

  async function useLocalClip(clip: Blob | null) {
    setMic('thinking');
    try {
      if (!clip || clip.size < 1200) return; // a click, not a sentence
      // Handed to the background, which is the only context allowed to reach
      // Groq from here — see blobToBase64 in lib/voice.ts.
      const res = await browser.runtime
        .sendMessage({ type: 'tidra-transcribe', audio: await blobToBase64(clip), mime: clip.type })
        .catch((err) => ({ ok: false, error: String(err) }));
      if (!res?.ok) {
        setMicNote(micError(res?.error));
        return;
      }
      const heard = String(res.text ?? '').trim();
      if (!heard) return;
      const typed = liveRef.current.input.trim();
      setInput('');
      liveRef.current.ask(typed ? `${typed} ${heard}` : heard);
    } catch (err) {
      setMicNote({ text: err instanceof Error ? err.message : 'Could not transcribe that.' });
    } finally {
      setMic('off');
    }
  }

  async function toggleMic() {
    if (mic === 'thinking') return;
    setMicNote(null);

    // A local recording in progress owns the mic — stop that one.
    if (localRec.current) {
      const rec = localRec.current;
      localRec.current = null;
      await useLocalClip(await rec.stop());
      return;
    }

    if (mic === 'off') {
      // Record in THIS page first.
      //
      // The shared offscreen recorder is the tidier idea — one permission for
      // every site — but it is an invisible document, and that turns out to
      // matter: no user gesture ever happens there, so its audio context can
      // start suspended and the end-of-speech detector goes deaf; its timers
      // are throttled; and when it fails it fails silently. Recording here
      // instead runs in exactly the environment the new tab already proves
      // works — visible, gestured, unthrottled. The cost is a permission
      // prompt per site, which is a thing the user can see and answer.
      if (await startLocalMic()) return;

      // This page refused (or has no microphone). Fall back to the shared
      // recorder, which at least has its own permission to draw on.
      const sid = Math.random().toString(36).slice(2);
      voiceSid.current = sid;
      const res = await browser.runtime
        .sendMessage({ type: 'tidra-voice', action: 'start', sid })
        .catch(() => null);
      if (res?.ok) {
        setMic('listening');
        setMicNote(null);
      } else {
        voiceSid.current = null;
        setMic('off');
      }
      return;
    }

    // Cutting it short by hand. The result still arrives via storage, same as
    // if the pause had ended it — one path, not two.
    setMic('thinking');
    const res = await browser.runtime.sendMessage({ type: 'tidra-voice', action: 'stop' }).catch(() => null);
    // Nothing was recording after all. Without this the button would sit in
    // 'thinking' forever, and 'thinking' ignores clicks — a dead mic.
    if (!res?.ok) {
      setMic('off');
      voiceSid.current = null;
    }
  }

  function micError(code?: string): { text: string; fixable?: boolean } {
    // The permission case is the only one the user can act on from here, and
    // it's the one everybody hits first — so it gets a button that goes
    // straight to the one page where Chrome will actually ask.
    if (code === 'mic-permission')
      return { text: 'Tidra needs permission to use your microphone.', fixable: true };
    if (code === 'no-microphone') return { text: 'No microphone found.' };
    if (code === 'no-key') return { text: 'Add a Groq API key in settings to use voice.', fixable: true };
    if (code === 'offscreen-unsupported')
      return { text: "This browser won't let Tidra record here. Voice works on the Tidra new tab." };
    // Anything else is shown verbatim rather than smoothed into "it failed" —
    // an unreadable error at least says what to search for.
    return { text: code ? `Voice failed — ${code}` : 'Voice failed, with no reason given.' };
  }

  function setMode(next: boolean) {
    setAuto(next);
    setModeOpen(false);
    browser.storage.local.set({ tidraAuto: next });
  }

  function clearChat() {
    // The old conversation is kept in the library, never silently destroyed.
    if (chat.messages.length) void archiveChat('island', chat.messages);
    const empty = { ...EMPTY };
    setChat(empty);
    setPending(null);
    setReactions({});
    setInput('');
    setUnread(false);
    browser.storage.local.set({ tidraChat: empty, tidraPending: null, tidraUnread: false });
    inputRef.current?.focus();
  }

  // Ask the background to open the options page; if the service worker is
  // asleep or the message fails, open it directly instead.
  function openSettings() {
    browser.runtime.sendMessage({ type: 'tidra-open-options' }).catch(() => {
      try {
        window.open(browser.runtime.getURL('/options.html'), '_blank');
      } catch {
        /* nothing else we can do from here */
      }
    });
  }

  function copyText(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function react(i: number, r: 'up' | 'down') {
    setReactions((prev) => ({ ...prev, [i]: prev[i] === r ? undefined : r }));
  }

  // The slash menu is open while the input is still a bare "/name" — the
  // moment a space or argument follows, it gets out of the way.
  const slashTyped = /^\/([a-z0-9-]*)$/i.exec(input)?.[1] ?? null;
  const slashList = slashTyped !== null ? filterSkills(slashTyped, skills) : [];
  const slashOpen = slashList.length > 0 && !chat.loading;
  const slashSel = Math.min(slashIdx, Math.max(0, slashList.length - 1));

  function completeSlash(s: Skill) {
    setInput('/' + s.name + ' ');
    setSlashIdx(0);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, slashList.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        completeSlash(slashList[slashSel]);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // A fully-typed command sends; a partial one completes first, so Enter
        // never fires a skill the user was still choosing.
        const sel = slashList[slashSel];
        if (sel.name === slashTyped!.toLowerCase()) ask(input);
        else completeSlash(sel);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(input);
    }
  }

  // A batch job is the one thing that outlives a single turn, so it gets its
  // own strip of UI: what it is, how far in, and the controls to stop it.
  const jobBusy = !!job && ['collecting', 'sampling', 'running', 'paused'].includes(job.state);

  function renderJobBar() {
    if (!job || job.state === 'cancelled') return null;
    const settled = job.done + job.failed + job.review;
    const pct = job.total ? Math.round((settled / job.total) * 100) : 0;

    if (job.state === 'collecting') {
      return (
        <div className="tidra-job">
          <span className="tidra-job-line">
            Building the list<i />
            <i />
            <i />
          </span>
        </div>
      );
    }

    // The gate. Before the first item for a reversible batch; after the first
    // one is drafted for anything that sends, so there is something real to judge.
    if (job.state === 'sampling') {
      const approving = !!job.sample;
      return (
        <div className="tidra-job">
          <span className="tidra-job-line">
            {approving
              ? `Approve this one and I'll do the other ${job.total - 1} the same way.`
              : `${job.total} item${job.total === 1 ? '' : 's'} ready.`}
          </span>
          <div className="tidra-job-btns">
            <button className="tidra-confirm-no" onClick={() => jobControl('cancel')}>
              ✕ Cancel
            </button>
            <button
              className="tidra-confirm-yes"
              onClick={() => jobControl(approving ? 'approve' : 'start')}
            >
              {approving ? `✓ Do all ${job.total}` : `▶ Start ${job.total}`}
            </button>
          </div>
        </div>
      );
    }

    if (job.state === 'done') {
      return (
        <div className="tidra-job">
          <span className="tidra-job-line">
            Finished — {job.done} of {job.total}
            {job.failed ? ` · ${job.failed} failed` : ''}
            {job.review ? ` · ${job.review} to check` : ''}
          </span>
          <div className="tidra-job-btns">
            <button className="tidra-job-ghost" onClick={() => jobControl('dismiss')}>
              Dismiss
            </button>
          </div>
        </div>
      );
    }

    const running = job.state === 'running';
    return (
      <div className="tidra-job">
        <div className="tidra-job-track">
          <div className="tidra-job-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="tidra-job-line">
          <b>
            {settled}/{job.total}
          </b>
          {job.failed ? ` · ${job.failed} failed` : ''}
          {running && job.current ? ` · ${job.current}` : running ? '' : ' · paused'}
        </span>
        <div className="tidra-job-btns">
          <button className="tidra-job-ghost" onClick={() => jobControl('cancel')}>
            Stop
          </button>
          <button className="tidra-job-ghost" onClick={() => jobControl(running ? 'pause' : 'resume')}>
            {running ? 'Pause' : 'Resume'}
          </button>
        </div>
      </div>
    );
  }

  const lastMsg = chat.messages[chat.messages.length - 1];
  const showSettingsLink = lastMsg?.role === 'error' && /API key/i.test(lastMsg.text);

  if (!open) {
    const posStyle = pos ? { left: pos.x, top: pos.y } : undefined;
    // Pending confirmation — show Confirm/Cancel right on the island
    if (pending) {
      return (
        <div
          ref={islandRef as React.RefObject<HTMLDivElement>}
          className={'tidra-island tidra-island-actions' + (pos ? ' tidra-island-free' : '')}
          style={posStyle}
        >
          <span onClick={() => setOpenPersist(true)}>
            <Orb sm />
          </span>
          <button className="tidra-mini tidra-mini-no" onClick={confirmCancel} title="Cancel">
            ✕
          </button>
          <button className="tidra-mini tidra-mini-yes" onClick={confirmSend}>
            ✓ {pending.label}
          </button>
        </div>
      );
    }

    const lastAssistant = [...chat.messages].reverse().find((m) => m.role !== 'user');
    const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
    // A running job takes over the card slot: it outlives the turn that started
    // it, so "loading" is the wrong signal — the job's own state is.
    const showJob = jobBusy && !chat.loading;
    const showCard = !chat.loading && !showJob && unread && lastAssistant;
    // While it works, the same card slot shows the request and the live step.
    const showWorking = chat.loading && lastUser;
    // Keep the answer card fully on screen — when the island is near the right
    // (or bottom) edge, its left/top would push the card off the viewport and
    // clip it. Clamp both so it always renders whole.
    const M = 8;
    const CARD_W = Math.min(340, window.innerWidth - M * 2);
    const cardStyle = pos
      ? {
          left: Math.max(M, Math.min(pos.x, window.innerWidth - CARD_W - M)),
          top: Math.max(M, Math.min(pos.y + 64, window.innerHeight - 96)),
        }
      : undefined;

    return (
      <>
        <button
          ref={islandRef as React.RefObject<HTMLButtonElement>}
          className={
            'tidra-island' +
            (chat.loading || job?.state === 'running' ? ' tidra-island-busy' : '') +
            (pos ? ' tidra-island-free' : '')
          }
          style={posStyle}
          onPointerDown={onPointerDown}
          title="Tidra — click to open, drag to move (⌘⇧Space)"
          aria-label="Open Tidra"
        >
          <Orb sm thinking={chat.loading} />
          {chat.loading && (
            <>
              <span className="tidra-island-working">
                {status || 'Working'}
                <i />
                <i />
                <i />
              </span>
              <span
                className="tidra-island-stop"
                role="button"
                title="Stop"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  stop();
                }}
              >
                <IconStop />
              </span>
            </>
          )}
        </button>

        {showJob && (
          <div
            className={'tidra-card tidra-card-working' + (pos ? ' tidra-card-free' : '')}
            style={cardStyle}
            onClick={() => setOpenPersist(true)}
            role="button"
            tabIndex={0}
            aria-label="Open Tidra to see the batch"
          >
            <span className="tidra-card-body">
              <span className="tidra-card-task">{job!.goal.replace(/\s+/g, ' ').trim()}</span>
              {job!.state === 'running' ? (
                <span className="tidra-card-step">
                  {job!.done + job!.failed + job!.review}/{job!.total}
                  {job!.current ? ` · ${job!.current}` : ''}
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <span className="tidra-card-step">
                  {job!.state === 'paused'
                    ? `Paused at ${job!.done}/${job!.total}`
                    : job!.state === 'sampling'
                      ? 'Waiting for you'
                      : 'Building the list'}
                </span>
              )}
            </span>
          </div>
        )}

        {showWorking && (
          <div
            className={'tidra-card tidra-card-working' + (pos ? ' tidra-card-free' : '')}
            style={cardStyle}
            onClick={() => setOpenPersist(true)}
            role="button"
            tabIndex={0}
            aria-label="Open Tidra to watch"
          >
            <span className="tidra-card-body">
              <span className="tidra-card-task">{lastUser!.text.replace(/\s+/g, ' ').trim()}</span>
              <span className="tidra-card-step">
                {status || 'Working'}
                <i />
                <i />
                <i />
              </span>
            </span>
          </div>
        )}

        {showCard && (
          <div
            className={'tidra-card' + (pos ? ' tidra-card-free' : '')}
            style={cardStyle}
            onClick={() => setOpenPersist(true)}
            role="button"
            tabIndex={0}
            aria-label="Open Tidra to read the reply"
          >
            <span className="tidra-card-body">
              <Wordmark className="tidra-card-title" />
              {/* Same formatting as the chat — bold, italics, code and emoji
                  render, rather than showing raw ** markers. */}
              <span className="tidra-card-text">
                {renderRich(lastAssistant!.text.replace(/\s+/g, ' ').trim())}
              </span>
            </span>
            <button
              className="tidra-card-close"
              onClick={(e) => {
                e.stopPropagation(); // dismiss the preview without opening the panel
                dismissCard();
              }}
              title="Dismiss"
              aria-label="Dismiss message"
            >
              ✕
            </button>
          </div>
        )}

      </>
    );
  }

  return (
    <div
      ref={panelRef}
      className={
        'tidra-panel' +
        (panelPos ? ' tidra-panel-free' : '') +
        (closing ? ' tidra-panel-closing' : entered ? ' tidra-panel-static' : '')
      }
      style={{
        ...(panelPos ? { left: panelPos.x, top: panelPos.y } : {}),
        ...(panelSize
          ? {
              width: panelSize.w,
              height: panelSize.h,
              // Scale text down when the panel is smaller than default (400px),
              // but never above 1 — growing the panel doesn't enlarge the fonts.
              ['--tidra-fs' as string]: String(Math.min(1, panelSize.w / 400)),
            }
          : {}),
      }}
      onAnimationEnd={onPanelAnimEnd}
    >
      <div className="tidra-header" onPointerDown={onPanelDragStart}>
        <Orb sm thinking={chat.loading} />
        <Wordmark className="tidra-title" />
        {chat.messages.length > 0 && (
          <button
            type="button"
            className="tidra-icon-btn"
            onPointerDown={(e) => e.stopPropagation()} /* never let the header drag swallow it */
            onClick={clearChat}
            title="New chat"
            aria-label="New chat"
          >
            <IconNewChat />
          </button>
        )}
        <button
          type="button"
          className="tidra-icon-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => openSettings()}
          title="Settings"
          aria-label="Settings"
        >
          <IconGear />
        </button>
        <button
          type="button"
          className="tidra-icon-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={requestClose}
          title="Close"
          aria-label="Close"
        >
          <IconClose />
        </button>
      </div>

      <div className="tidra-messages" ref={listRef}>
        {chat.messages.length === 0 && (
          <div className="tidra-empty">
            Ask about this page, or tell Tidra to open something — e.g. “open my LinkedIn profile”.
          </div>
        )}
        {chat.messages.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} className="tidra-msg tidra-msg-user">
                {m.files?.length ? (
                  <span className="tidra-msg-files">
                    {m.files.map((f, j) =>
                      f.thumb ? (
                        <img key={j} src={f.thumb} alt={f.name} title={f.name} />
                      ) : (
                        <span key={j} className="tidra-chip-doc" title={f.name}>
                          {f.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'TXT'}
                        </span>
                      ),
                    )}
                  </span>
                ) : null}
                {m.text}
              </div>
            );
          }
          if (m.role === 'error') {
            return (
              <div key={i} className="tidra-answer-error">
                {m.text}
              </div>
            );
          }
          return (
            <div key={i} className="tidra-answer">
              <div className="tidra-answer-text">{renderBlocks(m.text)}</div>
              <div className="tidra-actions">
                <button
                  className={'tidra-act' + (reactions[i] === 'up' ? ' tidra-act-on' : '')}
                  onClick={() => react(i, 'up')}
                  title="Good response"
                >
                  <IconThumb />
                </button>
                <button
                  className={'tidra-act' + (reactions[i] === 'down' ? ' tidra-act-on' : '')}
                  onClick={() => react(i, 'down')}
                  title="Bad response"
                >
                  <IconThumb down />
                </button>
                <button className="tidra-act" onClick={() => copyText(m.text)} title="Copy">
                  <IconCopy />
                </button>
              </div>
            </div>
          );
        })}
        {chat.loading && (
          <div className="tidra-typing">
            <span />
            <span />
            <span />
          </div>
        )}
        {chat.loading && steps.length > 0 && (
          <details className="tidra-steps">
            <summary>
              <StepIcon step={status || 'Working'} />
              {status || 'Working'} · {steps.length} step{steps.length === 1 ? '' : 's'}
            </summary>
            <ul>
              {steps.map((s, i) => (
                <li key={i} className={i === steps.length - 1 ? 'tidra-step-now' : ''}>
                  <StepIcon step={s} />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {showSettingsLink && (
          <button className="tidra-settings-link" onClick={() => openSettings()}>
            Open settings →
          </button>
        )}
      </div>

      {micNote && (
        <div className="tidra-micnote">
          <span>{micNote.text}</span>
          {micNote.fixable && (
            <button
              type="button"
              onClick={() => {
                openSettings();
                setMicNote(null);
              }}
            >
              Open settings
            </button>
          )}
          <button type="button" className="tidra-micnote-x" onClick={() => setMicNote(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {renderJobBar()}

      {pending && (
        <div className="tidra-confirm">
          <span className="tidra-confirm-label">Confirm before Tidra {pending.label.toLowerCase()}s?</span>
          <div className="tidra-confirm-btns">
            <button className="tidra-confirm-no" onClick={confirmCancel} disabled={chat.loading}>
              ✕ Cancel
            </button>
            <button className="tidra-confirm-yes" onClick={confirmSend} disabled={chat.loading}>
              ✓ {pending.label}
            </button>
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="tidra-attachments">
          {files.map((f, i) => (
            <span key={i} className="tidra-chip" title={f.name}>
              {f.kind === 'image' ? (
                <img src={`data:${f.mime};base64,${f.data}`} alt="" />
              ) : (
                <span className="tidra-chip-doc">TXT</span>
              )}
              <span className="tidra-chip-name">{f.name}</span>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove ${f.name}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="tidra-inputbar">
        {slashOpen && (
          <div className="tidra-slash" role="listbox" aria-label="Skills">
            {slashList.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={i === slashSel}
                className={'tidra-slash-item' + (i === slashSel ? ' tidra-slash-on' : '')}
                onMouseEnter={() => setSlashIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep the textarea focused
                  completeSlash(s);
                }}
              >
                <b>/{s.name}</b>
                <i>{s.description}</i>
                {s.mode === 'act' && <span className="tidra-slash-badge">acts</span>}
              </button>
            ))}
            <div className="tidra-slash-foot">Skills — create your own in settings</div>
          </div>
        )}
        {modeOpen && (
          <>
            <div className="tidra-mode-catch" onMouseDown={() => setModeOpen(false)} />
            <div className="tidra-mode-pop" role="dialog" aria-label="How Tidra handles sending">
              <button
                type="button"
                className={'tidra-mode-choice' + (auto ? '' : ' tidra-mode-picked')}
                onClick={() => setMode(false)}
              >
                <b>Manual</b>
                <i>Tidra drafts everything, then asks you before it sends, posts, buys or deletes.</i>
              </button>
              <button
                type="button"
                className={'tidra-mode-choice' + (auto ? ' tidra-mode-picked' : '')}
                onClick={() => setMode(true)}
              >
                <b>Auto</b>
                <i>Tidra finishes the job on its own, including the send. It won't ask first.</i>
              </button>
            </div>
          </>
        )}
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder="Ask anything — “/” for skills…"
          onChange={(e) => {
            setInput(e.target.value);
            setSlashIdx(0);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={'tidra-mode-pill' + (auto ? ' tidra-mode-pill-auto' : '')}
          onClick={() => setModeOpen((v) => !v)}
          aria-expanded={modeOpen}
          title="What Tidra may do without asking"
        >
          {auto ? 'Auto' : 'Manual'}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,text/*,.md,.csv,.json,.log,.ts,.tsx,.js,.py"
          style={{ display: 'none' }}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = ''; // let the same file be picked again
          }}
        />
        <button
          type="button"
          className="tidra-input-icon"
          onClick={() => fileRef.current?.click()}
          title="Attach an image or file"
          aria-label="Attach an image or file"
        >
          <IconPlus />
        </button>
        <button
          type="button"
          className={
            'tidra-input-icon' +
            (mic === 'listening' ? ' tidra-mic-live' : '') +
            (mic === 'thinking' ? ' tidra-mic-busy' : '')
          }
          onClick={toggleMic}
          title={mic === 'listening' ? 'Stop and send what you said' : 'Speak instead of typing'}
          aria-label={mic === 'listening' ? 'Stop listening' : 'Speak to Tidra'}
          aria-pressed={mic === 'listening'}
        >
          <IconMic />
        </button>
        {chat.loading ? (
          <button className="tidra-send tidra-send-stop" onClick={stop} aria-label="Stop">
            <IconStop />
          </button>
        ) : (
          <button
            className="tidra-send"
            onClick={() => ask(input)}
            disabled={!input.trim() && !files.length}
            aria-label="Send"
          >
            <IconArrowUp />
          </button>
        )}
      </div>

      {/* Bottom-right resize grip — drag to grow the panel (keeps proportion). */}
      <span
        className="tidra-resize"
        title="Drag to resize"
        onPointerDown={onPanelResizeStart}
      />
    </div>
  );
}
