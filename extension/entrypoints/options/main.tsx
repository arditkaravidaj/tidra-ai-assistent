import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Wordmark } from '../../components/Wordmark';
import { GROQ_MODELS } from '../../lib/llm';
import {
  DEFAULT_SKILLS,
  exportSkills,
  loadSkills,
  mergeSkills,
  normalizeName,
  parseSkillsImport,
  saveSkills,
  type Skill,
} from '../../lib/skills';
import { defaultTaskFor, faviconUrl, prettyDomain } from '../../lib/routine';
import '../content/font.css';
import './options.css';

function Orb() {
  return (
    <span className="tidra-orb" aria-hidden="true">
      <svg viewBox="0 0 128 128">
        <rect width="128" height="128" rx="28" fill="#0a0a0a" />
        <path
          d="M34 88 L64 42 L94 88"
          fill="none"
          stroke="#ffffff"
          strokeWidth="20"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

const TIERS = [
  { id: 'economy', label: 'Economy', desc: `${GROQ_MODELS.small} everywhere — $0.075 / 1M in` },
  { id: 'balanced', label: 'Balanced', desc: `${GROQ_MODELS.big} for actions, 20B for chat — recommended` },
  { id: 'quality', label: 'Max quality', desc: `${GROQ_MODELS.big} everywhere — still $0.15 / 1M in` },
];

interface Profile {
  name: string;
  email: string;
  role: string;
  company: string;
  location: string;
  languages: string;
  about: string;
}
const EMPTY_PROFILE: Profile = {
  name: '',
  email: '',
  role: '',
  company: '',
  location: '',
  languages: '',
  about: '',
};

const FIELDS: { key: keyof Profile; label: string; placeholder: string }[] = [
  { key: 'name', label: 'Name', placeholder: 'e.g. Ardit' },
  { key: 'email', label: 'Email', placeholder: 'e.g. you@company.com' },
  { key: 'role', label: 'Role', placeholder: 'e.g. Founder' },
  { key: 'company', label: 'Company', placeholder: 'e.g. Huncher' },
  { key: 'location', label: 'Location', placeholder: 'e.g. Berlin (CET)' },
  { key: 'languages', label: 'Languages', placeholder: 'e.g. English, German' },
];

interface RoutineSite {
  domain: string;
  label: string;
  url: string;
}

// Settings grew past one screen, so it's split into pages — picked in the header.
type Tab = 'general' | 'profile' | 'skills' | 'routine';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'profile', label: 'Profile' },
  { id: 'skills', label: 'Skills' },
  { id: 'routine', label: 'Routine' },
];

const EMPTY_DRAFT = { name: '', description: '', prompt: '', mode: 'auto' as Skill['mode'] };

const MODES: { id: Skill['mode']; label: string; desc: string }[] = [
  { id: 'auto', label: 'Auto', desc: 'Tidra decides whether it needs the browser' },
  { id: 'chat', label: 'Chat', desc: 'Answer from the page text and what Tidra knows' },
  { id: 'act', label: 'Act', desc: 'Use the browser agent — click, type, navigate' },
];

function Options() {
  // Deep-linkable pages: options.html?tab=skills opens straight on Skills.
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(location.search).get('tab');
    return TABS.some((x) => x.id === t) ? (t as Tab) : 'general';
  });
  const [apiKey, setApiKey] = useState('');
  const [tier, setTier] = useState('balanced');
  const [routineOn, setRoutineOn] = useState(true);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [cleared, setCleared] = useState(false);
  const [profileCleared, setProfileCleared] = useState(false);
  const [saved, setSaved] = useState(false);
  // Clearing is irreversible, so both clears ask first.
  const [confirming, setConfirming] = useState<'profile' | 'routine' | null>(null);
  const [micState, setMicState] = useState<'unknown' | 'granted' | 'denied' | 'asking'>('unknown');
  const [micHint, setMicHint] = useState<string | null>(null);
  // Skills — the slash commands. Saved to storage as you go, not via Save.
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // a skill id, or 'new'
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [skillNote, setSkillNote] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  // Routine — the sites Tidra visits on "Start routine" and what it does on
  // each. Learned sites come from the background; manual ones from storage.
  const [rtLearned, setRtLearned] = useState<RoutineSite[]>([]);
  const [rtManual, setRtManual] = useState<RoutineSite[]>([]);
  const [rtTasks, setRtTasks] = useState<Record<string, string>>({});
  const [rtEditing, setRtEditing] = useState<string | null>(null); // a domain
  const [rtDraft, setRtDraft] = useState('');
  const [rtAdding, setRtAdding] = useState(false);
  const [rtAddUrl, setRtAddUrl] = useState('');

  useEffect(() => {
    loadSkills().then(setSkills).catch(() => {});
    browser.runtime
      .sendMessage({ type: 'tidra-get-routine' })
      .then((res: { sites?: { domain: string; url: string }[] } | undefined) => {
        if (res?.sites)
          setRtLearned(
            res.sites.map((s) => ({ domain: s.domain, label: prettyDomain(s.domain), url: s.url })),
          );
      })
      .catch(() => {});
    browser.storage.local
      .get(['tidraRoutineManual', 'tidraRoutineTasks'])
      .then(({ tidraRoutineManual, tidraRoutineTasks }) => {
        if (Array.isArray(tidraRoutineManual)) setRtManual(tidraRoutineManual as RoutineSite[]);
        if (tidraRoutineTasks && typeof tidraRoutineTasks === 'object')
          setRtTasks(tidraRoutineTasks as Record<string, string>);
      });
  }, []);

  // Learned + manually-added, de-duplicated — same list the new tab shows.
  const rtSites: RoutineSite[] = (() => {
    const seen = new Set<string>();
    const out: RoutineSite[] = [];
    for (const s of [...rtLearned, ...rtManual]) {
      if (seen.has(s.domain)) continue;
      seen.add(s.domain);
      out.push(s);
    }
    return out;
  })();

  function rtTaskOf(s: RoutineSite): string {
    return (rtTasks[s.domain] || defaultTaskFor(s.domain, s.label)).trim();
  }

  function rtSaveTask(domain: string) {
    const next = { ...rtTasks, [domain]: rtDraft.trim() };
    setRtTasks(next);
    browser.storage.local.set({ tidraRoutineTasks: next });
    setRtEditing(null);
  }

  // Remove a site from the routine — remembered so a learned one doesn't come back.
  function rtRemove(domain: string) {
    setRtLearned((prev) => prev.filter((s) => s.domain !== domain));
    setRtManual((prev) => {
      const next = prev.filter((s) => s.domain !== domain);
      browser.storage.local.set({ tidraRoutineManual: next });
      return next;
    });
    browser.storage.local.get('tidraRoutineHidden').then(({ tidraRoutineHidden }) => {
      const hidden = new Set((tidraRoutineHidden as string[]) || []);
      hidden.add(domain);
      browser.storage.local.set({ tidraRoutineHidden: [...hidden] });
    });
    if (rtEditing === domain) setRtEditing(null);
  }

  function rtAdd() {
    const raw = rtAddUrl.trim();
    if (!raw) return;
    let domain: string;
    try {
      domain = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).hostname.replace(/^www\./, '');
    } catch {
      return;
    }
    if (!domain.includes('.')) return;
    const site: RoutineSite = { domain, label: prettyDomain(domain), url: 'https://' + domain };
    setRtManual((prev) => {
      const next = [...prev.filter((m) => m.domain !== domain), site];
      browser.storage.local.set({ tidraRoutineManual: next });
      return next;
    });
    if (rtDraft.trim()) {
      const next = { ...rtTasks, [domain]: rtDraft.trim() };
      setRtTasks(next);
      browser.storage.local.set({ tidraRoutineTasks: next });
    }
    // Un-hide it if it had been removed before.
    browser.storage.local.get('tidraRoutineHidden').then(({ tidraRoutineHidden }) => {
      const hidden = new Set((tidraRoutineHidden as string[]) || []);
      if (hidden.delete(domain)) browser.storage.local.set({ tidraRoutineHidden: [...hidden] });
    });
    setRtAdding(false);
    setRtAddUrl('');
    setRtDraft('');
  }

  function note(text: string) {
    setSkillNote(text);
    setTimeout(() => setSkillNote(null), 4000);
  }

  async function persistSkills(next: Skill[]) {
    setSkills(next);
    await saveSkills(next);
  }

  function startEdit(s: Skill) {
    setEditing(s.id);
    setDraft({ name: s.name, description: s.description, prompt: s.prompt, mode: s.mode });
  }

  function startNew() {
    setEditing('new');
    setDraft(EMPTY_DRAFT);
  }

  async function saveDraft() {
    const name = normalizeName(draft.name);
    if (!name) return note('Give the skill a name — letters, numbers and dashes.');
    if (!draft.prompt.trim()) return note('The skill needs a prompt — that is what it does.');
    if (skills.some((s) => s.name === name && s.id !== editing)) {
      return note(`/${name} already exists — pick another name or edit that one.`);
    }
    const skill: Skill = {
      id: name,
      name,
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
      mode: draft.mode,
    };
    const next =
      editing === 'new'
        ? [...skills, skill]
        : skills.map((s) => (s.id === editing ? skill : s));
    await persistSkills(next);
    setEditing(null);
  }

  async function removeSkill(id: string) {
    await persistSkills(skills.filter((s) => s.id !== id));
    if (editing === id) setEditing(null);
  }

  function doExport() {
    const blob = new Blob([exportSkills(skills)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tidra-skills.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doImport(file: File | undefined) {
    if (!file) return;
    try {
      const imported = parseSkillsImport(await file.text());
      await persistSkills(mergeSkills(skills, imported));
      note(`Imported ${imported.length} skill${imported.length === 1 ? '' : 's'}.`);
    } catch (err) {
      note(err instanceof Error ? err.message : 'Could not import that file.');
    }
  }

  async function restoreDefaults() {
    // Puts the starter pack back without touching skills the user made.
    await persistSkills(mergeSkills(skills, DEFAULT_SKILLS));
    note('Starter skills restored.');
  }

  // One editor, used both for "edit this skill" and "add a new one".
  function skillEditor(key: string) {
    return (
      <div className="skill-editor" key={key}>
        <div className="skill-editor-grid">
          <div>
            <label htmlFor="sk-name">Name</label>
            <input
              id="sk-name"
              value={draft.name}
              placeholder="e.g. fact-check"
              spellCheck={false}
              autoFocus
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="sk-desc">Description</label>
            <input
              id="sk-desc"
              value={draft.description}
              placeholder="One line shown in the menu"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
        </div>
        <label htmlFor="sk-prompt">Prompt</label>
        <textarea
          id="sk-prompt"
          className="skill-prompt"
          rows={5}
          value={draft.prompt}
          placeholder={'What should Tidra do? Use {input} for whatever follows the command.'}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
        />
        <div className="skill-modes">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={'skill-mode-pick' + (draft.mode === m.id ? ' skill-mode-on' : '')}
              title={m.desc}
              onClick={() => setDraft({ ...draft, mode: m.id })}
            >
              {m.label}
            </button>
          ))}
          <span className="skill-mode-hint">{MODES.find((m) => m.id === draft.mode)?.desc}</span>
        </div>
        <div className="skill-editor-foot">
          <button type="button" className="routine-clear" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button type="button" className="skill-save" onClick={saveDraft}>
            Save skill
          </button>
        </div>
      </div>
    );
  }

  // Chrome will only show a microphone prompt on a VISIBLE page at the
  // extension's own origin. The island can't do it — it's a content script on
  // someone else's site — and the offscreen document that actually records is
  // invisible. So this page is where the grant has to happen, once. Everything
  // else inherits it, because it's all the same origin.
  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => {
        const read = () => setMicState(p.state === 'prompt' ? 'unknown' : (p.state as 'granted' | 'denied'));
        read();
        p.onchange = read;
      })
      .catch(() => {});
  }, []);

  async function allowMic() {
    setMicState('asking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The grant is what was wanted, not the audio — let the mic go again
      // immediately so no recording light stays on.
      stream.getTracks().forEach((t) => t.stop());
      setMicState('granted');
    } catch {
      setMicState('denied');
    }
  }

  // A page can ask for the microphone but can't give it back — revoking is the
  // browser's job. So "Remove access" opens the browser's own site-settings
  // page for Tidra, where the toggle lives. (The permission listener above
  // notices the change and flips the row back on its own.)
  function openMicSettings() {
    browser.tabs
      .create({
        url: 'chrome://settings/content/siteDetails?site=' + encodeURIComponent(location.origin),
      })
      .catch(() =>
        setMicHint(
          "Your browser won't open that page from here — open its site settings for this page (the icon in the address bar) and set Microphone to Block.",
        ),
      );
  }

  useEffect(() => {
    browser.storage.local
      .get(['tidraGroqKey', 'tidraTier', 'tidraRoutineEnabled', 'tidraProfile'])
      .then(({ tidraGroqKey, tidraTier, tidraRoutineEnabled, tidraProfile }) => {
        if (typeof tidraGroqKey === 'string') setApiKey(tidraGroqKey);
        if (typeof tidraTier === 'string') setTier(tidraTier);
        setRoutineOn(tidraRoutineEnabled !== false); // default on
        if (tidraProfile && typeof tidraProfile === 'object') {
          const stored = tidraProfile as Record<string, unknown>;
          setProfile({
            ...EMPTY_PROFILE,
            ...Object.fromEntries(
              Object.keys(EMPTY_PROFILE)
                .filter((k) => typeof stored[k] === 'string')
                .map((k) => [k, stored[k]]),
            ),
          });
        }
      });
  }, []);

  async function save() {
    await browser.storage.local.set({
      tidraGroqKey: apiKey.trim(),
      tidraTier: tier,
      tidraRoutineEnabled: routineOn,
      // Built from EMPTY_PROFILE's keys, so leftovers from older versions of
      // the profile (the removed auto-learning fields) are dropped, not saved.
      tidraProfile: Object.fromEntries(
        Object.keys(EMPTY_PROFILE).map((k) => [k, (profile[k as keyof Profile] ?? '').trim()]),
      ) as unknown as Profile,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function clearRoutine() {
    setConfirming(null);
    await browser.storage.local.set({ tidraVisits: [], tidraRoutine: null });
    setCleared(true);
    setTimeout(() => setCleared(false), 2000);
  }

  async function clearProfile() {
    setConfirming(null);
    setProfile(EMPTY_PROFILE);
    await browser.storage.local.set({ tidraProfile: EMPTY_PROFILE });
    setProfileCleared(true);
    setTimeout(() => setProfileCleared(false), 2000);
  }

  return (
    <div className="wrap">
      {/* Same background footage as the home page. */}
      <video className="opt-video" src="/bg.mp4" autoPlay muted loop playsInline aria-hidden="true" />
      <button
        type="button"
        className="opt-back"
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
      <div className="card">
        <div className="brand">
          <Orb />
          <Wordmark className="brand-mark" />
          <nav className="opt-tabs" aria-label="Settings pages">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={'opt-tab' + (tab === t.id ? ' opt-tab-on' : '')}
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <p className="sub">An assistant you won't dread opening.</p>

        {/* Every page renders inside the same fixed-size card; anything longer
            scrolls in here rather than stretching the card. */}
        <div className="opt-body">

        {tab === 'general' && (
        <>
        <div className="grid">
          <section className="col">
            <label htmlFor="key">Groq API Key</label>
            <input
              id="key"
              type="password"
              value={apiKey}
              placeholder="gsk_…"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="hint">
              Stored only locally in your browser and used directly with the Groq API. Get one at{' '}
              <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
                console.groq.com/keys
              </a>
              .
            </p>

            <div className="mic-row">
              <span className="routine-toggle">
                <span>
                  <strong>Microphone</strong> —{' '}
                  {micState === 'granted'
                    ? "allowed. You can talk to Tidra on any site. Don't want it? Remove access any time."
                    : micState === 'denied'
                      ? 'blocked. Allow it for this page in the address bar, then reload.'
                      : 'speak instead of typing. Allow it once here and it works everywhere.'}
                </span>
              </span>
              {micState === 'granted' ? (
                <button type="button" className="routine-clear" onClick={openMicSettings}>
                  Remove access
                </button>
              ) : (
                <button
                  type="button"
                  className="routine-clear"
                  onClick={allowMic}
                  disabled={micState === 'asking'}
                >
                  {micState === 'asking' ? 'Asking…' : 'Allow microphone'}
                </button>
              )}
              {micHint && <p className="hint mic-hint">{micHint}</p>}
            </div>
          </section>

          <section className="col">
            <div className="section-head">
              <span>Model &amp; cost</span>
            </div>
            <div className="tiers">
              {TIERS.map((t) => (
                <button
                  key={t.id}
                  className={'tier' + (tier === t.id ? ' tier-active' : '')}
                  onClick={() => setTier(t.id)}
                >
                  <span className="tier-label">{t.label}</span>
                  <span className="tier-desc">{t.desc}</span>
                </button>
              ))}
            </div>
            <p className="hint model-note">
              Routing always runs on {GROQ_MODELS.router} — it only ever classifies one word.
            </p>
          </section>
        </div>

        </>
        )}

        {tab === 'profile' && (
        <div className="profile-row">
          <div className="section-head">
            <span>Your profile</span>
            <span className="optional">optional</span>
          </div>
          <p className="hint profile-hint">
            <strong>Saved locally only</strong> — it lives in this browser's storage, is never
            uploaded and never synced. Tidra never collects any of this on its own; you fill in
            whatever you want it to know, and it's used only while Tidra is doing something you
            asked for — signing a draft, replying in your language. Every field is optional.
          </p>
          <div className="profile-grid">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label htmlFor={'p-' + f.key}>{f.label}</label>
                <input
                  id={'p-' + f.key}
                  type={f.key === 'email' ? 'email' : 'text'}
                  value={profile[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <label htmlFor="pabout">Anything Tidra should know</label>
          <textarea
            id="pabout"
            className="profile-about"
            rows={3}
            value={profile.about}
            placeholder="e.g. Reply briefly and warmly. I write in English and German. Sign off as “Ardit”."
            onChange={(e) => setProfile({ ...profile, about: e.target.value })}
          />
          <div className="profile-foot">
            <button type="button" className="routine-clear" onClick={() => setConfirming('profile')}>
              {profileCleared ? '✓ Cleared' : 'Clear profile'}
            </button>
          </div>
        </div>
        )}

        {tab === 'skills' && (
        <div className="profile-row">
          <div className="section-head">
            <span>Skills</span>
            <span className="optional">slash commands</span>
          </div>
          <p className="hint profile-hint">
            A skill is a saved prompt with a name. Type <strong>/</strong> anywhere in Tidra to run
            one — <strong>/summarize</strong>, <strong>/fact-check</strong>,{' '}
            <strong>/draft-reply</strong>. Make your own, and share them as a file with the buttons
            below. In a prompt, <strong>{'{input}'}</strong> stands for whatever you type after the
            command. Changes here save immediately.
          </p>

          <div className="skill-list">
            {editing === 'new' && skillEditor('new')}
            {skills.map((s) =>
              editing === s.id ? (
                skillEditor(s.id)
              ) : (
                <div key={s.id} className="skill-row">
                  <span className="skill-name">/{s.name}</span>
                  <span className="skill-desc">{s.description || '—'}</span>
                  <span className={'skill-mode skill-mode-' + s.mode}>{s.mode}</span>
                  <button type="button" className="skill-btn" onClick={() => startEdit(s)}>
                    Edit
                  </button>
                  <button type="button" className="skill-btn skill-btn-x" onClick={() => removeSkill(s.id)}>
                    Delete
                  </button>
                </div>
              ),
            )}
          </div>

        </div>
        )}

        {tab === 'routine' && (
        <>
        <div className="routine-row">
          <label className="routine-toggle">
            <input
              type="checkbox"
              checked={routineOn}
              onChange={(e) => setRoutineOn(e.target.checked)}
            />
            <span>
              <strong>Learn my routine</strong> — suggest reopening your usual sites when you start
              browsing. Domains &amp; times are stored only on this device.
            </span>
          </label>
          <button type="button" className="routine-clear" onClick={() => setConfirming('routine')}>
            {cleared ? '✓ Cleared' : 'Clear routine data'}
          </button>
        </div>

        <div className="profile-row">
          <div className="section-head">
            <span>Your routine</span>
            <span className="optional">
              {rtSites.length} site{rtSites.length === 1 ? '' : 's'}
            </span>
            {!rtAdding && (
              <button
                type="button"
                className="skill-btn head-btn"
                onClick={() => {
                  setRtEditing(null);
                  setRtDraft('');
                  setRtAdding(true);
                }}
              >
                + Add site
              </button>
            )}
          </div>
          <p className="hint profile-hint">
            When you press <strong>Start routine</strong> on the new tab, Tidra opens each of these
            sites in the background and does what its task says — drafting only, never sending.
            Changes here save immediately.
          </p>

          {rtSites.length === 0 && !rtAdding && (
            <p className="hint">
              No routine yet — Tidra learns your usual sites as you browse, or add one below.
            </p>
          )}

          <div className="skill-list">
            {rtAdding && (
              <div className="skill-editor">
                <div className="skill-editor-grid">
                  <div>
                    <label htmlFor="rt-add-url">Website</label>
                    <input
                      id="rt-add-url"
                      value={rtAddUrl}
                      placeholder="e.g. gmail.com or notion.so"
                      spellCheck={false}
                      autoFocus
                      onChange={(e) => setRtAddUrl(e.target.value)}
                    />
                  </div>
                </div>
                <label htmlFor="rt-add-task">What should Tidra do here?</label>
                <textarea
                  id="rt-add-task"
                  className="skill-prompt"
                  rows={3}
                  value={rtDraft}
                  placeholder="e.g. Check new emails and draft replies I can review before sending."
                  onChange={(e) => setRtDraft(e.target.value)}
                />
                <div className="skill-editor-foot">
                  <button
                    type="button"
                    className="routine-clear"
                    onClick={() => {
                      setRtAdding(false);
                      setRtDraft('');
                    }}
                  >
                    Cancel
                  </button>
                  <button type="button" className="skill-save" onClick={rtAdd} disabled={!rtAddUrl.trim()}>
                    Add site
                  </button>
                </div>
              </div>
            )}
            {rtSites.map((s) =>
              rtEditing === s.domain ? (
                <div className="skill-editor" key={s.domain}>
                  <div className="rt-editor-head">
                    <img className="rt-ico" src={faviconUrl(s.url)} alt="" />
                    <span className="rt-name">{s.label}</span>
                    <span className="rt-domain">{s.domain}</span>
                  </div>
                  <label htmlFor="rt-task">What should Tidra do here?</label>
                  <textarea
                    id="rt-task"
                    className="skill-prompt"
                    rows={3}
                    value={rtDraft}
                    autoFocus
                    placeholder={defaultTaskFor(s.domain, s.label)}
                    onChange={(e) => setRtDraft(e.target.value)}
                  />
                  <div className="skill-editor-foot">
                    <button type="button" className="routine-clear" onClick={() => setRtEditing(null)}>
                      Cancel
                    </button>
                    <button type="button" className="skill-save" onClick={() => rtSaveTask(s.domain)}>
                      Save task
                    </button>
                  </div>
                </div>
              ) : (
                <div className="skill-row" key={s.domain}>
                  <img className="rt-ico" src={faviconUrl(s.url)} alt="" />
                  <span className="rt-name">{s.label}</span>
                  <span className="skill-desc" title={rtTaskOf(s)}>
                    {rtTaskOf(s)}
                  </span>
                  {!rtTasks[s.domain]?.trim() && <span className="skill-mode">default</span>}
                  <button
                    type="button"
                    className="skill-btn"
                    onClick={() => {
                      setRtAdding(false);
                      setRtEditing(s.domain);
                      setRtDraft(rtTaskOf(s));
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className="skill-btn skill-btn-x" onClick={() => rtRemove(s.domain)}>
                    Remove
                  </button>
                </div>
              ),
            )}

          </div>

        </div>
        </>
        )}

        </div>

        {/* The footer is pinned below the scroll area, so the page's actions
            are always in reach: the skills toolbar there, Save everywhere else. */}
        {tab === 'skills' ? (
          <div className="skill-foot opt-footer">
            <button type="button" className="skill-save" onClick={startNew} disabled={editing === 'new'}>
              + Add skill
            </button>
            <button type="button" className="routine-clear" onClick={doExport} disabled={!skills.length}>
              Export
            </button>
            <button type="button" className="routine-clear" onClick={() => importRef.current?.click()}>
              Import
            </button>
            <button type="button" className="routine-clear" onClick={restoreDefaults}>
              Restore starter pack
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                void doImport(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            {skillNote && <span className="hint skill-note">{skillNote}</span>}
          </div>
        ) : (
          <button className="save" onClick={save} disabled={!apiKey.trim()}>
            {saved ? '✓ Saved' : 'Save'}
          </button>
        )}
      </div>

      {/* Neither clear can be undone — always ask first. */}
      {confirming && (
        <div className="confirm-scrim" onMouseDown={() => setConfirming(null)}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{confirming === 'profile' ? 'Clear your profile?' : 'Clear routine data?'}</h3>
            <p>
              {confirming === 'profile'
                ? 'Every field you filled in will be deleted from this browser. This cannot be undone.'
                : 'The sites and times Tidra learned will be deleted from this browser, and it will start learning your routine from scratch. This cannot be undone.'}
            </p>
            <div className="confirm-foot">
              <button type="button" className="confirm-cancel" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="confirm-go"
                onClick={confirming === 'profile' ? clearProfile : clearRoutine}
              >
                {confirming === 'profile' ? 'Clear profile' : 'Clear routine data'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Options />);
