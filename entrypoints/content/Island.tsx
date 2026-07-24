import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Wordmark } from '../../components/Wordmark';

// Minimal inline markdown → JSX: **bold**, *italic*/_italic_, `code`.
// Newlines are preserved by CSS (white-space: pre-wrap); emoji pass through.
function renderRich(text: string): ReactNode {
  const re = /(\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|`([^`]+?)`)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null || m[3] != null) out.push(<strong key={k++}>{m[2] ?? m[3]}</strong>);
    else if (m[4] != null || m[5] != null) out.push(<em key={k++}>{m[4] ?? m[5]}</em>);
    else if (m[6] != null) out.push(<code key={k++}>{m[6]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

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
  const [unread, setUnread] = useState(false);
  const [reactions, setReactions] = useState<Record<number, 'up' | 'down' | undefined>>({});
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null);
  const [panelSize, setPanelSize] = useState<{ w: number; h: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const [entered, setEntered] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Manual (default): stop and ask before anything irreversible.
  // Auto: the user has approved those in advance — just do it.
  const [auto, setAuto] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
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

  // While collapsed: the island tilts in 3D toward the cursor (and drifts a
  // few px toward it), and the orb's pupil follows the mouse.
  useEffect(() => {
    if (open) return;
    const onMove = (e: MouseEvent) => {
      const isl = islandRef.current;
      if (isl && !isl.classList.contains('tidra-dragging') && !isl.classList.contains('tidra-island-actions')) {
        const ir = isl.getBoundingClientRect();
        const icx = ir.left + ir.width / 2;
        const icy = ir.top + ir.height / 2;
        const nx = Math.max(-1, Math.min(1, (e.clientX - icx) / 400));
        const ny = Math.max(-1, Math.min(1, (e.clientY - icy) / 400));
        const ry = nx * 12; // turn left/right toward cursor
        const rx = -ny * 9; // tip up/down toward cursor
        const base = posRef.current ? '' : 'translateX(-50%) ';
        isl.style.transform = `${base}translate(${nx * 4}px, ${ny * 4}px) perspective(520px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [open]);

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
        'tidraAuto',
      ])
      .then(({ tidraOpen, tidraChat, tidraPending, tidraIslandPos, tidraPanelPos, tidraPanelSize, tidraUnread, tidraStatus, tidraAuto }) => {
        if (typeof tidraStatus === 'string') setStatus(tidraStatus);
        setAuto(tidraAuto === true);
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
      if (changes.tidraAuto) setAuto(changes.tidraAuto.newValue === true);
      if (changes.tidraOpen) setOpen(!!changes.tidraOpen.newValue);
      if (changes.tidraPending) setPending((changes.tidraPending.newValue as Pending) ?? null);
      if (changes.tidraUnread) setUnread(!!changes.tidraUnread.newValue);
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

  function setMode(next: boolean) {
    setAuto(next);
    setModeOpen(false);
    browser.storage.local.set({ tidraAuto: next });
  }

  function clearChat() {
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

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(input);
    }
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
    const showCard = !chat.loading && unread && lastAssistant;
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
            'tidra-island' + (chat.loading ? ' tidra-island-busy' : '') + (pos ? ' tidra-island-free' : '')
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
              <div className="tidra-answer-text">{renderRich(m.text)}</div>
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
        {showSettingsLink && (
          <button className="tidra-settings-link" onClick={() => openSettings()}>
            Open settings →
          </button>
        )}
      </div>

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
          placeholder="Ask another question…"
          onChange={(e) => setInput(e.target.value)}
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
        <button className="tidra-input-icon" title="Voice (coming soon)" tabIndex={-1}>
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
