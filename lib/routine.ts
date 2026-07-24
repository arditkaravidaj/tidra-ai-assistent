// Routine helpers shared by the background, the new tab and settings —
// pretty site names, per-site default tasks, favicons. One copy, three users.

export const KNOWN_NAMES: Record<string, string> = {
  'mail.google.com': 'Gmail',
  'calendar.google.com': 'Calendar',
  'drive.google.com': 'Drive',
  'www.linkedin.com': 'LinkedIn',
  'linkedin.com': 'LinkedIn',
  'www.youtube.com': 'YouTube',
  'github.com': 'GitHub',
  'x.com': 'X',
  'twitter.com': 'X',
  'web.whatsapp.com': 'WhatsApp',
  'www.facebook.com': 'Facebook',
  'www.notion.so': 'Notion',
  'app.slack.com': 'Slack',
};

/** mail.google.com → Gmail, vercel.com → Vercel. */
export function prettyDomain(d: string): string {
  if (KNOWN_NAMES[d]) return KNOWN_NAMES[d];
  const parts = d.replace(/^www\./, '').split('.');
  const name = parts.length >= 2 ? parts[parts.length - 2] : d;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A sensible starting description of what Tidra should do on a given site. */
export const ROUTINE_TASK_DEFAULTS: Record<string, string> = {
  'mail.google.com': 'Check for new important emails and draft replies I can review before sending.',
  'linkedin.com': 'Check new messages and notifications, and summarize anything that needs a response.',
  'github.com': 'Check my notifications and open pull requests, and summarize what needs my attention.',
  'calendar.google.com': "Summarize today's meetings and what I should prepare.",
  'x.com': 'Summarize the top posts from the people I follow.',
  'twitter.com': 'Summarize the top posts from the people I follow.',
  'notion.so': 'Summarize what changed in my workspace since I last checked.',
  'www.youtube.com': 'List the new videos from channels I follow.',
};

/**
 * The task Tidra falls back to when the user hasn't written one. With a label
 * it reads as a suggestion in the UI; without one it's what the background
 * agent runs on the already-opened tab.
 */
export function defaultTaskFor(domain: string, label?: string): string {
  return (
    ROUTINE_TASK_DEFAULTS[domain] ??
    (label
      ? `Look at ${label} and tell me what's new or needs my attention.`
      : "Look at this page and tell me what's new or needs my attention.")
  );
}

// Favicon from the browser's own cache (needs the "favicon" permission) — works
// offline and isn't blocked by the extension page's CSP like a remote service is.
export function faviconUrl(pageUrl: string): string {
  const base = (browser.runtime.getURL as unknown as (p: string) => string)('/_favicon/');
  const u = new URL(base);
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '48');
  return u.toString();
}
