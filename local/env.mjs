import {existsSync, readFileSync, writeFileSync} from 'node:fs';

/**
 * Reading and writing .env.local, which is the one place her settings live.
 *
 * Both halves of this were wrong in a way worth writing down, because the
 * failure was invisible for one run and then compounding.
 *
 * Writing used the POSIX single-quote escape — `'` becomes `'\''` — which is
 * correct for a shell and meaningless to dotenv, which is what actually reads
 * this file. Reading went line by line, which is fine until a value has
 * newlines in it: a service-account key is pretty-printed JSON, so everything
 * after its first line was silently dropped. Between them, a key went in whole
 * and came back as `'{`, was re-escaped on the next run, and grew a longer
 * beard of backslashes every time she started.
 *
 * Both are fixed by the same decision: values are written as JSON. That is
 * dotenv's own double-quoted form, it escapes newlines into `\n` so every
 * entry is exactly one line, and it is the one quoting scheme where writing
 * and reading are guaranteed to agree because they are the same function
 * either way round.
 */

/**
 * Settings that are read from somewhere else and must never be copied here.
 *
 * A secret that exists in two places has two places to leak from, two things
 * to keep in step, and — as this file proved — two chances to be mangled. The
 * service-account key lives in its own file and is read fresh on every start.
 */
export const NEVER_STORED = new Set(['GCP_SERVICE_ACCOUNT_JSON']);

export function readEnv(file) {
  if (!existsSync(file)) return {};

  const found = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=([\s\S]*)$/.exec(line.trim());
    if (!match) continue;

    const [, key, raw] = match;
    if (NEVER_STORED.has(key)) continue;

    let value = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        /*
         * Written by an older version of this, and mangled by it.
         *
         * Skipped rather than kept, because a half-read secret is worse than a
         * missing one: missing is asked for again, and half-read is used. This
         * is also the self-repair — the bad line is simply not carried forward
         * into the next write.
         */
        continue;
      }
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) {
      value = raw.slice(1, -1);
      // The old shell-style escape. Left alone rather than un-escaped: it
      // cannot be undone reliably, and pretending otherwise is how a wrong
      // value survives a fix.
      if (value.includes("'\\''")) continue;
    }

    found[key] = value;
  }
  return found;
}

export function writeEnv(file, values) {
  const body = Object.entries(values)
    .filter(([key]) => !NEVER_STORED.has(key))
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join('\n');

  writeFileSync(file, `${body}\n`, {mode: 0o600});
}
