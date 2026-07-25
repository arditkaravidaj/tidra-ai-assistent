// Batch jobs — the durable side of "do this 1000 times".
//
// A normal request runs as one agent conversation on the JS stack. That works
// up to a few dozen steps and then stops working for a reason no amount of
// prompt tuning fixes: an MV3 service worker is killed after ~30s idle, and a
// long task loses everything it was holding in memory.
//
// So a batch job keeps its state HERE — in storage — and the loop becomes a
// pump that can be restarted at any moment. Every item is claimed, worked, and
// settled as its own small transaction. Kill the worker at item 413 and the
// next tick picks up at 414 with nothing lost.
//
// This module owns the state and the transitions only. It makes no model calls
// and knows nothing about the browser tools — background.ts drives it.

/* ── Shapes ───────────────────────────────────────────────────────────────── */

/**
 * `review` is deliberately a dead end: an item that may have already fired an
 * irreversible action is never retried automatically. See `reconcile`.
 */
export type ItemState = 'pending' | 'doing' | 'done' | 'failed' | 'review';

export interface JobItem {
  /** Index in the job, and the item's identity. */
  i: number;
  /** What the user sees — a name, an address, a subject line. */
  label: string;
  /** Natural key, normalized. Used to drop duplicates when collecting. */
  key: string;
  /** The row behind the item: CSV columns, a profile URL, whatever the source gave. */
  data?: Record<string, string>;
  state: ItemState;
  attempts: number;
  /** One line describing the outcome, good or bad. */
  result?: string;
}

export type JobState =
  | 'collecting' // building the work list
  | 'sampling' // first item drafted, waiting for the user to approve the batch
  | 'running'
  | 'paused'
  | 'done'
  | 'cancelled';

export interface Job {
  id: string;
  /** The user's original request, verbatim. */
  goal: string;
  /** What to do for ONE item — the per-item instruction. */
  task: string;
  /** Where each item starts, if the work happens on a site. */
  site?: string;
  /** Tab the job works in, so items don't fight over the user's current page. */
  tabId?: number;

  total: number;
  cursor: number; // next index to consider
  done: number;
  failed: number;
  review: number;

  state: JobState;
  /** Does each item end in something irreversible (send, post, buy, delete)? */
  irreversible: boolean;
  /** The user has approved the batch policy — items may complete the send. */
  approved: boolean;
  /**
   * The first item, drafted but not sent. You cannot ask someone to confirm
   * 1000 times, so they confirm a REPRESENTATIVE ONE and the policy behind it.
   */
  sample?: string;

  /** Steps one item is allowed before it's called a failure. */
  stepsPerItem: number;
  /** Pause between items. Deliberate: 1000 sends in an hour gets an account flagged. */
  throttleMs: number;

  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Heartbeat from the live pump, so a watchdog can tell "working" from "dead". */
  beat?: number;
  /** Label of the item in flight, for the progress bar. */
  current?: string;
  /** Retry sweep counter — failures get one second chance, never more. */
  pass: number;
  lastError?: string;
}

/* ── Storage layout ───────────────────────────────────────────────────────── */
//
// The job record is small and rewritten on every item. The items are NOT: 1000
// of them is a few hundred KB, and rewriting that per item would be 200MB of
// writes over a run. So items live in chunks of 50 and only the touched chunk
// is written back.

const JOB_KEY = 'tidraJob';
const CHUNK = 50;
const MAX_ATTEMPTS = 2;

/** Hard ceiling on a single job. Past this, something has gone wrong upstream. */
export const MAX_ITEMS = 2000;

const chunkKey = (jobId: string, n: number) => `tidraJobItems:${jobId}:${n}`;
const chunkOf = (i: number) => Math.floor(i / CHUNK);

export async function loadJob(): Promise<Job | null> {
  const { [JOB_KEY]: job } = await browser.storage.local.get(JOB_KEY);
  return (job as Job) ?? null;
}

export async function saveJob(job: Job): Promise<void> {
  await browser.storage.local.set({ [JOB_KEY]: job });
}

async function loadChunk(jobId: string, n: number): Promise<JobItem[]> {
  const key = chunkKey(jobId, n);
  const store = await browser.storage.local.get(key);
  return (store[key] as JobItem[]) ?? [];
}

async function saveChunk(jobId: string, n: number, items: JobItem[]): Promise<void> {
  await browser.storage.local.set({ [chunkKey(jobId, n)]: items });
}

/** Every item, in order. For reporting — the pump never needs this. */
export async function allItems(job: Job): Promise<JobItem[]> {
  const chunks = Math.ceil(job.total / CHUNK);
  const keys = Array.from({ length: chunks }, (_, n) => chunkKey(job.id, n));
  const store = await browser.storage.local.get(keys);
  return keys.flatMap((k) => (store[k] as JobItem[]) ?? []);
}

/* ── Creating a job ───────────────────────────────────────────────────────── */

export interface NewJob {
  goal: string;
  task: string;
  site?: string;
  irreversible: boolean;
  stepsPerItem?: number;
  throttleMs?: number;
}

export function newJob(spec: NewJob): Job {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    goal: spec.goal,
    task: spec.task,
    site: spec.site,
    total: 0,
    cursor: 0,
    done: 0,
    failed: 0,
    review: 0,
    state: 'collecting',
    irreversible: spec.irreversible,
    approved: false,
    stepsPerItem: spec.stepsPerItem ?? 12,
    throttleMs: spec.throttleMs ?? (spec.irreversible ? 2500 : 400),
    createdAt: Date.now(),
    pass: 0,
  };
}

/**
 * Write the work list. Duplicates are dropped here rather than at send time —
 * a list scraped from a page routinely contains the same person twice, and
 * finding that out after two emails have gone is too late.
 */
export async function setItems(
  job: Job,
  raw: { label: string; key?: string; data?: Record<string, string> }[],
): Promise<Job> {
  const seen = new Set<string>();
  const items: JobItem[] = [];
  for (const r of raw) {
    const label = (r.label || '').trim();
    if (!label) continue;
    const key = (r.key || label).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ i: items.length, label, key, data: r.data, state: 'pending', attempts: 0 });
    if (items.length >= MAX_ITEMS) break;
  }

  for (let n = 0; n * CHUNK < items.length; n++) {
    await saveChunk(job.id, n, items.slice(n * CHUNK, (n + 1) * CHUNK));
  }
  job.total = items.length;
  job.cursor = 0;
  await saveJob(job);
  return job;
}

/* ── The item transaction ─────────────────────────────────────────────────── */

/**
 * Claim the next item and mark it `doing` BEFORE any work starts. That write is
 * the whole point: if the worker dies mid-item, the item is found in `doing` on
 * restart and can be judged rather than blindly repeated.
 */
export async function claimNext(job: Job): Promise<JobItem | null> {
  while (job.cursor < job.total) {
    const n = chunkOf(job.cursor);
    const chunk = await loadChunk(job.id, n);
    const at = job.cursor % CHUNK;
    const item = chunk[at];
    if (!item) {
      job.cursor++;
      continue;
    }
    if (item.state !== 'pending') {
      job.cursor++;
      continue;
    }
    item.state = 'doing';
    item.attempts++;
    await saveChunk(job.id, n, chunk);
    job.current = item.label;
    job.beat = Date.now();
    await saveJob(job);
    return item;
  }
  return null;
}

/** Record an item's outcome and advance. */
export async function settle(
  job: Job,
  item: JobItem,
  state: Exclude<ItemState, 'pending' | 'doing'>,
  result: string,
): Promise<void> {
  const n = chunkOf(item.i);
  const chunk = await loadChunk(job.id, n);
  const at = item.i % CHUNK;
  if (chunk[at]) {
    chunk[at].state = state;
    chunk[at].result = result.slice(0, 300);
    await saveChunk(job.id, n, chunk);
  }
  if (state === 'done') job.done++;
  else if (state === 'review') job.review++;
  else job.failed++;
  if (job.cursor === item.i) job.cursor++;
  job.beat = Date.now();
  job.current = undefined;
  await saveJob(job);
}

/** Put an item back in the queue — used when the user approves the sample. */
export async function requeue(job: Job, item: JobItem): Promise<void> {
  const n = chunkOf(item.i);
  const chunk = await loadChunk(job.id, n);
  const at = item.i % CHUNK;
  if (chunk[at]) {
    chunk[at].state = 'pending';
    chunk[at].attempts = 0;
    await saveChunk(job.id, n, chunk);
  }
  if (job.cursor > item.i) job.cursor = item.i;
  await saveJob(job);
}

/**
 * Recover from a worker that died mid-item.
 *
 * An item left in `doing` has an unknown outcome — it may have sent, or not. If
 * the job's items end in something irreversible we do NOT guess: it goes to
 * `review` for the user to check. Only reversible work is safe to retry, which
 * is the difference between "resumable" and "emails someone eleven times".
 */
export async function reconcile(job: Job): Promise<Job> {
  const chunks = Math.ceil(job.total / CHUNK);
  let done = 0;
  let failed = 0;
  let review = 0;
  let firstPending = job.total;

  for (let n = 0; n < chunks; n++) {
    const chunk = await loadChunk(job.id, n);
    let dirty = false;
    for (const item of chunk) {
      if (item.state === 'doing') {
        if (job.irreversible) {
          item.state = 'review';
          item.result = 'Interrupted mid-action — check whether this one went through.';
        } else if (item.attempts < MAX_ATTEMPTS) {
          item.state = 'pending';
        } else {
          item.state = 'failed';
          item.result = 'Interrupted, and out of attempts.';
        }
        dirty = true;
      }
      if (item.state === 'done') done++;
      else if (item.state === 'failed') failed++;
      else if (item.state === 'review') review++;
      else if (item.i < firstPending) firstPending = item.i;
    }
    if (dirty) await saveChunk(job.id, n, chunk);
  }

  job.done = done;
  job.failed = failed;
  job.review = review;
  job.cursor = Math.min(job.cursor, firstPending);
  job.current = undefined;
  await saveJob(job);
  return job;
}

/**
 * One retry sweep over reversible failures, once the first pass is through.
 * Returns true if there is more work. Irreversible items are never swept.
 */
export async function retrySweep(job: Job): Promise<boolean> {
  if (job.pass > 0 || job.irreversible) return false;
  const chunks = Math.ceil(job.total / CHUNK);
  let lowest = job.total;
  for (let n = 0; n < chunks; n++) {
    const chunk = await loadChunk(job.id, n);
    let dirty = false;
    for (const item of chunk) {
      if (item.state === 'failed' && item.attempts < MAX_ATTEMPTS) {
        item.state = 'pending';
        dirty = true;
        if (item.i < lowest) lowest = item.i;
      }
    }
    if (dirty) await saveChunk(job.id, n, chunk);
  }
  job.pass = 1;
  if (lowest === job.total) {
    await saveJob(job);
    return false;
  }
  job.failed = 0;
  job.cursor = lowest;
  await saveJob(job);
  return true;
}

/** Drop a job and every chunk it owns. */
export async function clearJob(job: Job | null): Promise<void> {
  if (job) {
    const chunks = Math.ceil(job.total / CHUNK);
    const keys = Array.from({ length: chunks }, (_, n) => chunkKey(job.id, n));
    if (keys.length) await browser.storage.local.remove(keys);
  }
  await browser.storage.local.remove(JOB_KEY);
}

/* ── Reading a work list out of an attached file ──────────────────────────── */

/** RFC4180-ish: quoted fields, doubled quotes, embedded commas and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const EMAIL_RE = /[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}/i;

/**
 * Turn a CSV/TSV into items. The label is whatever identifies a row to a human
 * — an email if there is one, otherwise a name column, otherwise the first
 * non-empty cell — and the whole row rides along as `data` for the prompt.
 */
export function itemsFromCsv(text: string): { label: string; key: string; data: Record<string, string> }[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  // A header row is one whose cells are short, non-numeric, and not an email.
  const first = rows[0].map((c) => c.trim());
  const looksHeader =
    first.every((c) => c.length > 0 && c.length < 40 && !EMAIL_RE.test(c) && !/^\d+([.,]\d+)?$/.test(c)) &&
    rows.length > 1;
  const header = looksHeader ? first.map((c) => c.toLowerCase()) : first.map((_, i) => `col${i + 1}`);
  const body = looksHeader ? rows.slice(1) : rows;

  const emailCol = header.findIndex((h) => /mail/.test(h));
  const nameCol = header.findIndex((h) => /name|person|contact|company/.test(h));

  return body.map((cells) => {
    const data: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = (cells[i] ?? '').trim();
      if (v) data[h] = v;
    });
    const inline = cells.map((c) => c.trim()).find((c) => EMAIL_RE.test(c));
    const email = (emailCol >= 0 ? cells[emailCol]?.trim() : '') || inline || '';
    const name = nameCol >= 0 ? cells[nameCol]?.trim() : '';
    const label = email || name || cells.find((c) => c.trim())?.trim() || '';
    return { label, key: (email || label).toLowerCase(), data };
  });
}

/* ── What the user is told before anything runs ───────────────────────────── */

/**
 * A rough cost/time estimate. It is deliberately shown BEFORE the first item:
 * 1000 items is real money and real hours, and approving that number is the
 * user's call, not a surprise they discover afterwards.
 */
export function estimate(job: Job, pricePerMTokens = 0.6) {
  const tokensPerStep = 1400; // a snapshot-heavy step, measured rough
  const tokens = job.total * job.stepsPerItem * tokensPerStep;
  const seconds = job.total * (job.stepsPerItem * 1.4 + job.throttleMs / 1000);
  return {
    tokens,
    dollars: (tokens / 1_000_000) * pricePerMTokens,
    minutes: Math.round(seconds / 60),
  };
}

export function humanDuration(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `about ${Math.round(minutes)} min`;
  const h = minutes / 60;
  return h < 10 ? `about ${h.toFixed(1)} h` : `about ${Math.round(h)} h`;
}
