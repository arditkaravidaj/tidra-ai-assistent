// Folders on the user's disk — the "post a picture from this folder every day"
// half of a routine.
//
// An extension has no filesystem. There is no path you can hand Chrome that
// makes it read ~/Pictures, and there never will be. What there IS, is the File
// System Access API: the user picks a folder in a native picker and you are
// handed a HANDLE — a capability object, not a path. Hold the handle, keep the
// access.
//
// Two facts shape everything below.
//
// 1. A handle is structured-cloneable, so IndexedDB can store it verbatim and
//    it survives a browser restart. `chrome.storage` CANNOT — it is JSON-only,
//    and a handle put through it comes back as `{}`. So this one piece of state
//    lives in IDB while the rest of Tidra's state lives in chrome.storage.
//
// 2. The handle survives, but the PERMISSION does not. After a restart,
//    queryPermission() reports 'prompt' again, and re-granting needs a real
//    user gesture in a real page. A service worker can neither show the prompt
//    nor fake the gesture. That is why access has three states here, not two:
//    connected / needs a click / gone. The new tab is where the click happens.
//
// Both the background and the extension pages open the same database — same
// extension origin, same IDB — so nothing here is passed over messaging.

/* ── Shapes ───────────────────────────────────────────────────────────────── */

/**
 * The permission bits aren't in the DOM lib yet, so the handle is widened here
 * rather than cast at every call site.
 */
export interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission(d?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(d?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface FolderRecord {
  /** Stable id. The label can be renamed; references don't break. */
  id: string;
  /** What the user calls it — "LinkedIn photos". Also how the model names it. */
  label: string;
  /** The folder's own name on disk, shown under the label so it's identifiable. */
  name: string;
  handle: DirHandle;
  createdAt: number;
  /**
   * Files already used by a routine. A daily "post a picture from this folder"
   * has to pick a DIFFERENT one tomorrow, and the folder itself doesn't
   * remember. Names, not handles — a re-added file with the same name is the
   * same picture as far as the user is concerned.
   */
  used: string[];
}

/** 'granted' = usable now. 'prompt' = handle intact, needs one click in a page. */
export type FolderAccess = PermissionState | 'missing';

/* ── The database ─────────────────────────────────────────────────────────── */

const DB = 'tidra-fs';
const STORE = 'folders';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the folder store.'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Folder store write failed.'));
      }),
  );
}

export function listFolders(): Promise<FolderRecord[]> {
  return tx<FolderRecord[]>('readonly', (s) => s.getAll() as IDBRequest<FolderRecord[]>)
    .then((rows) => rows.sort((a, b) => a.createdAt - b.createdAt))
    .catch(() => []);
}

export function putFolder(rec: FolderRecord): Promise<unknown> {
  return tx('readwrite', (s) => s.put(rec));
}

export function removeFolder(id: string): Promise<unknown> {
  return tx('readwrite', (s) => s.delete(id));
}

/**
 * Look a folder up the way the model will refer to it — by label, loosely, or
 * by id. With no argument at all, the single connected folder if there's only
 * one, because "post a picture from my folder" is the common case.
 */
export async function findFolder(query?: string): Promise<FolderRecord | null> {
  const all = await listFolders();
  if (!all.length) return null;
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return all.length === 1 ? all[0] : null;
  return (
    all.find((f) => f.id === query) ??
    all.find((f) => f.label.toLowerCase() === q || f.name.toLowerCase() === q) ??
    all.find((f) => f.label.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)) ??
    null
  );
}

/* ── Access ───────────────────────────────────────────────────────────────── */

/**
 * Is the folder usable right now? Never throws: a folder the user deleted on
 * disk reports 'missing' rather than taking the caller down with it.
 */
export async function folderAccess(rec: FolderRecord): Promise<FolderAccess> {
  try {
    return await rec.handle.queryPermission({ mode: 'read' });
  } catch {
    return 'missing';
  }
}

/**
 * Re-grant access. Only works from a page, inside a user gesture — calling this
 * from the background does nothing but throw, which is the whole reason the
 * "Reconnect" button exists in the new tab.
 */
export async function requestFolderAccess(rec: FolderRecord): Promise<FolderAccess> {
  try {
    return await rec.handle.requestPermission({ mode: 'read' });
  } catch {
    return 'missing';
  }
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};

export function mimeOf(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export function isImage(name: string): boolean {
  return mimeOf(name).startsWith('image/');
}

export function isText(name: string): boolean {
  const m = mimeOf(name);
  return m.startsWith('text/') || m === 'application/json';
}

export interface FolderFile {
  /** Path relative to the connected folder — "june/monday.png" in a subfolder. */
  path: string;
  name: string;
  size: number;
  mime: string;
  /** Last modified, ms. "Analyse the last file" is a question about this. */
  modified: number;
  /** Set when the file has already been used by a routine. */
  used: boolean;
}

export interface Listing {
  files: FolderFile[];
  /** Subfolder paths, so the model can ask for one instead of getting everything. */
  dirs: string[];
  /** Files the cap left out. Reported, never silently dropped. */
  omitted: number;
  /** Subfolders the depth limit stopped at. */
  unexplored: string[];
}

/**
 * Walk the folder — names and sizes only, never contents.
 *
 * Everything here is about NOT reading too much. The model gets a directory
 * listing, which is a few tokens per file, and asks for the one file it wants;
 * a folder of a thousand holiday photos costs the same as a folder of ten. Both
 * limits below exist for the same reason, and both are reported rather than
 * silently applied — a listing that quietly stops at 300 reads as "that's
 * everything", which is how a routine ends up ignoring half the folder.
 */
export async function listTree(
  rec: FolderRecord,
  opts: {
    imagesOnly?: boolean;
    depth?: number;
    cap?: number;
    sub?: string;
    /**
     * 'newest' is what "the last file in that folder" means — and it has to be
     * applied while walking, not after, or the cap keeps the alphabetical first
     * 300 and throws away the very file that was asked for.
     */
    sort?: 'name' | 'newest';
  } = {},
): Promise<Listing> {
  const { imagesOnly = false, depth = 2, cap = 300, sort = 'name' } = opts;
  const used = new Set(rec.used);
  const files: FolderFile[] = [];
  const dirs: string[] = [];
  const unexplored: string[] = [];
  let omitted = 0;

  const root = opts.sub ? await resolveDir(rec, opts.sub) : rec.handle;

  async function walk(dir: FileSystemDirectoryHandle, prefix: string, left: number) {
    // `entries()` is async-iterable but not in the DOM lib's types yet.
    const it = dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
    for await (const [name, handle] of it.entries()) {
      if (name.startsWith('.')) continue; // .DS_Store and friends
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        dirs.push(path);
        if (left > 0) await walk(handle as FileSystemDirectoryHandle, path, left - 1);
        else unexplored.push(path);
        continue;
      }
      if (imagesOnly && !isImage(name)) continue;
      // Sorting by name, the cap can be applied here: what comes later is what
      // gets dropped either way, and the size of a file nobody will see is not
      // worth a syscall. Sorting by date it CANNOT — the newest file might be
      // the last one the walk reaches, so every candidate has to be read first.
      if (sort === 'name' && files.length >= cap) {
        omitted++;
        continue;
      }
      const file = await (handle as FileSystemFileHandle).getFile();
      files.push({
        path,
        name,
        size: file.size,
        mime: mimeOf(name),
        modified: file.lastModified,
        used: used.has(path),
      });
    }
  }

  await walk(root, opts.sub ?? '', Math.max(0, depth - 1));
  if (sort === 'newest') {
    files.sort((a, b) => b.modified - a.modified);
    omitted = Math.max(0, files.length - cap);
    files.length = Math.min(files.length, cap);
  } else {
    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }
  return { files, dirs: dirs.sort(), omitted, unexplored };
}

/**
 * The next file a routine hasn't used yet, or null when the folder is exhausted.
 * Every file type, not just images — "attach the next one" is as likely to mean
 * a PDF going onto an email as a photo going onto a post.
 */
export async function nextUnused(rec: FolderRecord, imagesOnly = false): Promise<FolderFile | null> {
  const { files } = await listTree(rec, { imagesOnly, cap: 5000 });
  return files.find((f) => !f.used) ?? null;
}

/** Remember that a file has been used, so tomorrow's run picks the next one. */
export async function markUsed(rec: FolderRecord, path: string): Promise<void> {
  if (rec.used.includes(path)) return;
  rec.used = [...rec.used, path];
  await putFolder(rec);
}

/* ── Resolving a path inside the folder ───────────────────────────────────── */

/**
 * Walk "june/monday.png" down to its handle. `..` is rejected outright: the
 * connected folder is the entire world Tidra is allowed to see, and a path that
 * climbs out of it is either a mistake or an attempt to leave the sandbox the
 * user thought they were granting.
 */
function segments(path: string): string[] {
  const parts = path.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error('Paths cannot leave the connected folder.');
  return parts;
}

async function resolveDir(rec: FolderRecord, path: string): Promise<FileSystemDirectoryHandle> {
  let dir: FileSystemDirectoryHandle = rec.handle;
  for (const seg of segments(path)) dir = await dir.getDirectoryHandle(seg);
  return dir;
}

async function resolveFile(rec: FolderRecord, path: string): Promise<FileSystemFileHandle> {
  const parts = segments(path);
  const name = parts.pop();
  if (!name) throw new Error('No file name given.');
  let dir: FileSystemDirectoryHandle = rec.handle;
  for (const seg of parts) dir = await dir.getDirectoryHandle(seg);
  return dir.getFileHandle(name);
}

/**
 * Base64, chunked. A 4MB photo is 4M arguments to `String.fromCharCode` if you
 * spread it in one go, which overflows the call stack — hence the window.
 * (`FileReader` would do this too, but it isn't available in a service worker.)
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export interface FileBytes {
  name: string;
  mime: string;
  size: number;
  /** Base64. Extension messaging is JSON-only — a Blob or ArrayBuffer arrives as `{}`. */
  base64: string;
}

/**
 * Size and type without reading the file. Separate from `readFile` on purpose:
 * a size limit has to be enforced BEFORE a 500MB video is pulled into a service
 * worker's memory, not after.
 */
export async function statFile(
  rec: FolderRecord,
  path: string,
): Promise<{ name: string; size: number; mime: string }> {
  const file = await (await resolveFile(rec, path)).getFile();
  return { name: file.name, size: file.size, mime: file.type || mimeOf(path) };
}

/**
 * The whole file as base64 — for handing to a PAGE, never to the model. The
 * only caller is the upload path, where the bytes go into a file input and what
 * comes back into the conversation is one line of text.
 */
export async function readFile(rec: FolderRecord, path: string): Promise<FileBytes> {
  const file = await (await resolveFile(rec, path)).getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, mime: file.type || mimeOf(path), size: file.size, base64: bytesToBase64(bytes) };
}

/**
 * A text file's contents, truncated. This one DOES enter the conversation, so
 * it is capped in characters rather than bytes and says when it cut — a model
 * that can't tell a truncated file from a complete one will happily summarise
 * the first page as if it were the whole document.
 */
export async function readText(
  rec: FolderRecord,
  path: string,
  maxChars = 20000,
): Promise<{ name: string; size: number; text: string; truncated: boolean }> {
  const file = await (await resolveFile(rec, path)).getFile();
  // Read a bounded slice: a 2GB log should not become a 2GB string first.
  const raw = await file.slice(0, maxChars * 4).text();
  return {
    name: file.name,
    size: file.size,
    text: raw.slice(0, maxChars),
    truncated: raw.length > maxChars || file.size > maxChars * 4,
  };
}

/* ── Connecting ───────────────────────────────────────────────────────────── */

/** Is there a folder picker in this browser at all? */
export function pickerAvailable(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * Why there is no picker — which is a different answer per browser, and the
 * difference matters. Brave HAS the API and ships it switched off, so the user
 * is one flag away; Firefox and Safari have never implemented it, so they are
 * not. "Not supported" would be wrong for the Brave user and useless for both.
 */
export async function noPickerReason(): Promise<string> {
  const brave = (navigator as { brave?: { isBrave?: () => Promise<boolean> } }).brave;
  if (await brave?.isBrave?.().catch(() => false)) {
    return 'Brave ships the folder picker switched off. Open brave://flags, search for "File System Access API", set it to Enabled and restart Brave — then this button works.';
  }
  return 'This browser has no folder picker. Folders need Chrome, Edge or Brave (with the File System Access API flag on) — Firefox and Safari have never shipped the API.';
}

/**
 * Show the picker and remember what comes back. Page-only, gesture-only.
 * Returns null when the user cancels — which is not an error and shouldn't be
 * reported as one.
 */
export async function connectFolder(label?: string): Promise<FolderRecord | null> {
  const picker = (globalThis as { showDirectoryPicker?: (o?: unknown) => Promise<DirHandle> })
    .showDirectoryPicker;
  if (!picker) throw new Error(await noPickerReason());
  let handle: DirHandle;
  try {
    // `id` makes Chrome reopen the picker where it was left last time.
    handle = await picker({ mode: 'read', id: 'tidra-folder', startIn: 'pictures' });
  } catch {
    return null; // cancelled
  }
  // Same folder picked twice: keep the original record (and its used-list)
  // rather than growing a duplicate row the user has to clean up.
  for (const existing of await listFolders()) {
    if (await existing.handle.isSameEntry(handle).catch(() => false)) {
      if (label?.trim()) existing.label = label.trim();
      existing.handle = handle;
      await putFolder(existing);
      return existing;
    }
  }
  const rec: FolderRecord = {
    id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    label: label?.trim() || handle.name,
    name: handle.name,
    handle,
    createdAt: Date.now(),
    used: [],
  };
  await putFolder(rec);
  return rec;
}
