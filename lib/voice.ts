// Voice input — Groq Whisper.
//
// Input only — you talk, Tidra writes back. There is deliberately no speech
// OUTPUT anywhere in the extension: Tidra never makes a sound.
//
// Listening costs almost nothing. whisper-large-v3-turbo is $0.04 per HOUR of
// audio and runs ~216x faster than real time, so a ten-second question is about
// a hundredth of a cent and comes back in well under a second. Speaking would
// be the opposite: Groq's TTS is $22 per 1M characters, which makes reading one
// answer aloud cost more than a hundred spoken questions.

/** Billed by audio duration, so this is the cheap one. */
export const WHISPER_MODEL = 'whisper-large-v3-turbo';

const TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/** Whisper's own upper bound is 25 MB; a minute of opus is ~120 KB. */
export const MAX_CLIP_MS = 60_000;

/**
 * Send a recorded clip to Whisper and get the words back.
 *
 * No `language` is passed on purpose: Whisper detects it, which matters here
 * because Tidra answers in whatever language it was addressed in, and its user
 * switches between them mid-sentence.
 */
export async function transcribe(apiKey: string, clip: Blob, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  // The extension records webm/opus; the filename is what tells Groq the format.
  form.append('file', clip, 'speech.webm');
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'text');
  form.append('temperature', '0');

  const res = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.text()).trim();
}

/** What a clip of this length cost, for the settings screen. */
export function clipCost(ms: number): number {
  const billedSeconds = Math.max(10, ms / 1000); // Groq bills a 10s minimum
  return (billedSeconds / 3600) * 0.04;
}

/* ── Recording ────────────────────────────────────────────────────────────── */

export interface Recorder {
  /** Resolves with the recorded clip, or null if nothing was captured. */
  stop(): Promise<Blob | null>;
  cancel(): void;
}

/** Why a recording ended on its own. */
export type StopReason = 'silence' | 'no-speech' | 'timeout';

export interface RecordOptions {
  /** Called when the recording ends by itself, rather than by a click. */
  onDone?: (clip: Blob | null, reason: StopReason) => void;
  /** Live input level, 0–1, for a meter. */
  onLevel?: (level: number) => void;
  /** Set false for plain click-to-start, click-to-stop. */
  autoStop?: boolean;
}

/** Quiet for this long after speech = the sentence is finished. */
const SILENCE_MS = 1200;
/** Opened the mic and said nothing at all — close it rather than bill for air. */
const NO_SPEECH_MS = 6000;
/** Ambient noise is measured for this long before any of it counts as speech. */
const CALIBRATE_MS = 400;

/**
 * Start recording from the microphone.
 *
 * Only ever called from an extension-origin page (the new tab, or the offscreen
 * document) — never from a content script. In a content script getUserMedia
 * runs against the HOST page's origin, which means a permission prompt on every
 * new site and a hard block on any site whose Permissions-Policy forbids it.
 * The extension origin is granted once and works everywhere after that.
 */
export async function record(opts: RecordOptions = {}): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.start();

  let closed: Promise<Blob | null> | null = null;
  let teardownVad: (() => void) | null = null;
  let capId: ReturnType<typeof setTimeout>;
  const release = () => {
    teardownVad?.();
    clearTimeout(capId);
    stream.getTracks().forEach((t) => t.stop());
  };

  // Both the click and the silence detector land here, and only the first one
  // does anything — otherwise a click landing just as speech ends would try to
  // stop a recorder that is already closing.
  const finish = (): Promise<Blob | null> => {
    if (closed) return closed;
    closed = new Promise<Blob | null>((resolve) => {
      const done = () => {
        release();
        resolve(chunks.length ? new Blob(chunks, { type: mime }) : null);
      };
      if (rec.state === 'inactive') return done();
      rec.onstop = done;
      rec.stop();
    });
    return closed;
  };

  // A stuck recording is a runaway cost and a 25 MB ceiling, so cap it.
  capId = setTimeout(() => void finish().then((clip) => opts.onDone?.(clip, 'timeout')), MAX_CLIP_MS);

  teardownVad =
    opts.autoStop === false
      ? null
      : listenForSilence(stream, opts.onLevel, (reason) => {
          void finish().then((clip) => opts.onDone?.(clip, reason));
        });

  return {
    stop: finish,
    cancel() {
      release();
      closed = Promise.resolve(null);
      if (rec.state !== 'inactive') rec.stop();
    },
  };
}

/**
 * End-of-speech detection, so the mic closes itself when you stop talking.
 *
 * Two things make this behave in a real room rather than a lab:
 *
 * 1. The noise floor is MEASURED for the first 400ms and the speech threshold
 *    is set above it. A fixed threshold either never triggers in a café or cuts
 *    people off in a silent room.
 * 2. Silence only counts once speech has actually started. Otherwise the mic
 *    would close in the moment between clicking it and drawing breath.
 *
 * The level meter runs off a ScriptProcessorNode rather than requestAnimationFrame
 * or a timer, deliberately: the island records inside a hidden offscreen
 * document, where rAF never fires and timers can be throttled to a crawl. Audio
 * callbacks come off the audio thread and keep coming regardless.
 */
function listenForSilence(
  stream: MediaStream,
  onLevel: ((level: number) => void) | undefined,
  onEnd: (reason: StopReason) => void,
): () => void {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(2048, 1, 1);

  const startedAt = Date.now();
  let floor = 0;
  let floorSamples = 0;
  let speaking = false;
  let lastLoud = 0;
  let ended = false;

  node.onaudioprocess = (e) => {
    if (ended) return;
    const buf = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    onLevel?.(Math.min(1, rms * 8));

    const elapsed = Date.now() - startedAt;
    if (elapsed < CALIBRATE_MS) {
      floor = (floor * floorSamples + rms) / (floorSamples + 1);
      floorSamples++;
      return;
    }

    // Comfortably above the room, but never so low that breathing counts.
    const threshold = Math.max(floor * 2.5, 0.012);
    const now = Date.now();
    if (rms > threshold) {
      speaking = true;
      lastLoud = now;
      return;
    }
    if (speaking && now - lastLoud > SILENCE_MS) {
      ended = true;
      onEnd('silence');
    } else if (!speaking && elapsed > NO_SPEECH_MS) {
      ended = true;
      onEnd('no-speech');
    }
  };

  source.connect(node);
  // ScriptProcessorNode only runs when it reaches a destination. A zero gain
  // node keeps the graph alive without playing the microphone back at the user.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);

  return () => {
    ended = true;
    node.onaudioprocess = null;
    try {
      source.disconnect();
      node.disconnect();
      mute.disconnect();
    } catch {
      /* already torn down */
    }
    void ctx.close().catch(() => {});
  };
}
