// Site memory — what Tidra has learned about the sites it acts on.
//
// Two kinds of memory, injected into the prompt only when the agent is about
// to act on that domain:
//  - notes: one-line facts about how the site works ("the compose button is
//    labelled New message", "search lives in the top nav")
//  - recipes: the step sequence of a past successful task, shown to the model
//    as a worked example so it follows the known path instead of re-exploring
//    the site snapshot by snapshot.
//
// Distilling happens in background.ts after a successful act-run (one cheap
// model call, fire-and-forget). This module only owns the storage and the
// matching. Everything is capped: memory that grows without bound stops being
// memory and starts being cost.

export interface Recipe {
  /** The user request this path solved — matched by word overlap, not equality. */
  task: string;
  /** Short imperative steps: "click the Compose button", "fill the To field". */
  steps: string[];
  updated: number;
}

export interface SiteMemory {
  notes: string[];
  recipes: Recipe[];
  updated: number;
}

const KEY = 'tidraSiteMemory';
const MAX_DOMAINS = 40;
const MAX_NOTES = 6;
const MAX_RECIPES = 3;

type Store = Record<string, SiteMemory>;

export function domainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h || null;
  } catch {
    return null;
  }
}

/**
 * Notes Tidra knows before it has ever visited a site.
 *
 * These all say the same thing in different clothes: when an app has a query
 * console, one query beats forty pages of clicking. That is not something a
 * run can discover cheaply — it learns the click path, succeeds slowly, and
 * saves the slow path as the recipe. So the shortcut is seeded.
 *
 * Matched on the registrable domain (see domainOf), and merged ahead of
 * anything learned, which may add to it but never has to rediscover it.
 */
const BUILTIN_NOTES: Record<string, string[]> = {
  'supabase.com': [
    "For any question about the DATA itself — counts, lookups, what a given user did, anything spanning more than one table — open the SQL Editor from the left sidebar and run ONE SQL query. Never page through the Table Editor row by row. Use information_schema.columns or pg_catalog to find which tables carry a column before querying them.",
  ],
  'console.firebase.google.com': [
    'Collections are browsed one document at a time, which is slow. Prefer the query bar / filter on a collection over paging, and say so if a question would need a full scan.',
  ],
  'metabase.com': [
    'Use the native SQL editor ("New → SQL query") for anything a saved question does not already answer — do not rebuild it in the visual query builder.',
  ],
  'admin.google.com': [
    'Reports and Audit pages accept filters directly in the URL query string; setting them there beats clicking through the filter menus.',
  ],
};

async function loadAll(): Promise<Store> {
  const { [KEY]: v } = await browser.storage.local.get(KEY);
  return (v as Store) ?? {};
}

/** Learned memory for a domain, with its built-in notes merged in front. */
export async function getSiteMemory(domain: string | null): Promise<SiteMemory | null> {
  if (!domain) return null;
  const learned = (await loadAll())[domain] ?? null;
  const builtin = BUILTIN_NOTES[domain] ?? [];
  if (!learned) {
    return builtin.length ? { notes: [...builtin], recipes: [], updated: 0 } : null;
  }
  return { ...learned, notes: [...builtin, ...learned.notes] };
}

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'on', 'in', 'for', 'and', 'my', 'this', 'that',
  'with', 'it', 'at', 'me', 'please', 'can', 'you', 'about',
]);

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9@]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function hits(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** Similarity, measured against the LONGER text — for "are these the same?". */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  return hits(a, b) / Math.max(a.size, b.size);
}

/**
 * Similarity measured against the SHORTER text — for "does this add anything?".
 * A one-line note restating part of a long one scores near 0 on overlap, since
 * the long note's other words drown it; here it scores near 1, which is what
 * "we already know this" actually means.
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  return hits(a, b) / Math.min(a.size, b.size);
}

/** Best past recipe for this task, or null when nothing is close enough. */
export function matchRecipe(mem: SiteMemory | null, task: string): Recipe | null {
  if (!mem?.recipes.length) return null;
  const t = words(task);
  let best: Recipe | null = null;
  let bestScore = 0;
  for (const r of mem.recipes) {
    const score = overlap(t, words(r.task));
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  // Below this the "similar" task is usually a different task; a wrong recipe
  // is worse than none because the model will dutifully follow it.
  return bestScore >= 0.4 ? best : null;
}

/** The prompt block for an act-run on this domain, or '' when we know nothing. */
export function siteHint(mem: SiteMemory | null, task: string): string {
  if (!mem) return '';
  const parts: string[] = [];
  if (mem.notes.length) {
    parts.push(
      `What Tidra learned about this site in past runs:\n${mem.notes.map((n) => `- ${n}`).join('\n')}`,
    );
  }
  const recipe = matchRecipe(mem, task);
  if (recipe) {
    parts.push(
      [
        `A similar task ("${recipe.task}") succeeded here before with these steps — follow the same path where the page still allows it, taking fresh snapshots for refs:`,
        ...recipe.steps.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n'),
    );
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/** Merge new learning for a domain. Notes are deduped; a recipe replaces the closest older one. */
export async function rememberSite(
  domain: string | null,
  notes: string[],
  recipe: { task: string; steps: string[] } | null,
): Promise<void> {
  if (!domain) return;
  const all = await loadAll();
  const mem: SiteMemory = all[domain] ?? { notes: [], recipes: [], updated: 0 };

  // Deduped against the built-in notes too, so a run never "learns" its way to
  // a second, worse copy of something Tidra already knew.
  const known = [...(BUILTIN_NOTES[domain] ?? []), ...mem.notes];
  for (const raw of notes) {
    const n = String(raw ?? '').trim().slice(0, 200);
    if (!n) continue;
    const nw = words(n);
    if (known.some((old) => containment(nw, words(old)) > 0.7)) continue;
    mem.notes.push(n);
    known.push(n);
  }
  mem.notes = mem.notes.slice(-MAX_NOTES);

  if (recipe && recipe.steps.length >= 2) {
    const existing = matchRecipe(mem, recipe.task);
    if (existing) mem.recipes = mem.recipes.filter((r) => r !== existing);
    mem.recipes.push({
      task: recipe.task.slice(0, 200),
      steps: recipe.steps.slice(0, 16).map((s) => String(s ?? '').slice(0, 160)),
      updated: Date.now(),
    });
    mem.recipes = mem.recipes.slice(-MAX_RECIPES);
  }

  mem.updated = Date.now();
  all[domain] = mem;

  // LRU over domains, so an old site's memory makes room for a live one.
  const domains = Object.keys(all);
  if (domains.length > MAX_DOMAINS) {
    domains.sort((a, b) => all[a].updated - all[b].updated);
    for (const d of domains.slice(0, domains.length - MAX_DOMAINS)) delete all[d];
  }

  await browser.storage.local.set({ [KEY]: all });
}
