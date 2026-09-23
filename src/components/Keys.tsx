import {useEffect, useState} from 'react';
import {fetchKeys, googleStatus, saveKey, type KeyName, type KeyStatus} from '../lib/api';
import type {GoogleStatus} from '../../shared/types.ts';

const FIELDS: {name: KeyName; label: string; blurb: string; secret: boolean}[] = [
  {
    name: 'gemini',
    label: 'Gemini',
    blurb: 'What she thinks, listens and speaks with. From aistudio.google.com.',
    secret: true,
  },
  {
    name: 'googleClientId',
    label: 'Google client ID',
    blurb: 'For mail and diary. Ends in .apps.googleusercontent.com.',
    secret: true,
  },
  {
    name: 'googleClientSecret',
    label: 'Google client secret',
    blurb: 'From the same screen. Starts with GOCSPX-.',
    secret: true,
  },
  {
    name: 'ownerEmail',
    label: 'Your Google address',
    blurb: 'Only this account may connect, so nobody else can attach theirs.',
    secret: false,
  },
  {
    name: 'govee',
    label: 'Govee',
    blurb: 'Her lights. From the Govee app: Settings → Apply for API Key.',
    secret: true,
  },
  {
    name: 'psn',
    label: 'PlayStation',
    blurb:
      'Sign in to PlayStation in a browser, open ca.account.sony.com/api/v1/ssocookie, ' +
      'and paste the npsso value. She can see the console — never operate it.',
    secret: true,
  },
  {
    name: 'github',
    label: 'GitHub',
    blurb:
      'A personal access token from github.com/settings/tokens. She only ever ' +
      'reads: PRs, reviews, failing builds. Read scope is enough.',
    secret: true,
  },
  {
    name: 'n8nUrl',
    label: 'n8n address',
    blurb: 'Your n8n instance URL, e.g. https://you.app.n8n.cloud.',
    secret: false,
  },
  {
    name: 'n8n',
    label: 'n8n API key',
    blurb: 'From n8n: Settings → n8n API → create. So she can report failures.',
    secret: true,
  },
];

/**
 * Keys, pasted straight into her.
 *
 * The alternative is the hosting dashboard, which means finding the right
 * project and the right variable and then waiting out a redeploy. This takes
 * ten seconds and works from a phone. Nothing typed here is ever sent back —
 * only whether a key is present, and its last four characters.
 */
export function Keys({onSaved}: {onSaved?: () => void}) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchKeys().then(setStatus).catch(() => {});
    googleStatus().then(setGoogle).catch(() => {});
  }, []);

  const save = async (name: KeyName) => {
    setSaving(name);
    setError(null);
    try {
      setStatus(await saveKey(name, drafts[name] ?? ''));
      setDrafts((current) => ({...current, [name]: ''}));
      // Anything that depends on a key has to be told, or the interface goes
      // on showing "not configured" at something that now is.
      onSaved?.();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-3">
      {FIELDS.map((field) => {
        const state = status?.[field.name];
        return (
          <div key={field.name}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-xs text-slate-300">{field.label}</span>
              <span
                className={`text-[0.62rem] ${state?.set ? 'text-ice/80' : 'text-mist/50'}`}>
                {state?.set ? (state.hint ?? 'set') : 'not set'}
              </span>
            </div>
            <p className="mb-1.5 text-[0.62rem] leading-relaxed text-mist/50">
              {field.blurb}
            </p>
            <div className="flex gap-1.5">
              <input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                value={drafts[field.name] ?? ''}
                onChange={(event) =>
                  setDrafts((current) => ({...current, [field.name]: event.target.value}))
                }
                placeholder="Paste a key"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-mist/40 focus:border-ice/40 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void save(field.name)}
                disabled={saving === field.name}
                className="shrink-0 rounded-lg border border-ice/40 bg-ice/15 px-2.5 py-1.5 text-xs text-ice transition hover:bg-ice/25 disabled:opacity-40">
                {saving === field.name ? '…' : 'Save'}
              </button>
            </div>
          </div>
        );
      })}
      {/* Right here, next to the credentials that make it possible. Burying it
          elsewhere means pasting two keys and then hunting for the button. */}
      {/* The one value that has to be typed into Google's console by hand, and
          the one people get wrong. The server always knew it; nothing showed it. */}
      {google && !google.connected && (
        <div className="rounded-lg border border-mist/15 bg-black/20 px-3 py-2">
          <p className="text-[0.65rem] text-mist/60">
            In Google Cloud → Credentials → your OAuth client, add this exactly
            under <span className="text-mist/80">Authorised redirect URIs</span>:
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-[0.7rem] text-ice">{google.redirectUri}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(google.redirectUri).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="shrink-0 rounded border border-ice/40 px-2 py-0.5 text-[0.65rem] text-ice hover:bg-ice/15">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      {google?.connected && (
        <p className="text-[0.65rem] text-mist/60">
          Google connected{google.email ? ` as ${google.email}` : ''}.
          {google.problem && <span className="text-rose-300"> {google.problem}</span>}
        </p>
      )}
      {status?.googleClientId.set && status?.googleClientSecret.set && (
        <a
          href="/api/google-start"
          className="block rounded-lg border border-ice/40 bg-ice/15 px-3 py-2 text-center text-xs text-ice transition hover:bg-ice/25">
          Connect Gmail and Calendar
        </a>
      )}

      {error && <p className="text-xs text-rose-300">{error}</p>}
      <p className="text-[0.6rem] leading-relaxed text-mist/40">
        Stored encrypted, and never sent back to this page. Leave a box empty and
        save to clear a key and fall back to the hosting environment.
      </p>
    </div>
  );
}
