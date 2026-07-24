import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Wordmark } from '../../components/Wordmark';
import { GROQ_MODELS } from '../../lib/llm';
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

function Options() {
  const [apiKey, setApiKey] = useState('');
  const [tier, setTier] = useState('balanced');
  const [routineOn, setRoutineOn] = useState(true);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [cleared, setCleared] = useState(false);
  const [profileCleared, setProfileCleared] = useState(false);
  const [saved, setSaved] = useState(false);
  // Clearing is irreversible, so both clears ask first.
  const [confirming, setConfirming] = useState<'profile' | 'routine' | null>(null);

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
      <div className="card">
        <div className="brand">
          <Orb />
          <Wordmark className="brand-mark" />
        </div>
        <p className="sub">An assistant you won't dread opening.</p>

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

        <button className="save" onClick={save} disabled={!apiKey.trim()}>
          {saved ? '✓ Saved' : 'Save'}
        </button>
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
