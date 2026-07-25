// Getting a file onto the user's disk.
//
// There are two hard parts, and neither is the download itself.
//
// The first is that an MV3 service worker has no DOM: `URL.createObjectURL` does
// not exist here, so the usual "make a blob, click an <a>" is unavailable. What
// a worker can do is hand `chrome.downloads` a data: URL, which is why every
// generated file (the PDF) travels as base64.
//
// The second is that not every URL on a page is reachable from the background.
// A blob: URL belongs to the document that created it and to nothing else; some
// images are served only to a request that carries the page's own origin. So
// when the direct attempt fails, the fetch is delegated to the content script,
// which lives inside that document, and only the bytes come back.

const SETTLE_MS = 20000;

export interface SaveResult {
  ok: boolean;
  /** Where it landed, as the browser named it (it de-duplicates for us). */
  filename?: string;
  error?: string;
}

interface DownloadItem {
  id: number;
  state?: string;
  filename?: string;
  error?: string;
  bytesReceived?: number;
}

/** Wait for a started download to actually finish, so failures aren't reported as wins. */
function settle(id: number): Promise<SaveResult> {
  return new Promise((resolve) => {
    let done = false;

    const finish = async () => {
      if (done) return;
      done = true;
      browser.downloads.onChanged.removeListener(onChange);
      clearTimeout(timer);
      const [item] = ((await browser.downloads.search({ id }).catch(() => [])) as DownloadItem[]) ?? [];
      if (!item) return resolve({ ok: true }); // gone from the list, but it did start
      if (item.state === 'interrupted') {
        return resolve({ ok: false, error: item.error || 'the download was interrupted' });
      }
      resolve({ ok: true, filename: item.filename?.split(/[\\/]/).pop() });
    };

    const onChange = (delta: { id: number; state?: { current?: string } }) => {
      if (delta.id !== id) return;
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') void finish();
    };

    browser.downloads.onChanged.addListener(onChange);
    // A small file can be finished before the listener is even attached.
    void browser.downloads.search({ id }).then((items) => {
      const item = (items as DownloadItem[])[0];
      if (item && item.state !== 'in_progress') void finish();
    });
    const timer = setTimeout(() => void finish(), SETTLE_MS);
  });
}

async function viaApi(url: string, filename: string): Promise<SaveResult> {
  try {
    const id = await browser.downloads.download({ url, filename, saveAs: false });
    if (id == null) return { ok: false, error: 'the browser refused the download' };
    return await settle(id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type PageCall = (payload: Record<string, unknown>) => Promise<any>;

/** Save bytes we generated ourselves (a PDF, a text file). */
export async function saveData(
  dataUrl: string,
  filename: string,
  page?: PageCall,
): Promise<SaveResult> {
  const direct = await viaApi(dataUrl, filename);
  if (direct.ok) return direct;
  // Some builds refuse a data: URL from the worker. The page can still do it.
  if (page) {
    try {
      const res = await page({ action: 'save_blob', dataUrl, filename });
      if (res?.ok) return { ok: true, filename };
    } catch {
      /* fall through to the original error */
    }
  }
  return direct;
}

/** Save something that already exists at a URL — an image, a PDF, an export link. */
export async function saveUrl(url: string, filename: string, page?: PageCall): Promise<SaveResult> {
  const pageOnly = /^blob:/i.test(url);

  if (!pageOnly) {
    const direct = await viaApi(url, filename);
    if (direct.ok) return direct;
  }

  // Either the URL only means something inside the page, or the browser was
  // turned away (hotlink protection, a login-only asset). Read it from there.
  if (page) {
    try {
      const asset = await page({ action: 'fetch_asset', url });
      if (asset?.ok && asset.data?.dataUrl) {
        return await saveData(asset.data.dataUrl, filename, page);
      }
      if (asset?.error) return { ok: false, error: String(asset.error) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, error: pageOnly ? 'that link only exists inside the page' : 'the download was refused' };
}

/** Best-effort file extension for a URL, for when the model names no file. */
export function extFromUrl(url: string, fallback = 'bin'): string {
  try {
    const path = new URL(url).pathname;
    const ext = /\.([a-z0-9]{2,5})$/i.exec(path)?.[1];
    return ext ? ext.toLowerCase() : fallback;
  } catch {
    const ext = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1];
    return ext ? ext.toLowerCase() : fallback;
  }
}

/** A readable default name from the URL's own path. */
export function nameFromUrl(url: string, fallback: string): string {
  // A data: URL's "path" is the file's own bytes — there is no name in there.
  if (/^data:/i.test(url)) return fallback;
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const base = decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, '');
    return base || fallback;
  } catch {
    return fallback;
  }
}
