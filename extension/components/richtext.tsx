import type { ReactNode } from 'react';

// Minimal inline markdown → JSX: **bold**, *italic*/_italic_, `code`.
// Newlines are preserved by CSS (white-space: pre-wrap); emoji pass through.
export function renderRich(text: string): ReactNode {
  const re = /(\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|`([^`]+?)`)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null || m[3] != null) out.push(<strong key={k++}>{m[2] ?? m[3]}</strong>);
    else if (m[4] != null || m[5] != null) out.push(<em key={k++}>{m[4] ?? m[5]}</em>);
    else if (m[6] != null) out.push(<code key={k++}>{m[6]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ── Markdown tables → real <table> ───────────────────────────────────────── */

const TABLE_LINE = /^\s*\|.*\|\s*$/;
/** The |---|:---:| row between header and body. */
const SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/;

function parseRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Chat text → JSX with real tables. Runs of `| … |` lines with a `|---|`
 * separator become a <table class="tidra-table">; everything else goes
 * through renderRich unchanged. Models love answering "which messages are
 * unreplied" as a markdown table, and raw pipes in a chat bubble read as
 * garbage — this is what turns them into an actual table.
 */
export function renderBlocks(text: string): ReactNode {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let buf: string[] = [];
  let k = 0;

  const flushText = () => {
    // Trim the blank lines that hug a table — its own margin is the spacing.
    const chunk = buf.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    buf = [];
    if (chunk) out.push(<span key={k++}>{renderRich(chunk)}</span>);
  };

  for (let i = 0; i < lines.length; i++) {
    if (TABLE_LINE.test(lines[i])) {
      let j = i;
      while (j < lines.length && TABLE_LINE.test(lines[j])) j++;
      const run = lines.slice(i, j);
      // A real table needs a header row and the dashed separator under it.
      if (run.length >= 2 && SEPARATOR.test(run[1])) {
        flushText();
        const header = parseRow(run[0]);
        const rows = run
          .slice(2)
          .filter((l) => !SEPARATOR.test(l))
          .map(parseRow);
        out.push(
          <div className="tidra-table-wrap" key={k++}>
            <table className="tidra-table">
              <thead>
                <tr>
                  {header.map((h, x) => (
                    <th key={x}>{renderRich(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, y) => (
                  <tr key={y}>
                    {r.map((c, x) => (
                      <td key={x}>{renderRich(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        i = j - 1;
        continue;
      }
    }
    buf.push(lines[i]);
  }
  flushText();
  return out;
}
