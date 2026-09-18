/**
 * Does a settings file survive being written and read back?
 *
 * It did not, and the way it failed is the reason this exists. A
 * service-account key is pretty-printed JSON, so it has newlines; the reader
 * went line by line and kept only the first. The writer used the POSIX
 * single-quote escape, which is correct for a shell and meaningless to the
 * library that actually reads the file. Between them a key went in whole, came
 * back as `'{`, was re-escaped on the next start, and grew a longer beard of
 * backslashes every time — until Google was handed `'\''\'\'''\''{` and the
 * voice died on it.
 *
 * None of that is visible in one run. It needs a value with a newline in it
 * and a second start, which is exactly the shape of thing a test is for and a
 * person is not.
 *
 *   npm run check:env
 */

import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NEVER_STORED, readEnv, writeEnv} from './env.mjs';

const file = join(mkdtempSync(join(tmpdir(), 'grace-env-')), '.env.local');

let passed = 0;
const check = (what, run) => {
  run();
  passed += 1;
  console.log(`  ✓ ${what}`);
};

console.log('\nsettings that survive a round trip');

/** The shape of the thing that actually broke: real, multi-line, quoted. */
const KEY = JSON.stringify(
  {
    type: 'service_account',
    project_id: 'ai-agents-508818',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEv"quoted"\\escaped\n-----END-----\n',
    client_email: 'x@y.iam.gserviceaccount.com',
  },
  null,
  2,
);

check('a value with newlines comes back whole', () => {
  writeEnv(file, {AWKWARD: KEY});
  assert.equal(readEnv(file).AWKWARD, KEY);
});

check('and it is one line in the file, whatever it contains', () => {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'a multi-line entry is one the next reader will truncate');
});

check('quotes, backslashes and equals signs all survive', () => {
  const nasty = {
    QUOTED: `it's "both" kinds`,
    SLASHED: 'C:\\Users\\hamza\\Grace-Vercel',
    EQUALS: 'a=b=c',
    SPACED: '  leading and trailing  ',
  };
  writeEnv(file, nasty);
  assert.deepEqual(readEnv(file), nasty);
});

check('ten round trips change nothing', () => {
  // The compounding is the fault. One pass looked fine; it was the second,
  // third and fourth starts that turned a key into gibberish.
  let values = {KEY, PASSWORD: `don't "look"`};
  for (let again = 0; again < 10; again += 1) {
    writeEnv(file, values);
    values = readEnv(file);
  }
  assert.equal(values.KEY, KEY);
  assert.equal(values.PASSWORD, `don't "look"`);
});

console.log('\nsecrets that are not kept here at all');

check('the Google key is never written, however it is passed in', () => {
  writeEnv(file, {GCP_SERVICE_ACCOUNT_JSON: KEY, PORT: '7766'});
  const written = readFileSync(file, 'utf8');
  assert.ok(!written.includes('GCP_SERVICE_ACCOUNT_JSON'), 'it lives in its own file');
  assert.ok(!written.includes('private_key'), 'and none of it leaks in by another name');
  assert.equal(readEnv(file).PORT, '7766', 'everything else is kept as normal');
});

check('and a mangled one left by the old version is discarded, not used', () => {
  // Exactly what was on the user's disk, which is worth keeping as the fixture.
  writeFileSync(
    file,
    [`GCP_SERVICE_ACCOUNT_JSON='\\''\\'\\'''\\''{`, `PORT="7766"`].join('\n'),
  );
  const read = readEnv(file);
  assert.equal(read.GCP_SERVICE_ACCOUNT_JSON, undefined, 'a half-read secret is worse than none');
  assert.equal(read.PORT, '7766', 'and the rest of the file still works');
});

check('an old shell-escaped value is dropped rather than half-understood', () => {
  writeFileSync(file, `LEGACY='it'\\''s broken'\nFINE="ordinary"\n`);
  const read = readEnv(file);
  assert.equal(read.LEGACY, undefined);
  assert.equal(read.FINE, 'ordinary');
});

check('the list of things never stored is not empty', () => {
  assert.ok(NEVER_STORED.has('GCP_SERVICE_ACCOUNT_JSON'));
});

console.log(`\n${passed} checks passed.\n`);
