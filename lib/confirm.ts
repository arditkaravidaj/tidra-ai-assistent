// Catching a confirmation the model printed instead of calling.
//
// Lives on its own because it is the last line of defence before an
// irreversible action, and a thing that important should be testable without
// standing up a browser, a service worker and a model.

/**
 * Recover a confirmation the model PRINTED instead of calling.
 *
 * GPT-OSS is measurably weaker at tool discipline than Claude was, and it fails
 * in two shapes: an XML-ish `<confirm_action summary="…"/>` tag, and a JSON
 * dump of the call — `{"tool":"confirm_action","arguments":{…}}`. Both put the
 * drafted content in front of the user as raw syntax AND skip the Confirm bar,
 * so the gate before an irreversible send just isn't there. Catching them here
 * means the checkpoint holds even when the model gets the mechanics wrong.
 *
 * Returns the summary to show and the button label, or null if this really was
 * just an ordinary reply.
 */
export function parsePrintedConfirm(said: string): { summary: string; label: string } | null {
  if (!/confirm_action/i.test(said)) return null;

  // Shape 1: <confirm_action summary="…" confirm_label="…" />
  const tag = /<\s*confirm[_\s]?action\b([^>]*)>/i.exec(said);
  if (tag) {
    const rest = said.replace(tag[0], '').trim();
    return {
      summary:
        /summary\s*=\s*"([^"]+)"/i.exec(tag[1])?.[1] || rest || 'Ready. Do you want me to proceed?',
      label: /label\s*=\s*"([^"]+)"/i.exec(tag[1])?.[1] || 'Confirm',
    };
  }

  // Shape 2: a JSON object naming the tool. Parsed properly where possible, so
  // that escapes like \n in the drafted text come out as real line breaks
  // rather than being shown to the user literally.
  const start = said.indexOf('{');
  if (start >= 0) {
    // Deliberately tolerant of a missing closing brace: max_tokens can cut a
    // confirmation off mid-draft, and a half-printed one still means "do not
    // send yet". Reading to the end of the text is the safe direction.
    const end = said.lastIndexOf('}');
    const blob = said.slice(start, end > start ? end + 1 : undefined);
    try {
      const parsed = JSON.parse(blob);
      const name = parsed?.tool ?? parsed?.name ?? parsed?.function?.name;
      const args = parsed?.arguments ?? parsed?.input ?? parsed?.parameters ?? parsed;
      if (/confirm_action/i.test(String(name)) && args) {
        return {
          summary: String(args.summary ?? '').trim() || 'Ready. Do you want me to proceed?',
          label: String(args.confirm_label ?? args.label ?? 'Confirm').trim(),
        };
      }
    } catch {
      // Truncated or malformed — the regexes below read what did arrive.
    }
    const summary = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(blob)?.[1];
    if (summary) {
      const unescape = (s: string) =>
        s
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\u([\da-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\\\/g, '\\');
      return {
        summary: unescape(summary),
        label: /"confirm_label"\s*:\s*"([^"]+)"/i.exec(blob)?.[1] || 'Confirm',
      };
    }
  }

  // Nothing parsed, but the model was plainly naming the tool as a call. Stop
  // anyway. A Confirm bar the user can cancel is a trivial cost; letting a send
  // through because the JSON was unreadable is not.
  if (/["']?(tool|name|function|tool_name)["']?\s*[:=]\s*["']?\s*confirm_action/i.test(said)) {
    return { summary: 'Ready. Do you want me to proceed?', label: 'Confirm' };
  }
  return null;
}
