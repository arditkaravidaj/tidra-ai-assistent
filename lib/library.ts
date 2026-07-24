// The library — Tidra's local "Files": reports it has written and chats you've
// finished with. Everything lives in browser.storage.local, nothing leaves the
// device. The viewer/list UI is entrypoints/report/.

export interface Report {
  id: string;
  title: string;
  subtitle?: string;
  /** The whole document, as markdown. */
  markdown: string;
  createdAt: number;
  source: 'chat' | 'routine';
}

export interface ArchivedChat {
  id: string;
  ts: number;
  source: 'island' | 'newtab';
  /** First user message, for the list. */
  title: string;
  messages: { role: string; text: string }[];
}

const REPORTS_KEY = 'tidraReports';
const CHATS_KEY = 'tidraChatArchive';
const MAX_REPORTS = 100;
const MAX_CHATS = 30;

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** chrome-extension://…/report.html?id=… — the viewer for one report. */
export function reportUrl(id?: string): string {
  const base = browser.runtime.getURL('/report.html');
  return id ? `${base}?id=${encodeURIComponent(id)}` : base;
}

export async function loadReports(): Promise<Report[]> {
  const { [REPORTS_KEY]: raw } = await browser.storage.local.get(REPORTS_KEY);
  return Array.isArray(raw) ? (raw as Report[]) : [];
}

/** Prepend (newest first) and cap. Returns the saved report. */
export async function saveReport(
  r: Omit<Report, 'id' | 'createdAt'> & { id?: string },
): Promise<Report> {
  const report: Report = { id: r.id ?? newId(), createdAt: Date.now(), ...r } as Report;
  const all = await loadReports();
  const next = [report, ...all.filter((x) => x.id !== report.id)].slice(0, MAX_REPORTS);
  await browser.storage.local.set({ [REPORTS_KEY]: next });
  return report;
}

export async function deleteReport(id: string): Promise<Report[]> {
  const next = (await loadReports()).filter((r) => r.id !== id);
  await browser.storage.local.set({ [REPORTS_KEY]: next });
  return next;
}

export async function loadChats(): Promise<ArchivedChat[]> {
  const { [CHATS_KEY]: raw } = await browser.storage.local.get(CHATS_KEY);
  return Array.isArray(raw) ? (raw as ArchivedChat[]) : [];
}

/**
 * Keep a finished conversation. Called when the user starts a new chat —
 * clearing should never silently destroy what came before it.
 */
export async function archiveChat(
  source: ArchivedChat['source'],
  messages: { role: string; text: string }[],
): Promise<void> {
  const meaningful = messages.filter((m) => m.text?.trim());
  if (!meaningful.length) return;
  const firstUser = meaningful.find((m) => m.role === 'user');
  const chat: ArchivedChat = {
    id: newId(),
    ts: Date.now(),
    source,
    title: (firstUser?.text ?? meaningful[0].text).slice(0, 120),
    messages: meaningful,
  };
  const all = await loadChats();
  await browser.storage.local.set({ [CHATS_KEY]: [chat, ...all].slice(0, MAX_CHATS) });
}

export async function deleteChat(id: string): Promise<ArchivedChat[]> {
  const next = (await loadChats()).filter((c) => c.id !== id);
  await browser.storage.local.set({ [CHATS_KEY]: next });
  return next;
}
