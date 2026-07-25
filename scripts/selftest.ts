/**
 * End-to-end check of Grace's pipeline with the model stubbed out.
 *
 * Covers everything a real conversation touches — SSE framing, the storage
 * layer, context assembly, profile extraction, compaction, login, and the
 * confirmation guardrails — without needing an API key. What it deliberately
 * does not prove is that the Gemini call itself succeeds; only a real key does
 * that.
 *
 * Run with: npm run selftest
 */

import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import type {ChatEvent, ProfileEntry} from '../shared/types';
import {createApi} from '../server/api';
import {config} from '../server/config';
import {setProvider} from '../server/llm/index';
import type {GenerateRequest, LlmProvider, Turn} from '../server/llm/types';
import {
  clearConversation,
  getMessages,
  getProfile,
  getSummarizedThrough,
  getSummary,
  recentTurns,
} from '../server/memory';
import {setBackend} from '../server/store/index';
import type {Backend} from '../server/store/types';

const REPLY_CHUNKS = ['Good morning. ', 'Nothing pressing today. ', 'Tea at four?'];
const REPLY = REPLY_CHUNKS.join('');
const LEARNED_FACT = 'Prefers tea in the afternoon';

/** Stands in for Gemini, and records what it was asked. */
class StubProvider implements LlmProvider {
  readonly name = 'stub';
  readonly model = 'stub-model';
  lastSystem = '';
  lastTurns: Turn[] = [];

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    this.lastSystem = request.system;
    this.lastTurns = request.turns;
    for (const chunk of REPLY_CHUNKS) yield chunk;
  }

  async complete(request: GenerateRequest): Promise<string> {
    // The JSON-shaped request is profile extraction; the other is summarising.
    if (request.json) {
      return JSON.stringify({
        entries: [{kind: 'preference', text: LEARNED_FACT, source: 'stated'}],
      });
    }
    return 'Earlier, they discussed the day ahead and settled on tea at four.';
  }
}

/** Stands in for Redis, so the cloud path is exercised without a network. */
class MemoryBackend implements Backend {
  readonly name = 'in-memory';
  private data = new Map<string, string>();
  readonly quarantined: string[] = [];

  async read(key: string) {
    return this.data.get(key) ?? null;
  }
  async write(key: string, value: string) {
    this.data.set(key, value);
  }
  async quarantine(key: string, value: string) {
    this.quarantined.push(key);
    this.data.delete(key);
    void value;
  }
}

const stub = new StubProvider();
setProvider(stub);

const backend = new MemoryBackend();
setBackend(backend);

const checks: string[] = [];
function ok(label: string) {
  checks.push(label);
  console.log(`  ✓ ${label}`);
}

const server = createApi().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Set once login succeeds, and sent on everything afterwards. */
let cookie = '';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? {cookie} : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function chat(text: string, via: 'voice' | 'text' = 'text') {
  const response = await call('/chat', {
    method: 'POST',
    body: JSON.stringify({text, via}),
  });
  assert.equal(response.status, 200, 'chat should stream, not error');

  return (await response.text())
    .split('\n\n')
    .filter((frame) => frame.trim().startsWith('data:'))
    .map((frame) => JSON.parse(frame.trim().slice(5)) as ChatEvent);
}

async function reflect(): Promise<ProfileEntry[]> {
  const response = await call('/reflect', {method: 'POST'});
  assert.equal(response.status, 200);
  return ((await response.json()) as {learned: ProfileEntry[]}).learned;
}

try {
  console.log('\nGrace self-test (model and storage stubbed)\n');

  // ---- the lock ----------------------------------------------------------
  assert.equal((await call('/state')).status, 401, 'locked before signing in');
  ok('closed to anyone without the password');

  const wrong = await call('/login', {
    method: 'POST',
    body: JSON.stringify({password: 'not-it'}),
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null, 'no session on a bad password');
  ok('wrong password refused, and hands out no session');

  const right = await call('/login', {
    method: 'POST',
    body: JSON.stringify({password: process.env.GRACE_PASSWORD}),
  });
  assert.equal(right.status, 200);
  const issued = right.headers.get('set-cookie');
  assert.ok(issued, 'a session cookie should be issued');
  assert.match(issued, /HttpOnly/, 'the cookie must be out of reach of scripts');
  cookie = issued.split(';')[0];
  ok('correct password opens a HttpOnly session');

  const forged = await call('/state', {headers: {cookie: 'grace_session=9999999999999.deadbeef'}});
  assert.equal(forged.status, 401, 'a made-up signature must not pass');
  ok('forged session cookie rejected');

  assert.equal((await call('/state')).status, 200);
  ok('signed in, and she opens up');

  // ---- a single exchange, start to finish -------------------------------
  const events = await chat('Morning, Grace.', 'voice');

  const deltas = events.filter((e) => e.type === 'delta');
  assert.equal(
    deltas.map((e) => (e.type === 'delta' ? e.text : '')).join(''),
    REPLY,
    'streamed deltas should reassemble into the full reply',
  );
  ok(`reply streamed in ${deltas.length} pieces and reassembled intact`);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done', 'a done event should close the stream');
  assert.equal(done.message.text, REPLY);
  assert.equal(done.message.via, 'voice', 'reply should inherit the input mode');
  ok('done event carries the finished message');

  // ---- reflection, as its own request ------------------------------------
  const learned = await reflect();
  assert.equal(learned[0]?.text, LEARNED_FACT);
  assert.equal((await getProfile()).entries[0].text, LEARNED_FACT);
  ok('reflect extracted a durable fact after the reply, not during it');

  assert.equal((await getMessages()).length, 2, 'both sides of the exchange stored');
  ok('conversation and profile persisted through the storage layer');

  // ---- the model actually receives context -------------------------------
  await chat('And this afternoon?');
  assert.equal(stub.lastTurns.length, 3, 'prior turns should be replayed');
  assert.equal(stub.lastTurns[1].role, 'assistant');
  assert.equal(stub.lastTurns[2].text, 'And this afternoon?');
  ok('prior turns replayed to the model in the right roles');

  assert.match(stub.lastSystem, /never send a message/i);
  assert.match(stub.lastSystem, /never spend money/i);
  ok('hard limits present in every system prompt');

  assert.match(stub.lastSystem, new RegExp(LEARNED_FACT, 'i'));
  ok('learned facts fed back into the system prompt');

  const before = (await getProfile()).entries.length;
  await chat('Tea again?');
  await reflect();
  assert.equal((await getProfile()).entries.length, before, 'same fact twice is one fact');
  ok('repeat facts deduplicated rather than stacking up');

  // ---- guardrails are structural, not advisory ---------------------------
  for (const category of ['communication', 'purchase']) {
    const locked = await call('/policies', {
      method: 'POST',
      body: JSON.stringify({category, policy: 'never'}),
    });
    assert.equal(locked.status, 409, `${category} must refuse to unlock`);
  }
  ok('locked categories reject attempts to relax them (409)');

  const unlocked = await call('/policies', {
    method: 'POST',
    body: JSON.stringify({category: 'home', policy: 'never'}),
  });
  assert.equal(unlocked.status, 200);
  ok('unlocked categories remain adjustable');

  // ---- bad input does not take the process down --------------------------
  const empty = await call('/chat', {method: 'POST', body: JSON.stringify({text: '   '})});
  assert.equal(empty.status, 400);
  assert.equal((await call('/health')).status, 200, 'server survived');
  ok('malformed request rejected without killing the server');

  // ---- encryption at rest ------------------------------------------------
  const stored = (await backend.read('conversation')) ?? '';
  assert.doesNotMatch(stored, /Morning, Grace/, 'plaintext must not be readable');
  assert.match(stored, /"encrypted":true/);
  ok('memory unreadable in the store without the secret');

  // ---- compaction, and the context gap it used to leave -------------------
  await clearConversation();
  for (let i = 0; i < 21; i += 1) await chat(`Message number ${i}.`);
  assert.ok((await getMessages()).length > config.summarizeAfter);

  const {compacted} = (await (
    await call('/reflect', {method: 'POST'})
  ).json()) as {compacted: boolean};
  assert.ok(compacted, 'compaction should have run');
  assert.ok(await getSummary(), 'older turns folded into a summary');
  ok(`compaction ran at ${(await getMessages()).length} messages and wrote a summary`);

  // Everything the summary does not cover must still be replayed verbatim, or
  // those messages fall out of context entirely: too new for the summary, too
  // old for a fixed-depth window. Asserting an exact count rather than a floor,
  // because a floor of `verbatimTurns` is precisely what the bug satisfied.
  await chat('One more.');
  const replayed = (await recentTurns()).map((turn) => turn.text);
  const total = (await getMessages()).length;
  const summarised = await getSummarizedThrough();
  const expected = total - summarised;

  assert.equal(
    replayed.length,
    expected,
    `every unsummarised message must be replayed: expected ${expected} ` +
      `(${total} total − ${summarised} summarised), got ${replayed.length}`,
  );
  assert.ok(replayed.includes('One more.'), 'the newest message must be replayed');
  ok(
    `no gap between summary and window (${replayed.length} unsummarised of ` +
      `${total} total, all replayed)`,
  );

  // ---- signing out actually closes the door ------------------------------
  await call('/logout', {method: 'POST'});
  cookie = '';
  assert.equal((await call('/state')).status, 401);
  ok('signing out closes the session');

  console.log(`\n${checks.length} checks passed.\n`);
  console.log('Not covered: the real Gemini API call. That needs a live key.\n');
} finally {
  server.close();
  rmSync(config.dataDir, {recursive: true, force: true});
}
