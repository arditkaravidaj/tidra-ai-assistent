// The microphone lives here.
//
// This page is invisible and has no UI. It exists for one reason: it runs at
// the extension's origin, so a single microphone grant covers every site the
// island appears on. The island itself is a content script and could never do
// this — see lib/voice.ts.
//
// It also does the Whisper call itself rather than shipping audio back to the
// background worker. Extension messages are JSON, so a clip would have to be
// base64'd across the boundary for no reason: the text is what anyone wants.
//
// Results are PUSHED to the background rather than returned. The recording
// usually ends because the speaker stopped talking, and at that moment nobody
// is waiting on a reply — the island has long since finished its "start" call.

import { record, transcribe, type Recorder, type StopReason } from '../../lib/voice';

let recorder: Recorder | null = null;

function tell(payload: Record<string, unknown>): void {
  browser.runtime.sendMessage({ type: 'tidra-voice-result', ...payload }).catch(() => {});
}

/** Turn a finished clip into words and hand them onward. */
async function deliver(clip: Blob | null, reason: StopReason | 'manual'): Promise<void> {
  // Under ~1 KB is a click or a cough, not a sentence. Groq bills a ten-second
  // minimum per request, so there is no reason to send silence.
  if (!clip || clip.size < 1200) {
    tell({ state: 'idle', text: '', reason });
    return;
  }
  tell({ state: 'thinking' });

  const { tidraGroqKey } = await browser.storage.local.get('tidraGroqKey');
  if (!tidraGroqKey) return tell({ state: 'idle', error: 'no-key' });

  try {
    tell({ state: 'idle', text: await transcribe(tidraGroqKey as string, clip), reason });
  } catch (err) {
    tell({ state: 'idle', error: err instanceof Error ? err.message : String(err) });
  }
}

async function start(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (recorder) return { ok: true }; // already listening
  try {
    recorder = await record({
      // The mic closes itself when the sentence ends. This is the path that
      // matters — the button is just an override.
      onDone: (clip, reason) => {
        recorder = null;
        void deliver(clip, reason);
      },
    });
    tell({ state: 'listening' });
    return { ok: true };
  } catch (err) {
    recorder = null;
    // NotAllowedError here means the extension has never been granted the mic.
    // That grant can only come from a visible page, so say where to do it.
    const name = (err as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return { ok: false, error: 'mic-permission' };
    if (name === 'NotFoundError') return { ok: false, error: 'no-microphone' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The user pressed the button instead of waiting for the pause. */
async function stop(): Promise<{ ok: boolean }> {
  const rec = recorder;
  recorder = null;
  if (!rec) return { ok: false };
  await deliver(await rec.stop(), 'manual');
  return { ok: true };
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // A distinct type, because the background worker and every content script see
  // this same event — only this document should act on it.
  if (message?.type !== 'tidra-voice-offscreen') return;
  if (message.action === 'start') {
    start().then(sendResponse);
    return true;
  }
  if (message.action === 'stop') {
    stop().then(sendResponse);
    return true;
  }
  if (message.action === 'cancel') {
    recorder?.cancel();
    recorder = null;
    tell({ state: 'idle' });
    sendResponse({ ok: true });
    return;
  }
});
