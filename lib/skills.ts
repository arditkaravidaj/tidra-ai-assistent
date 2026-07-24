// Skills — named, reusable prompts the user invokes with a slash command.
//
// A skill is "/fact-check" → a saved instruction set. Typing it in the island
// or the new tab skips the router (each skill declares whether it needs the
// browser agent or plain chat) and expands into the saved prompt before the
// model ever sees it. Users edit, create, delete and share them in settings;
// everything lives in browser.storage.local like the rest of Tidra.
//
// Two placeholders may appear in a skill's prompt:
//   {input}   — whatever the user typed after the command ("/translate hallo")
//   {history} — a domain-level digest of the visit log Tidra already keeps for
//               routines (domains + times only — no URLs, no page content)

export interface Skill {
  id: string;
  /** The slash trigger, e.g. "fact-check" → typed as /fact-check. */
  name: string;
  /** One line shown in the pickers. */
  description: string;
  /** What the model is told. May use {input} and {history}. */
  prompt: string;
  /**
   * How to run it: 'chat' answers from the page text already in context,
   * 'act' hands it to the browser agent, 'auto' lets the router decide.
   */
  mode: 'auto' | 'chat' | 'act';
}

const SKILLS_KEY = 'tidraSkills';

/** The starter pack, seeded once — after that the user owns the list. */
export const DEFAULT_SKILLS: Skill[] = [
  {
    id: 'summarize',
    name: 'summarize',
    description: 'Summarize the current page',
    prompt:
      'Summarize the current page. Lead with the one-sentence gist, then the key points as short bullets. Keep only what matters — no filler.',
    mode: 'chat',
  },
  {
    id: 'fact-check',
    name: 'fact-check',
    description: 'Fact-check the claims on this page',
    prompt:
      "Fact-check the current page. Pick out its main factual claims and for each one say: the claim, whether it holds up against what you know, and a one-line reason. Flag anything misleading, outdated or unverifiable as such — do not guess. End with a one-line overall verdict.\n\n{input}",
    mode: 'chat',
  },
  {
    id: 'translate',
    name: 'translate',
    description: 'Translate the page or the given text',
    prompt:
      'Translate the following (or, if nothing is given, the main content of the current page). Target language: whatever is named in the request; otherwise English. Give only the translation, kept natural rather than word-for-word.\n\n{input}',
    mode: 'chat',
  },
  {
    id: 'outline',
    name: 'outline',
    description: 'Quick essay / post outline for any topic',
    prompt:
      'Create a tight outline on this topic (or on the current page\'s subject if no topic is given): a working title, a one-line thesis, and 4–6 sections each with 2–3 bullet points of what to cover.\n\nTopic: {input}',
    mode: 'chat',
  },
  {
    id: 'draft-reply',
    name: 'draft-reply',
    description: 'Open the reply box and draft a response to what’s on screen',
    prompt:
      'Reply to the message, email or post currently on screen: open its reply composer, read the thread properly, and write a genuinely fitting draft in my voice. Extra instructions, if any: {input}',
    mode: 'act',
  },
  {
    id: 'save-pdf',
    name: 'save-pdf',
    description: 'Save the current page as a clean PDF',
    prompt:
      'Read the current page in full (get_page) and save it as a well-laid-out PDF — real headings, the actual content, not a summary. {input}',
    mode: 'act',
  },
  {
    id: 'waiting-on',
    name: 'waiting-on',
    description: 'Who is still waiting on a reply from you',
    prompt:
      "Work out who is still waiting on me. Open https://mail.google.com and scan the recent inbox for emails that clearly expect a reply I haven't sent, then open https://www.linkedin.com/messaging/ and check for unanswered messages. Compile ONE prioritized list — who, on which site, what they need, and how urgent it feels. If the list is more than a few items, present it with create_report; otherwise answer in chat. Do not draft or send anything — just tell me where the ball is in my court. {input}",
    mode: 'act',
  },
  {
    id: 'weekly',
    name: 'weekly',
    description: 'A light recap of your browsing week',
    prompt:
      'Below is a digest of which sites I visited recently (domains and times only — that is all Tidra stores). Give me a short, warm recap of my week: where my time seems to have gone, any pattern worth noticing, and one friendly suggestion. Keep it light — this is a glimpse, not a report card.\n\n{history}\n\n{input}',
    mode: 'chat',
  },
];

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** "Fact Check!" → "fact-check". Returns '' when nothing usable is left. */
export function normalizeName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return NAME_RE.test(name) ? name : '';
}

function sanitize(raw: unknown): Skill | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = normalizeName(String(r.name ?? ''));
  const prompt = String(r.prompt ?? '').trim();
  if (!name || !prompt) return null;
  const mode = r.mode === 'chat' || r.mode === 'act' ? r.mode : 'auto';
  return {
    id: String(r.id ?? '') || name,
    name,
    description: String(r.description ?? '').trim().slice(0, 120),
    prompt: prompt.slice(0, 4000),
    mode,
  };
}

/** Load the skill list, seeding the starter pack on first use. */
export async function loadSkills(): Promise<Skill[]> {
  const { [SKILLS_KEY]: stored } = await browser.storage.local.get(SKILLS_KEY);
  if (Array.isArray(stored)) {
    return stored.map(sanitize).filter((s): s is Skill => s !== null);
  }
  await browser.storage.local.set({ [SKILLS_KEY]: DEFAULT_SKILLS });
  return DEFAULT_SKILLS;
}

export async function saveSkills(skills: Skill[]): Promise<void> {
  await browser.storage.local.set({ [SKILLS_KEY]: skills });
}

/**
 * Does this message invoke a skill? "/fact-check the stats" → the skill plus
 * whatever followed it. Only a leading slash counts, so URLs and fractions in
 * normal sentences never trigger anything.
 */
export function matchSkill(
  text: string,
  skills: Skill[],
): { skill: Skill; rest: string } | null {
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const skill = skills.find((s) => s.name === name);
  return skill ? { skill, rest: (m[2] ?? '').trim() } : null;
}

/** Skills whose name starts with what's typed so far — for the pickers. */
export function filterSkills(partial: string, skills: Skill[]): Skill[] {
  const q = partial.toLowerCase();
  return skills.filter((s) => s.name.startsWith(q));
}

// ── {history}: the domain digest ──────────────────────────────────────────
// Built from the visit log the routine feature already keeps (domain + time
// only). Nothing new is collected for this — and if routine learning is off
// or cleared, the digest honestly says there is nothing to tell.

interface Visit {
  d: string;
  t: number;
}

export async function visitDigest(days = 7): Promise<string> {
  const { tidraVisits } = await browser.storage.local.get('tidraVisits');
  const visits = (Array.isArray(tidraVisits) ? tidraVisits : []) as Visit[];
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = visits.filter((v) => v.t >= since && v.d);
  if (!recent.length) {
    return '(No browsing history available — routine learning is off or was recently cleared.)';
  }
  // One line per day: "Mon Jul 20: github.com ×6, mail.google.com ×3, …"
  const byDay = new Map<string, Record<string, number>>();
  for (const v of recent) {
    const day = new Date(v.t).toDateString().slice(0, 10); // "Mon Jul 20"
    const counts = byDay.get(day) ?? {};
    counts[v.d] = (counts[v.d] || 0) + 1;
    byDay.set(day, counts);
  }
  const lines: string[] = [];
  for (const [day, counts] of byDay) {
    const tops = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([d, n]) => (n > 1 ? `${d} ×${n}` : d));
    lines.push(`${day}: ${tops.join(', ')}`);
  }
  return `Site visits over the last ${days} days (domains only):\n${lines.join('\n')}`;
}

/** Turn a matched skill into the prompt the model actually receives. */
export async function expandSkill(skill: Skill, rest: string): Promise<string> {
  let p = skill.prompt;
  if (p.includes('{input}')) p = p.split('{input}').join(rest);
  else if (rest) p += '\n\n' + rest;
  if (p.includes('{history}')) p = p.split('{history}').join(await visitDigest());
  return p.trim();
}

// ── Sharing ───────────────────────────────────────────────────────────────

export function exportSkills(skills: Skill[]): string {
  return JSON.stringify({ tidra: 'skills', version: 1, skills }, null, 2);
}

/** Parse an exported file. Throws with a readable message on junk input. */
export function parseSkillsImport(json: string): Skill[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const raw = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as any).skills)
      ? (data as any).skills
      : null;
  if (!raw) throw new Error('That file does not look like a Tidra skills export.');
  const skills = (raw as unknown[]).map(sanitize).filter((s): s is Skill => s !== null);
  if (!skills.length) throw new Error('No usable skills found in that file.');
  return skills;
}

/** Merge imported skills into the current list — same name replaces. */
export function mergeSkills(current: Skill[], imported: Skill[]): Skill[] {
  const byName = new Map(current.map((s) => [s.name, s]));
  for (const s of imported) byName.set(s.name, s);
  return [...byName.values()];
}
