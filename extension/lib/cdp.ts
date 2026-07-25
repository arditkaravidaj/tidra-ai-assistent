// Trusted input via the debugger API (Chrome DevTools Protocol).
//
// A content script can only dispatch synthetic events — isTrusted:false — and
// some apps (canvas UIs, isTrusted checks, exotic frameworks) ignore those
// entirely. Input.dispatchMouseEvent through chrome.debugger produces input the
// page cannot tell from a real mouse. This is exactly how Claude-in-Chrome and
// Playwright click.
//
// The cost: while a tab is attached, Chrome shows a "Tidra started debugging
// this browser" bar. So attachment is lazy — only when a trusted click is
// actually needed — and every agent run detaches on the way out.

const cdp = (globalThis as any).chrome?.debugger;

const attached = new Set<number>();

// The whole chrome.debugger API is callback-style in older Chromes; wrapping it
// once here keeps the rest promise-shaped without caring about the version.
function call<T>(fn: (cb: (result?: T) => void) => void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    try {
      fn((result?: T) => {
        const err = (globalThis as any).chrome?.runtime?.lastError;
        if (err) reject(new Error(err.message || 'debugger error'));
        else resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// The user can close the info bar (or the tab) at any time — keep the set true.
cdp?.onDetach?.addListener((source: { tabId?: number }) => {
  if (source?.tabId != null) attached.delete(source.tabId);
});

export function cdpAvailable(): boolean {
  return !!cdp;
}

async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await call((cb) => cdp.attach({ tabId }, '1.3', cb));
  attached.add(tabId);
}

function send(tabId: number, method: string, params: Record<string, unknown>) {
  return call((cb) => cdp.sendCommand({ tabId }, method, params, cb));
}

/** Trusted left click at CSS viewport coordinates of the tab's top frame. */
export async function cdpClick(tabId: number, x: number, y: number): Promise<void> {
  await attach(tabId);
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' });
  await new Promise((r) => setTimeout(r, 60));
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

/** Drop every attachment (and its info bar). Called when an agent run ends. */
export async function cdpDetachAll(): Promise<void> {
  for (const tabId of [...attached]) {
    attached.delete(tabId);
    await call((cb) => cdp.detach({ tabId }, cb)).catch(() => {});
  }
}
