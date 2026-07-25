import {KeyRound} from 'lucide-react';
import {useState} from 'react';
import type {SessionStatus} from '../lib/api.ts';

const MISCONFIGURED = `Grace is deployed without a password, so she is refusing to
answer at all rather than sit open to anyone who finds this address. Set
GRACE_PASSWORD in your hosting environment and redeploy.`;

export function Lock({
  status,
  onSubmit,
}: {
  status: SessionStatus;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!password || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (cause) {
      setError((cause as Error).message);
      setPassword('');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="relative grid h-screen place-items-center overflow-hidden px-6">
      <div className="ambient pointer-events-none absolute inset-0 -z-10" />

      <div className="w-full max-w-sm text-center">
        <h1 className="font-serif text-3xl tracking-wide text-slate-100">Grace</h1>

        {status === 'misconfigured' ? (
          <p className="mt-6 rounded-xl border border-ember/25 bg-ember/10 px-4 py-3 text-left text-sm leading-relaxed text-ember/90">
            {MISCONFIGURED}
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-mist/70">Good to see you.</p>

            <div className="mt-8 flex gap-2">
              <div className="relative flex-1">
                <KeyRound
                  size={15}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mist/50"
                />
                <input
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit();
                  }}
                  placeholder="Password"
                  aria-label="Password"
                  className="w-full rounded-full border border-edge bg-surface py-2.5 pl-10 pr-4 text-sm text-slate-200 placeholder:text-mist/50 focus:border-ice/40 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!password || pending}
                className="rounded-full border border-ice/40 bg-ice/15 px-5 text-sm text-ice transition hover:bg-ice/25 disabled:opacity-30">
                {pending ? '…' : 'Enter'}
              </button>
            </div>

            {error && <p className="mt-3 text-xs text-rose-300/90">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
