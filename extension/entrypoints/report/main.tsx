import { useEffect, useState, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { Wordmark } from '../../components/Wordmark';
import {
  deleteChat,
  deleteReport,
  loadChats,
  loadReports,
  type ArchivedChat,
  type Report,
} from '../../lib/library';
import { buildPdf, safeFilename } from '../../lib/pdf';
import './report.css';

// ── Markdown → JSX ─────────────────────────────────────────────────────────
// The same dialect create_pdf understands: headings, lists, tables, quotes,
// code fences, and **bold** / *italic* / `code` / [links](…) inline.

function inline(text: string): ReactNode {
  const re =
    /(\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|`([^`]+?)`|\[([^\]]+?)\]\((https?:\/\/[^\s)]+?)\))/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null || m[3] != null) out.push(<strong key={k++}>{m[2] ?? m[3]}</strong>);
    else if (m[4] != null || m[5] != null) out.push(<em key={k++}>{m[4] ?? m[5]}</em>);
    else if (m[6] != null) out.push(<code key={k++}>{m[6]}</code>);
    else if (m[7] != null)
      out.push(
        <a key={k++} href={m[8]} target="_blank" rel="noreferrer">
          {m[7]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function tableRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

function Markdown({ md }: { md: string }) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let k = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) {
      i++;
      continue;
    }
    // ``` code fence
    if (t.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre key={k++}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    // Headings
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2]);
      blocks.push(
        level === 1 ? (
          <h1 key={k++}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={k++}>{content}</h2>
        ) : level === 3 ? (
          <h3 key={k++}>{content}</h3>
        ) : (
          <h4 key={k++}>{content}</h4>
        ),
      );
      i++;
      continue;
    }
    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      blocks.push(<hr key={k++} />);
      i++;
      continue;
    }
    // Table: a | row, optionally followed by |---| separator rows
    if (t.startsWith('|') && t.endsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = tableRow(lines[i]);
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        blocks.push(
          <table key={k++}>
            <thead>
              <tr>
                {rows[0].map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
      }
      continue;
    }
    // Blockquote
    if (t.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(<blockquote key={k++}>{inline(buf.join(' '))}</blockquote>);
      continue;
    }
    // Lists
    if (/^([-*+]|\d+[.)])\s+/.test(t)) {
      const ordered = /^\d/.test(t);
      const items: ReactNode[] = [];
      while (i < lines.length && /^([-*+]|\d+[.)])\s+/.test(lines[i].trim())) {
        items.push(<li key={items.length}>{inline(lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, ''))}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    // Paragraph — swallow consecutive plain lines
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|[-*+]\s|\d+[.)]\s|\||>|```|-{3,}$)/.test(lines[i].trim())
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(<p key={k++}>{inline(buf.join(' '))}</p>);
  }
  return <div className="doc-body">{blocks}</div>;
}

// ── Shared bits ────────────────────────────────────────────────────────────

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function downloadPdf(r: Report) {
  const bytes = buildPdf({ title: r.title, subtitle: r.subtitle ?? '', content: r.markdown });
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename(r.title, 'report', 'pdf');
  a.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [reports, setReports] = useState<Report[]>([]);
  const [chats, setChats] = useState<ArchivedChat[]>([]);
  const [view, setView] = useState<'reports' | 'chats'>('reports');
  const [openReport, setOpenReport] = useState<Report | null>(null);
  const [openChat, setOpenChat] = useState<ArchivedChat | null>(null);
  const [restored, setRestored] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([loadReports(), loadChats()]).then(([r, c]) => {
      setReports(r);
      setChats(c);
      setLoaded(true);
      const id = new URLSearchParams(location.search).get('id');
      if (id) {
        const hit = r.find((x) => x.id === id);
        if (hit) setOpenReport(hit);
      }
    });
    // A report created after this tab opened (e.g. by a running routine)
    // should appear without a manual refresh.
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (changes.tidraReports && Array.isArray(changes.tidraReports.newValue))
        setReports(changes.tidraReports.newValue as Report[]);
      if (changes.tidraChatArchive && Array.isArray(changes.tidraChatArchive.newValue))
        setChats(changes.tidraChatArchive.newValue as ArchivedChat[]);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  function backToList() {
    setOpenReport(null);
    setOpenChat(null);
    setRestored(false);
    history.replaceState(null, '', location.pathname);
  }

  async function removeReport(id: string) {
    setReports(await deleteReport(id));
    if (openReport?.id === id) backToList();
  }
  async function removeChat(id: string) {
    setChats(await deleteChat(id));
    if (openChat?.id === id) backToList();
  }

  // Put an archived conversation back as the live one, so the island picks it
  // up on any page. Loading stays false — nothing is running.
  async function continueChat(c: ArchivedChat) {
    const messages = c.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    await browser.storage.local.set({ tidraChat: { messages, loading: false }, tidraPending: null });
    setRestored(true);
  }

  const header = (
    <header className="lib-head">
      <a className="lib-brand" href={location.pathname} onClick={(e) => { e.preventDefault(); backToList(); }}>
        <span className="lib-orb" aria-hidden="true">
          <svg viewBox="0 0 128 128">
            <rect width="128" height="128" rx="28" fill="#0a0a0a" />
            <path d="M34 88 L64 42 L94 88" fill="none" stroke="#fff" strokeWidth="20" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <Wordmark className="lib-mark" />
        <span className="lib-title">Library</span>
      </a>
    </header>
  );

  const list = view === 'reports' ? reports : chats;
  let inner: ReactNode;
  if (openReport) {
    inner = (
      <>
        <div className="doc-bar">
          <button className="lib-btn" onClick={backToList}>← All reports</button>
          <span className="doc-bar-space" />
          <button className="lib-btn" onClick={() => downloadPdf(openReport)}>Download PDF</button>
          <button className="lib-btn lib-btn-x" onClick={() => removeReport(openReport.id)}>Delete</button>
        </div>
        <article className="doc">
          <div className="doc-meta">
            {openReport.source === 'routine' ? 'Routine brief' : 'Report'} · {fmtDate(openReport.createdAt)}
          </div>
          <h1 className="doc-title">{openReport.title}</h1>
          {openReport.subtitle && <p className="doc-subtitle">{openReport.subtitle}</p>}
          <Markdown md={openReport.markdown} />
        </article>
      </>
    );
  } else if (openChat) {
    inner = (
      <>
        <div className="doc-bar">
          <button className="lib-btn" onClick={backToList}>← All chats</button>
          <span className="doc-bar-space" />
          {restored ? (
            <span className="lib-restored">Loaded — open Tidra on any page (⌘⇧Space) to continue.</span>
          ) : (
            <button className="lib-btn" onClick={() => continueChat(openChat)}>Continue in Tidra</button>
          )}
          <button className="lib-btn lib-btn-x" onClick={() => removeChat(openChat.id)}>Delete</button>
        </div>
        <article className="doc doc-chat">
          <div className="doc-meta">Chat · {fmtDate(openChat.ts)}</div>
          {openChat.messages.map((m, i) => (
            <div key={i} className={'chat-msg' + (m.role === 'user' ? ' chat-msg-user' : '')}>
              {m.text}
            </div>
          ))}
        </article>
      </>
    );
  } else {
    inner = (
      <>
      <div className="lib-tabs">
        <button className={'lib-tab' + (view === 'reports' ? ' lib-tab-on' : '')} onClick={() => setView('reports')}>
          Reports {reports.length ? `(${reports.length})` : ''}
        </button>
        <button className={'lib-tab' + (view === 'chats' ? ' lib-tab-on' : '')} onClick={() => setView('chats')}>
          Chats {chats.length ? `(${chats.length})` : ''}
        </button>
      </div>

      {loaded && list.length === 0 && (
        <p className="lib-empty">
          {view === 'reports'
            ? 'No reports yet. Ask Tidra for one — “make me a report comparing…” — and it will land here.'
            : 'No saved chats yet. When you start a new chat, the old one is kept here.'}
        </p>
      )}

      <div className="lib-list">
        {view === 'reports'
          ? reports.map((r) => (
              <div key={r.id} className="lib-row" onClick={() => setOpenReport(r)} role="button" tabIndex={0}>
                <span className="lib-row-main">
                  <b>{r.title || 'Untitled report'}</b>
                  <i>{r.subtitle || r.markdown.replace(/[#*`>|-]/g, '').slice(0, 90)}</i>
                </span>
                {r.source === 'routine' && <span className="lib-badge">routine</span>}
                <span className="lib-date">{fmtDate(r.createdAt)}</span>
                <button
                  className="lib-btn lib-btn-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeReport(r.id);
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          : chats.map((c) => (
              <div key={c.id} className="lib-row" onClick={() => setOpenChat(c)} role="button" tabIndex={0}>
                <span className="lib-row-main">
                  <b>{c.title}</b>
                  <i>{c.messages.length} message{c.messages.length === 1 ? '' : 's'}</i>
                </span>
                <span className="lib-badge">{c.source === 'newtab' ? 'new tab' : 'island'}</span>
                <span className="lib-date">{fmtDate(c.ts)}</span>
                <button
                  className="lib-btn lib-btn-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeChat(c.id);
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
      </div>
      </>
    );
  }

  // One fixed-size card over the same footage as the home page and settings —
  // whatever the view holds scrolls inside the card, the card never grows.
  return (
    <div className="lib-wrap">
      <video className="lib-video" src="/bg.mp4" autoPlay muted loop playsInline aria-hidden="true" />
      <button
        type="button"
        className="lib-back"
        title="Back to home"
        aria-label="Back to Tidra home"
        onClick={() => {
          location.href = browser.runtime.getURL('/newtab.html');
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M19 12H5m0 0 6-6m-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="lib-card">
        {header}
        <div className="lib-body">{inner}</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
