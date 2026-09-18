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
import {spawn} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import type {ChatEvent, ProfileEntry} from '../shared/types';
import {createApi} from '../server/api';
import {config} from '../server/config';
import {GeminiProvider} from '../server/llm/gemini';
import {setProvider} from '../server/llm/index';
import type {
  GenerateRequest,
  LlmProvider,
  SpeakRequest,
  SpokenAudio,
  TranscribeRequest,
  Turn,
} from '../server/llm/types';
import {
  clearConversation,
  getMessages,
  getProfile,
  getSummarizedThrough,
  getSummary,
  recentTurns,
} from '../server/memory';
import {CHUNK_TARGET, chunkForSpeech} from '../shared/speech';
import {recentDeeds} from '../server/journal';
import {labelMail} from '../server/google/gmail';
import {getMode, setMode} from '../server/modes';
import {workspaces} from '../server/workspaces';
import {buildSystemPrompt} from '../server/persona';
import {BANDS} from '../shared/voiceprint';
import {trimTrailingSilence} from '../shared/trim';
import {heardName, isPhantom, toldToSleep} from '../shared/wake';
import {parseCommand, suggest} from '../shared/commands';
import {looksDestructive} from '../server/tools/machine';
import {missingModel} from '../server/llm/gemini';
import {requiresConfirmation, setPolicy} from '../server/actions';
import {logKey, metaKey} from '../server/chats';
import {forSpeaking, relayUrl} from '../server/relay';
import {THINKING, effortFor} from '../shared/effort';
import {forgetLights} from '../server/lights';
import {allScenes, findScene, kelvinToRgb} from '../server/scenes';
import {setKey} from '../server/keys';
import {Document} from '../server/store/index';
import {voiceChecks} from './voicecheck';
import {pulse} from '../server/pulse';
import {setBackend} from '../server/store/index';
import {allTools, auditTools, declarations, runTool} from '../server/tools/index';
import {worthLearningFrom} from '../server/learn';
import {priceOf, record as bill, spend as readSpend} from '../server/budget';
import {parseDuration} from '../server/tools/timers';
import {allReminders, outstanding} from '../server/tools/reminders';
import type {Backend} from '../server/store/types';

const REPLY_CHUNKS = ['Good morning. ', 'Nothing pressing today. ', 'Tea at four?'];
const REPLY = REPLY_CHUNKS.join('');
const LEARNED_FACT = 'Prefers tea in the afternoon';
const TRANSCRIBED = 'What is on today?';
/** A valid, empty WAV — enough for the route to be exercised end to end. */
const SPOKEN_AUDIO =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

/** Stands in for Gemini, and records what it was asked. */
class StubProvider implements LlmProvider {
  readonly name = 'stub';
  readonly model = 'stub-model';
  lastSystem = '';
  lastTurns: Turn[] = [];

  lastSearch: boolean | undefined = undefined;
  lastTools: {name: string}[] | undefined = undefined;
  /** Set to make the next reply call a tool, as the real model would. */
  nextToolCall: {name: string; args: Record<string, unknown>} | null = null;

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    this.lastSystem = request.system;
    this.lastTurns = request.turns;
    this.lastSearch = request.search;
    this.lastTools = request.tools as {name: string}[] | undefined;

    if (this.nextToolCall && request.onToolCall) {
      const {name, args} = this.nextToolCall;
      this.nextToolCall = null;
      // Exactly what the provider does: hand onToolUsed whatever onToolCall
      // returned. That is the seam the display summary used to fall through.
      const result = await request.onToolCall(name, args);
      request.onToolUsed?.(name, result);
    }

    for (const chunk of REPLY_CHUNKS) yield chunk;
  }

  async complete(request: GenerateRequest): Promise<string> {
    this.lastSearch = request.search;
    // The JSON-shaped request is profile extraction; the other is summarising.
    if (request.json) {
      return JSON.stringify({
        entries: [{kind: 'preference', text: LEARNED_FACT, source: 'stated'}],
      });
    }
    return 'Earlier, they discussed the day ahead and settled on tea at four.';
  }

  lastAudio: TranscribeRequest | null = null;

  async transcribe(request: TranscribeRequest): Promise<string> {
    this.lastAudio = request;
    return TRANSCRIBED;
  }

  lastSpoken: string | null = null;

  async speak(request: SpeakRequest): Promise<SpokenAudio> {
    this.lastSpoken = request.text;
    return {audio: SPOKEN_AUDIO, mimeType: 'audio/wav'};
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

/** Only ever used to inspect the request it would build. */
/*
 * Built on the models she actually runs, not on a hardcoded one.
 *
 * These were pinned to the 2.5 line, which meant the suite was proving that
 * the *outgoing* code path worked. Every check passed while the models behind
 * them were three weeks from shutdown, and the two generations do not take the
 * same parameters — so a green suite would have said nothing at all about
 * whether she still worked on 20 October.
 *
 * A test fixture that names a model is a test fixture that expires.
 */
const provider = new GeminiProvider('unused', config.transcribeModel);

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

  // ---- deploy config points at files that exist --------------------------
  // A stale pattern here fails the build with "doesn't match any Serverless
  // Functions", which costs a whole deploy cycle to discover. It has happened.
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
    headers?: {headers?: {key: string; value: string}[]}[];
    functions?: Record<string, unknown>;
  };
  for (const pattern of Object.keys(vercel.functions ?? {})) {
    assert.ok(
      existsSync(pattern),
      `vercel.json declares "${pattern}", but no such file exists`,
    );
  }
  assert.ok(
    existsSync('api/[...path].js'),
    'the bundled function must be committed, not generated at deploy time',
  );
  ok('vercel.json function patterns match files that exist');

  /*
   * The policy must permit the voice it is deployed alongside.
   *
   * `connect-src 'self'` was correct-looking and silently disabled the live
   * voice for a day: the browser holds a socket to the outpost, that is a
   * different origin, the connection was refused, and she fell back to
   * recording and replying. The fallback works well enough that it read as
   * success. Nothing failed loudly; the feature simply was not running.
   *
   * Two things are checked, because two things can drift. The policy must
   * name the outpost, and the CDN's copy in vercel.json — which is what the
   * browser actually receives, since the page never touches this code — must
   * say the same as the copy the server sends.
   */
  const {OUTPOST, SECURITY_HEADERS} = await import('../shared/headers');
  const policy = SECURITY_HEADERS['Content-Security-Policy'] ?? '';
  assert.ok(
    policy.includes(OUTPOST),
    'the policy must permit a socket to the outpost, or the voice cannot open one',
  );

  const served = vercel.headers
    ?.flatMap((entry) => entry.headers ?? [])
    .find((header) => header.key === 'Content-Security-Policy')?.value;
  assert.ok(served, 'vercel.json must declare a policy; the CDN never runs this code');
  assert.equal(
    served,
    policy,
    'the CDN copy and the server copy must agree — the browser only ever sees the CDN one',
  );

  if (process.env.GRACE_OUTPOST_URL) {
    // The address in the policy and the address she is told to dial have to
    // be the same host. They are set in different files, months apart.
    assert.equal(
      new URL(process.env.GRACE_OUTPOST_URL).origin,
      new URL(OUTPOST).origin,
      'she is configured to dial an outpost the policy does not allow',
    );
  }
  ok('the policy permits the voice it ships with, in both copies');

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
  const events = await chat('Morning Grace. I always take my tea in the afternoon.', 'voice');

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

  // The gate that keeps most turns from paying for a learning call at all.
  assert.equal(worthLearningFrom('ok thanks'), false, 'trivia teaches nothing');
  assert.equal(worthLearningFrom('open work'), false, 'a bare command teaches nothing');
  assert.equal(worthLearningFrom('what is the weather'), false, 'a passing question either');
  assert.ok(worthLearningFrom('I moved to Berlin last month'), 'but a personal fact does');
  assert.ok(worthLearningFrom('anything', true), 'and a sweep always runs');
  ok('the learning gate spends a model call only when there is something to learn');

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

  // ---- hearing -----------------------------------------------------------
  // The route that replaced the browser's own speech recognition, which does
  // not exist in Firefox or on iOS and failed silently everywhere else.
  const spoken = await call('/transcribe', {
    method: 'POST',
    body: JSON.stringify({audio: 'ZmFrZS13YXY=', mimeType: 'audio/wav'}),
  });
  assert.equal(spoken.status, 200);
  assert.equal(((await spoken.json()) as {text: string}).text, TRANSCRIBED);
  assert.equal(stub.lastAudio?.mimeType, 'audio/wav', 'audio reaches the model');
  ok('recorded speech is transcribed server-side');

  // Recognising a name is the difference between "tell Yusuf I'll be late" and
  // "tell you soon I'll be late", so what she already knows has to reach the
  // transcriber. Without this the hint could quietly stop being sent and only
  // show up as her mishearing people slightly more often.
  assert.match(
    stub.lastAudio?.context ?? '',
    new RegExp(LEARNED_FACT),
    'what she knows about the speaker must reach the transcriber',
  );
  assert.match(
    stub.lastAudio?.context ?? '',
    /The conversation so far:[\s\S]*Grace: /,
    'and so must the most recent turns, labelled by who said them',
  );
  ok('transcription is given names and topic to recognise');

  const noAudio = await call('/transcribe', {
    method: 'POST',
    body: JSON.stringify({mimeType: 'audio/wav'}),
  });
  assert.equal(noAudio.status, 400, 'an empty recording is rejected, not sent on');
  ok('empty recording refused with a reason');

  assert.equal(
    (await call('/transcribe', {method: 'POST', body: '{}'})).status,
    400,
    'transcription must require audio',
  );
  ok('transcription endpoint validates its input');

  // ---- her voice ---------------------------------------------------------
  // Generated here rather than by the browser, which has no speech synthesis
  // at all on some platforms and a different voice on every other.
  const voice = await call('/speak', {
    method: 'POST',
    body: JSON.stringify({text: 'Good morning.'}),
  });
  assert.equal(voice.status, 200);
  const voiceBody = (await voice.json()) as {audio: string; mimeType: string};
  assert.equal(voiceBody.mimeType, 'audio/wav', 'audio must be playable as-is');
  assert.equal(
    Buffer.from(voiceBody.audio, 'base64').subarray(0, 4).toString(),
    'RIFF',
    'the audio must actually be a WAV, header and all',
  );
  assert.equal(stub.lastSpoken, 'Good morning.', 'the words reach the model');
  ok('replies are spoken as server-generated audio');

  assert.equal(
    (await call('/speak', {method: 'POST', body: JSON.stringify({text: '  '})})).status,
    400,
    'speaking must require something to say',
  );
  ok('speech endpoint validates its input');

  // ---- the web -----------------------------------------------------------
  // Grounding has to be asked for on the chat call, and must never be asked
  // for alongside a forced JSON shape — providers reject the combination, and
  // that would take profile extraction down with it.
  // Searching is a tool now, not a mode on the conversation. Gemini rejects
  // its built-in search alongside function calling outright, so the request
  // that carries her tools must never also ask for grounding.
  await chat('What is the weather doing?');
  assert.notEqual(
    stub.lastSearch,
    true,
    'the conversation itself must not request grounding',
  );
  assert.ok(
    (stub.lastTools ?? []).some((tool) => tool.name === 'search_web'),
    'she should be given the web as something she can reach for',
  );
  ok('the web is a tool she chooses, not a mode on every request');

  // The bug this guards against cost her the web for days without an error
  // anywhere: the search tool was attached, deliberation was switched off, and
  // deciding to call a tool *is* deliberation — so she answered from memory
  // and then said, quite correctly, that she could not browse.
  const grounded = provider.params({
    system: 's',
    turns: [{role: 'user', text: 'what is the news?'}],
    fast: true,
    search: true,
  });
  assert.ok(grounded.config.tools, 'the search tool should be attached');

  // Gemini rejects the two together outright: "Built-in tools and Function
  // Calling cannot be combined in the same request." Shipping both meant that
  // the moment she was given hands, she lost the web. Searching is a function
  // now, so no request may ever carry both again.
  for (const req of [
    {system: 's', turns: [], search: true, tools: declarations()},
    {system: 's', turns: [], search: true},
    {system: 's', turns: [], tools: declarations()},
  ]) {
    const kinds = ((provider.params(req).config.tools ?? []) as Record<string, unknown>[])
      .map((entry) => Object.keys(entry)[0]);
    assert.ok(
      !(kinds.includes('googleSearch') && kinds.includes('functionDeclarations')),
      'built-in search and function calling must never be sent together',
    );
  }
  ok('search and function calling are never combined in one request');
  // Deciding to call a tool is itself deliberation, so a zero budget leaves
  // the tool present and unused — she answers from memory and then says she
  // cannot reach the web. It must be small, for the sake of the pause before
  // she speaks, and it must not be nothing.
  const thinking = grounded.config.thinkingConfig;
  assert.ok(thinking, 'deliberation must always be set explicitly, never left to default');

  // Which of the two it is depends on the generation, and asserting on the
  // wrong one is how this check quietly became vacuous once before: on a 3.x
  // model `thinkingBudget` is undefined, so every `budget === undefined || …`
  // passed without testing anything.
  if (thinking.thinkingLevel !== undefined) {
    assert.notEqual(
      String(thinking.thinkingLevel).toLowerCase(),
      'minimal',
      'thinking must not be switched off while a tool is attached',
    );
    assert.notEqual(
      String(thinking.thinkingLevel).toLowerCase(),
      'high',
      'and must stay modest, or every reply waits on it',
    );
  } else {
    const budget = thinking.thinkingBudget;
    assert.ok(
      budget !== undefined && budget > 0,
      `thinking must not be switched off while a tool is attached, got ${budget}`,
    );
    assert.ok(budget <= 1024, `and must stay small — got ${budget}`);
  }

  const plain = provider.params({
    system: 's',
    turns: [{role: 'user', text: 'hello'}],
    fast: true,
  });
  const idle = plain.config.thinkingConfig;
  assert.ok(
    idle?.thinkingBudget === 0 || String(idle?.thinkingLevel).toLowerCase() === 'low',
    'without a tool, deliberation should be as low as the model accepts',
  );
  assert.notEqual(
    String(idle?.thinkingLevel).toLowerCase(),
    'minimal',
    'and never minimal, which 3.8 Flash rejects with a 400',
  );
  ok('deliberation stays on whenever a tool is attached');

  /*
   * Nothing she runs on may be from a line with a published shutdown date.
   *
   * This is the check that would have caught the fixtures above. It is not
   * about 2.5 specifically — it is that a model generation is a thing with an
   * end date, and the failure when one arrives is total and silent: every
   * request 404s, which looks identical to a typo in a model name.
   */
  for (const [what, model] of [
    ['the model she thinks with', config.model],
    ['the model she thinks harder with', config.hardModel],
    ['the model that listens', config.transcribeModel],
    ['the model that speaks', config.speechModel],
  ] as const) {
    assert.ok(
      !/^gemini-2\./.test(model),
      `${what} (${model}) is on the 2.5 line, which shuts down on 20 October 2026`,
    );
  }
  ok('nothing she runs on is from a retired model line');

  // Every model she actually uses must have a known price. An unrecognised one
  // is charged at the dearest rate in the table rather than ignored — which is
  // the safe direction, and also means swapping a model for a cheaper one and
  // forgetting to price it would show up as her spending three times more, and
  // stop her early against a cap she had not really reached.
  for (const [what, model] of [
    ['the model she thinks with', config.model],
    ['the model she thinks harder with', config.hardModel],
    ['the model that listens', config.transcribeModel],
    ['the model that speaks', config.speechModel],
  ] as const) {
    assert.ok(
      priceOf(model),
      `${what} (${model}) has no rate, so it would be billed at the fallback`,
    );
  }
  ok('every model she uses is priced, so the meter is not guessing');

  /*
   * A retired model must not make her deaf.
   *
   * Hearing runs on a cheaper model than thinking, so it can be retired on its
   * own while everything else still works. Google retires models on published
   * dates and sometimes ahead of them. The symptom would be the worst kind:
   * she stops understanding anything said aloud, and nothing on screen says why.
   */
  const heard: string[] = [];
  const deaf = new GeminiProvider('unused', config.model);
  (deaf as unknown as {client: unknown}).client = {
    models: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateContent: async (params: any) => {
        heard.push(params.model);
        if (params.model !== config.model) {
          throw new Error('models/whatever is not found for API version v1beta');
        }
        return {text: 'the words that were said', usageMetadata: {}};
      },
    },
  };

  const rescued = await deaf.transcribe({audio: SPOKEN_AUDIO, mimeType: 'audio/wav'});
  assert.equal(rescued, 'the words that were said', 'she must still hear');
  assert.equal(heard.length, 2, 'one attempt, then one fallback — not a loop');
  assert.equal(heard[1], config.model, 'falling back to the model that is alive');
  ok('a retired transcription model falls back rather than making her deaf');

  // ---- how hard she thinks, per sentence ---------------------------------
  // One flat budget for everything meant a question worth thinking about got
  // exactly as much thought as a light switch. These are the sentences the
  // split has to get right; the cost of a wrong call is a slower or shallower
  // answer, never an incorrect one.
  for (const [said, wanted] of [
    ['turn the lights off', 'reflex'],
    ['lights on', 'reflex'],
    ['set a timer for ten minutes', 'reflex'],
    ['goodnight', 'reflex'],
    ['what time is my meeting', 'ordinary'],
    ['who did I say was coming on Thursday', 'ordinary'],
    ['thanks', 'ordinary'],
    ['why did the lights not come on last night', 'hard'],
    ['should I take the earlier train or the later one', 'hard'],
    ['what is the difference between the two invoices', 'hard'],
    ['explain what happened with the deployment', 'hard'],
    ['is it worth switching the whole thing over, and what would break', 'hard'],
  ] as const) {
    const {effort, because} = effortFor(said);
    assert.equal(effort, wanted, `"${said}" should be ${wanted}, got ${effort} (${because})`);
  }
  assert.ok(
    THINKING.hard > THINKING.ordinary && THINKING.ordinary > THINKING.reflex,
    'the levels must actually be levels',
  );
  ok('deliberation is spent per sentence, not flat across every one');

  /*
   * The trap that makes all of the above backfire.
   *
   * On Gemini's 2.5 models thinking is spent out of maxOutputTokens, so a
   * ceiling of 2048 with a 4096-token thinking budget does not produce a
   * well-considered short answer — it produces an empty string, from a
   * request that reads as entirely sensible. The caller's number has to mean
   * room for the reply, with deliberation added on top.
   */
  const considered = provider.params({
    system: 's',
    turns: [{role: 'user', text: 'why did that happen?'}],
    think: THINKING.hard,
    maxOutputTokens: 2048,
    tools: declarations(),
  });
  assert.equal(
    considered.config.maxOutputTokens,
    2048 + THINKING.hard,
    'thinking must not be taken out of the room left for the answer',
  );
  const {levelFor, levelsFor, thinkingFor} = await import('../server/llm/thinking');
  assert.deepEqual(
    considered.config.thinkingConfig,
    thinkingFor(config.transcribeModel, THINKING.hard),
    'the deliberation asked for must reach the model, in whichever dialect it speaks',
  );
  ok('thinking is added to the output ceiling rather than eating the reply');

  // The floor from the bug above still holds, whatever a caller asks for.
  assert.deepEqual(
    provider.params({system: 's', turns: [], think: 0, tools: declarations()}).config
      .thinkingConfig,
    thinkingFor(config.transcribeModel, THINKING.reflex),
    'a tool in hand means she must be allowed enough thought to reach for it',
  );

  /*
   * The two generations do not take the same parameter, and sending both is
   * a 400 rather than a preference — so a model that lands on the wrong side
   * of this fork does not degrade, it fails every single call.
   */
  assert.ok(
    'thinkingBudget' in thinkingFor('gemini-2.5-flash', 1024),
    'the 2.5 line takes a token budget',
  );
  assert.ok(
    'thinkingLevel' in thinkingFor('gemini-3.8-flash', 1024),
    'the 3.x line takes a named level',
  );
  for (const model of ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview']) {
    const sent = thinkingFor(model, 1024);
    assert.ok(
      !('thinkingBudget' in sent && 'thinkingLevel' in sent),
      `${model} must never be sent both budget and level — that is a 400, not a preference`,
    );
  }
  ok('each model generation is asked for deliberation in its own dialect');

  /*
   * ---- a model that is not there costs a log line, not the answer --------
   *
   * The name of the better model is configuration, and configuration goes
   * wrong: `gemini-3.1-pro` looked right, does not exist, and killed every
   * turn she judged worth escalating — which is the worst possible place for
   * a failure to land. The exact message Vertex sent is the fixture, because
   * a matcher written against a remembered error is a matcher that has never
   * been tested against a real one.
   */
  const REAL_404 =
    'got status: 404 Not Found. {"error":{"code":404,"message":"Publisher model ' +
    '`projects/ai-agents-508818/locations/global/publishers/google/models/' +
    'gemini-3.1-pro` was not found or your project does not have access to it. ' +
    'Ensure you are using a valid model name and that the model is available in ' +
    'the specified region.","status":"NOT_FOUND"}}';

  assert.equal(missingModel(new Error(REAL_404)), true, 'the real message is recognised');
  for (const other of [
    'got status: 429. {"error":{"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}',
    'got status: 403. {"error":{"message":"Permission denied on resource","status":"PERMISSION_DENIED"}}',
    'got status: 404. {"error":{"message":"Requested entity was not found.","status":"NOT_FOUND"}}',
    'fetch failed',
  ]) {
    assert.equal(
      missingModel(new Error(other)),
      false,
      `must not be mistaken for a missing model: ${other.slice(0, 40)}`,
    );
  }
  ok('a missing model is told apart from a bad key, a quota, and a stray 404');

  // And the name she is actually configured with has a price, or the meter
  // charges her the dearest rate for the one model she reaches for when it
  // matters — which is how a cap gets hit that was never really reached.
  assert.ok(
    priceOf(config.hardModel),
    `${config.hardModel} must be priced, or her spending is fiction`,
  );
  ok('the better model is named something that exists, and is priced');

  /*
   * Pro has no middle setting. Asking for one is rejected, which would make
   * every hard question fail while the same question on Flash succeeded — a
   * bug that reads as "Pro is broken" rather than as a two-value enum.
   */
  assert.deepEqual(
    levelsFor(config.hardModel),
    ['low'],
    'Pro is held at low: high thinking plus tool calls does not fit in the ' +
      "hosting's sixty-second window, and overrunning it returns nothing at all",
  );
  for (const tokens of [0, THINKING.reflex, THINKING.ordinary, THINKING.hard]) {
    assert.ok(
      levelsFor(config.hardModel).includes(levelFor(config.hardModel, tokens)),
      `${tokens} tokens must map to a level Pro actually offers`,
    );
  }
  assert.equal(
    levelFor(config.hardModel, THINKING.hard),
    'low',
    'even the hardest question stays inside the time it is allowed to take',
  );
  assert.equal(
    levelFor(config.model, THINKING.ordinary),
    'medium',
    'a level the model does offer is used as asked',
  );
  // `minimal` is real in the API and 3.8 Flash refuses it. Every background
  // job — greeting, compaction, learning — 400'd on it for a day. Zero
  // thought now lands on the lowest level a model actually accepts.
  assert.equal(levelFor(config.model, 0), 'low', 'nothing to think about is sent as low');
  for (const model of [config.model, config.hardModel, config.transcribeModel]) {
    assert.notEqual(
      levelFor(model, 0),
      'minimal',
      `${model}: minimal must never go out — it is rejected and the failure is silent`,
    );
  }
  assert.equal(
    levelFor(config.model, THINKING.reflex),
    'low',
    'a reflex must stay above minimal, or she holds a tool and never reaches for it',
  );
  ok('a model is never asked for a thinking level it does not offer');

  /*
   * Her bearing, which is not a mood and must not drift into being one.
   *
   * The screen shows a word for how she is — and she has no feelings, so
   * every one of those words has to be read from something measured. An
   * invented one would be a decoration that lies, and this particular lie
   * gets believed, because a panel saying "cheerful" is very hard to read as
   * "nothing here is being measured".
   */
  const {bearingOf, bearingWarns} = await import('../shared/bearing');

  assert.equal(bearingOf({offline: true}), 'dormant');
  assert.equal(bearingOf({listening: true}), 'attentive');
  assert.equal(bearingOf({thinking: true, effort: 'hard'}), 'deliberating');
  assert.equal(bearingOf({thinking: true, effort: 'reflex'}), 'brisk');
  assert.equal(bearingOf({thinking: true, effort: 'ordinary'}), 'considering');
  assert.equal(bearingOf({speaking: true}), 'speaking');
  assert.equal(bearingOf({acting: true}), 'occupied');

  // Ahead of everything else, including things she is actively doing. It is
  // the only state on the list you can do something about, and burying it
  // under "occupied" would make the panel worse than having none.
  assert.equal(
    bearingOf({asking: true, acting: true, speaking: true, thinking: true}),
    'waiting on you',
    'a question you have not answered outranks whatever she is busy with',
  );
  assert.ok(
    bearingWarns(bearingOf({asking: true})),
    'and is the one bearing that takes the warm colour',
  );

  // Offline beats everything, including a pending question. A switched-off
  // assistant is not waiting on you; she is not there.
  assert.equal(bearingOf({offline: true, asking: true, thinking: true}), 'dormant');

  // Exactly one bearing may be warm. If two were, the colour would stop
  // meaning "this one needs you" and start meaning nothing.
  const every = [
    bearingOf({offline: true}),
    bearingOf({listening: true}),
    bearingOf({thinking: true, effort: 'hard'}),
    bearingOf({thinking: true, effort: 'reflex'}),
    bearingOf({thinking: true}),
    bearingOf({speaking: true}),
    bearingOf({acting: true}),
    bearingOf({asking: true}),
  ];
  assert.equal(
    every.filter(bearingWarns).length,
    1,
    'more than one warm state means the warm colour no longer says anything',
  );
  ok('what the panel says about her is read from something, never invented');

  // The panel prints how many tools she has. Counted, never written down —
  // a hardcoded figure drifts the first time a tool is added and is then
  // quietly wrong forever, which on a panel built to be trusted is worse
  // than showing nothing.
  const shown = (await (await call('/state')).json()) as {tools: number};
  assert.equal(
    shown.tools,
    allTools().length,
    'the tool count on the panel must be the number she actually has',
  );
  assert.ok(shown.tools > 0, 'and she has some');
  ok('the tool count is counted rather than claimed');

  /*
   * An action she was told to ask about can actually be agreed to.
   *
   * It could not, before. The gate refused; the model asked; the user said
   * yes; the model called the tool again; the gate refused again. Sending and
   * spending were not gated, they were impossible — unnoticed only because no
   * tool in those categories existed yet.
   *
   * Whether a yes was said is read from the user's recorded turns, which the
   * model cannot write. That is what makes this a gate rather than a
   * suggestion.
   */
  const {setPolicy: setRule} = await import('../server/actions');
  const {record: putOnRecord} = await import('../server/memory');

  assert.equal((await setRule('research', 'always')).ok, true);
  try {
    const refused = await runTool({name: 'list_reminders', args: {}});
    assert.equal(refused.ok, false, 'an always-ask action is refused at first');
    const heldId = /confirm_action with the id "([^"]+)"/.exec(refused.result)?.[1];
    assert.ok(heldId, 'and the refusal names the receipt to confirm with');

    // Nobody has said yes. The model asking anyway gets nowhere — and keeps
    // the same receipt, so a real yes a moment later still works.
    const early = await runTool({name: 'confirm_action', args: {id: heldId}});
    assert.match(early.result, /not clearly said yes/i, 'no yes on record, no action');

    // Her own words do not count as consent, whatever they say.
    await putOnRecord('grace', 'Yes, go ahead and do it.', 'text');
    const selfServed = await runTool({name: 'confirm_action', args: {id: heldId}});
    assert.match(selfServed.result, /not clearly said yes/i, 'she cannot approve herself');

    // A hedge is not a yes.
    await putOnRecord('user', 'what would that actually do?', 'text');
    const hedged = await runTool({name: 'confirm_action', args: {id: heldId}});
    assert.match(hedged.result, /not clearly said yes/i, 'a question is not consent');

    // A plain yes, from the user, after the hold: it runs — once.
    await putOnRecord('user', 'yes please', 'text');
    const agreed = await runTool({name: 'confirm_action', args: {id: heldId}});
    assert.doesNotMatch(agreed.result, /not clearly said yes/i, 'a real yes runs it');
    assert.doesNotMatch(agreed.result, /Nothing is held/i);

    const again = await runTool({name: 'confirm_action', args: {id: heldId}});
    assert.match(again.result, /Nothing is held/i, 'and the same yes cannot run it twice');

    // A receipt the model invented is not a receipt.
    const invented = await runTool({name: 'confirm_action', args: {id: 'deadbeef'}});
    assert.match(invented.result, /Nothing is held/i);
  } finally {
    await setRule('research', 'never');
  }
  ok('an action she must ask about runs on your yes, and only on your yes');

  /*
   * Which till she is billed at.
   *
   * This is not a preference. Google's free-trial terms say the $300 credit
   * "can't pay for Gemini API in AI Studio costs" — so the key path and the
   * credit are mutually exclusive, and a half-configured Vertex silently
   * falls back to the key, spending real money while appearing to work.
   * Every one of these failures is invisible until the statement arrives.
   */
  const {serviceAccount, vertexSettings} = await import('../server/llm/vertex');
  const billing = {
    project: process.env.GCP_PROJECT_ID,
    location: process.env.GCP_LOCATION,
    json: process.env.GCP_SERVICE_ACCOUNT_JSON,
  };
  const restore = () => {
    for (const [name, value] of [
      ['GCP_PROJECT_ID', billing.project],
      ['GCP_LOCATION', billing.location],
      ['GCP_SERVICE_ACCOUNT_JSON', billing.json],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  const KEY =
    '-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJBAKj3\n-----END PRIVATE KEY-----\n';

  delete process.env.GCP_PROJECT_ID;
  delete process.env.GCP_SERVICE_ACCOUNT_JSON;
  assert.equal(vertexSettings(), null, 'no project and no key is simply the old path');

  // Half-configured must not quietly pass. A project with no credentials and
  // credentials with no project both fail identically at the network layer,
  // hours later, as a 403 that says nothing about which half is missing.
  process.env.GCP_PROJECT_ID = 'ai-agents-508818';
  assert.equal(vertexSettings(), null, 'a project with no credentials is not configured');
  delete process.env.GCP_PROJECT_ID;
  process.env.GCP_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'x@y.iam.gserviceaccount.com',
    private_key: KEY,
  });
  assert.equal(vertexSettings(), null, 'credentials with no project are not configured');

  // The commonest real failure: a dashboard stores the PEM's newlines as the
  // two characters backslash-n. The key looks perfect on screen and the
  // parser rejects it with a signature error that mentions nothing about
  // newlines.
  process.env.GCP_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'x@y.iam.gserviceaccount.com',
    private_key: KEY.replace(/\n/g, '\\n'),
  });
  assert.ok(
    serviceAccount()?.private_key.includes('\n'),
    'escaped newlines in the private key must be repaired, not passed through',
  );

  // Something that is not a service account key at all — usually an OAuth
  // client secret, which is the neighbouring button in the console.
  process.env.GCP_SERVICE_ACCOUNT_JSON = JSON.stringify({installed: {client_id: 'x'}});
  assert.equal(serviceAccount(), null, 'an OAuth client secret is not a service account');
  process.env.GCP_SERVICE_ACCOUNT_JSON = 'not json at all';
  assert.equal(serviceAccount(), null, 'unparseable credentials are refused, not thrown');

  process.env.GCP_PROJECT_ID = 'ai-agents-508818';
  process.env.GCP_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'x@y.iam.gserviceaccount.com',
    private_key: KEY,
  });
  delete process.env.GCP_LOCATION;
  const live = vertexSettings();
  assert.equal(live?.project, 'ai-agents-508818');
  assert.equal(
    live?.location,
    'global',
    'the newest Flash models are served only from global; an EU-pinned ' +
      'region answers 403 for them, indistinguishably from a missing role',
  );
  assert.ok(
    new GeminiProvider('unused', config.model).onVertex,
    'with a project and credentials she must bill through Cloud, not the key',
  );

  restore();
  assert.equal(
    new GeminiProvider('unused', config.model).onVertex,
    vertexSettings() !== null,
    'and the environment must be left exactly as it was found',
  );
  ok('she bills through the till the credits can actually pay');
  ok('no caller can think its way past the tool-calling floor');

  /*
   * Running out of steps used to look exactly like finishing.
   *
   * The tool loop simply returned when it hit its ceiling, so a genuinely
   * involved task — read the mail, check the diary, set the lights, then say
   * something about all three — ended in an empty reply. Every bit of the work
   * had happened. She just never got a turn in which to mention it, and the
   * layer above turned that silence into "I drew a blank there."
   *
   * Driven through a stand-in for Gemini itself, because this lives inside the
   * provider's loop and nothing above it can see the difference.
   */
  const rounds: {tools: boolean}[] = [];
  const relentless = new GeminiProvider('unused', config.model);
  (relentless as unknown as {client: unknown}).client = {
    models: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateContentStream: async (params: any) => {
        const hasTools = Boolean(params.config?.tools);
        rounds.push({tools: hasTools});
        return (async function* () {
          yield hasTools
            ? // A model that never stops asking for one more thing.
              {candidates: [{content: {parts: [{functionCall: {name: 'list_reminders', args: {}}}]}}]}
            : {text: 'Here is what I found.'};
        })();
      },
    },
  };

  let closingReply = '';
  for await (const piece of relentless.stream({
    system: 's',
    turns: [{role: 'user', text: 'do the whole involved thing'}],
    tools: declarations(),
    onToolCall: async () => 'done',
  })) {
    closingReply += piece;
  }

  assert.equal(
    closingReply,
    'Here is what I found.',
    'exhausting the tool rounds must still produce an answer, not silence',
  );
  assert.ok(rounds.length > 5, `she should get more than five goes, got ${rounds.length}`);
  assert.equal(
    rounds.filter((round) => !round.tools).length,
    1,
    'exactly one closing pass, with the tools taken away so she has to speak',
  );
  ok(`a task that runs past ${rounds.length - 1} steps still ends in an answer`);

  /*
   * What the model said goes back to the model unedited.
   *
   * On the 3.x line a functionCall part carries a `thoughtSignature` — an
   * opaque crumb of the model's reasoning state. Rebuilding that part from
   * the name and arguments you extracted is the obvious thing to do, works
   * perfectly on the first tool call, and makes the second one fail: "Function
   * call is missing a thought_signature in functionCall parts."
   *
   * Which means the bug cannot be caught by any test that only calls one
   * tool. This one deliberately runs two rounds.
   */
  const SIGNATURE = 'c2lnbmF0dXJl';
  const sent: unknown[][] = [];
  const careful = new GeminiProvider('unused', config.model);
  (careful as unknown as {client: unknown}).client = {
    models: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateContentStream: async (params: any) => {
        sent.push(params.contents);
        const round = sent.length;
        return (async function* () {
          yield round === 1
            ? {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {name: 'search_web', args: {query: 'x'}},
                          thoughtSignature: SIGNATURE,
                        },
                      ],
                    },
                  },
                ],
              }
            : {text: 'Found it.'};
        })();
      },
    },
  };

  let carefulReply = '';
  for await (const piece of careful.stream({
    system: 's',
    turns: [{role: 'user', text: 'look something up'}],
    tools: declarations(),
    onToolCall: async () => 'a result',
  })) {
    carefulReply += piece;
  }

  assert.equal(carefulReply, 'Found it.', 'the second round must actually happen');
  const handedBack = (sent[1] ?? []) as {role: string; parts: Record<string, unknown>[]}[];
  const modelTurn = handedBack.find((entry) => entry.role === 'model');
  assert.ok(modelTurn, 'the tool call she made must be replayed to her');
  assert.equal(
    modelTurn?.parts?.[0]?.thoughtSignature,
    SIGNATURE,
    'the thought signature must survive the round trip, or every second tool ' +
      'call is rejected with a 400',
  );
  assert.equal(
    (modelTurn?.parts?.[0]?.functionCall as {name?: string})?.name,
    'search_web',
    'and the call itself must still be there alongside it',
  );
  ok('what the model says is handed back to it unedited, signature and all');

  /*
   * Running out of *time* rather than out of steps.
   *
   * The hosting kills the request at sixty seconds and returns nothing at all
   * — no reply, no reason. Tools that talk to a light now take seconds each,
   * because they pace their commands and read them back, so eight rounds of
   * them passes that comfortably. She has to stop reaching for things while
   * there is still time to say what she managed.
   */
  const roundsRun: {tools: boolean}[] = [];
  const dawdler = new GeminiProvider('unused', config.model);
  (dawdler as unknown as {client: unknown}).client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    models: {
      generateContentStream: async (params: any) => {
        const hasTools = Boolean(params.config?.tools);
        roundsRun.push({tools: hasTools});
        return (async function* () {
          yield hasTools
            ? {candidates: [{content: {parts: [{functionCall: {name: 'list_reminders', args: {}}}]}}]}
            : {text: 'Here is as far as I got.'};
        })();
      },
    },
  };

  let hurried = '';
  for await (const piece of dawdler.stream({
    system: 's',
    turns: [{role: 'user', text: 'do a great many slow things'}],
    tools: declarations(),
    // Already past, so the second round is the one that must be refused.
    deadline: Date.now() - 1,
    onToolCall: async () => 'done',
  })) {
    hurried += piece;
  }

  assert.equal(hurried, 'Here is as far as I got.', 'she must still answer');
  assert.equal(
    roundsRun.filter((round) => round.tools).length,
    1,
    'one round of tools ran; the deadline must refuse the rest rather than all of them',
  );
  ok('running out of time ends in an answer about what she managed, not silence');

  // ---- keys pasted in rather than set in the environment ------------------
  const keysBefore = (await (await call('/keys')).json()) as {gemini: {pasted: boolean}};
  assert.equal(keysBefore.gemini.pasted, false, 'nothing pasted yet');

  const saved = await call('/keys', {
    method: 'POST',
    body: JSON.stringify({name: 'gemini', value: 'AIzaTESTKEY1234'}),
  });
  assert.equal(saved.status, 200);
  const status = (await saved.json()) as {gemini: {pasted: boolean; hint: string}};
  assert.equal(status.gemini.pasted, true);
  assert.equal(status.gemini.hint, '••••1234', 'only the tail may be shown');

  // The whole point: a key must never come back out over the wire.
  const body = JSON.stringify(await (await call('/keys')).json());
  assert.doesNotMatch(body, /AIzaTESTKEY/, 'a stored key must never be returned');
  ok('keys can be pasted in, and are never handed back');

  assert.equal(
    (await call('/keys', {method: 'POST', body: JSON.stringify({name: 'nope'})})).status,
    400,
    'an unknown key name must be refused',
  );
  await call('/keys', {method: 'POST', body: JSON.stringify({name: 'gemini', value: ''})});
  ok('unknown key names refused');

  // ---- learning that accumulates -----------------------------------------
  const {currentBeliefs, noteStyle, remember, supersedeEntry} = await import(
    '../server/memory'
  );

  await remember([{kind: 'routine', text: 'Works early mornings', source: 'inferred'}]);
  await remember([{kind: 'routine', text: 'Works early mornings', source: 'stated'}]);
  const beliefs = await currentBeliefs();
  const habit = beliefs.find((entry) => entry.text === 'Works early mornings');
  assert.equal(habit?.timesSeen, 2, 'hearing it twice must count as twice');
  assert.equal(habit?.source, 'stated', 'being told outright promotes a guess');
  assert.equal(
    beliefs.filter((entry) => entry.text === 'Works early mornings').length,
    1,
    'and must not duplicate',
  );
  ok('repeated observations reinforce rather than pile up');

  assert.equal(await supersedeEntry('Works early mornings'), true);
  assert.ok(
    !(await currentBeliefs()).some((entry) => entry.text === 'Works early mornings'),
    'superseded facts drop out of what she believes',
  );
  assert.ok(
    (await getProfile()).entries.some((entry) => entry.text === 'Works early mornings'),
    'but are kept — that they used to be true is itself a fact',
  );
  ok('contradicted facts are superseded, never deleted');

  await noteStyle(['Stops reading after two sentences']);
  await noteStyle(['Stops reading after two sentences']);
  const style = (await getProfile()).style ?? [];
  assert.equal(style[0]?.timesSeen, 2, 'style notes accumulate evidence too');
  ok('she learns how to deal with you, not only facts about you');

  // ---- spending ----------------------------------------------------------
  // A cap that only tells you afterwards is not a cap, so it is checked before
  // the request goes out. Charged from reported token usage, not guessed.
  const {
    afterwardsCap,
    creditsExpired,
    poolExpiry,
    poolSize,
    record: bill,
    requireBudget,
    spend,
    standing,
  } = await import('../server/budget');

  const startingSpend = (await spend()).dollars;
  await bill('gemini-3.8-flash', 1_000_000, 1_000_000);
  const after = await spend();
  assert.ok(after.dollars > startingSpend, 'usage must be counted');
  assert.equal(
    Math.round((after.dollars - startingSpend) * 100) / 100,
    4.5,
    'charged at the published rate for that model',
  );
  ok('spending is counted from real token usage');

  // The pool draws down, and `dollars` and `pool` are not the same number:
  // one is this month, the other is the whole credit and never resets.
  const drawn = await spend();
  assert.ok(drawn.pool > 0, 'spending on credit draws the pool down');
  const now = await standing();
  assert.equal(now.against, 'pool', 'while the credit lasts, it is what pays');
  assert.equal(
    Math.round((now.spent + now.remaining) * 100) / 100,
    poolSize(),
    'spent and remaining must account for the whole pool',
  );
  ok('the credit pool is tracked separately from the month');

  // The auto-revert is not a scheduled job that could fail to run — it is
  // simply which limit applies once the date has passed. Proven by asking
  // about a date after expiry rather than by waiting until December.
  const afterExpiry = new Date(poolExpiry().getTime() + 24 * 60 * 60 * 1000);
  assert.ok(creditsExpired(afterExpiry), 'the credit expires on its published date');
  const onCard = await standing(afterExpiry);
  // The month's `dollars` already holds credit-funded spend. On the morning
  // the credit expires that must not count against the card — or she refuses
  // to work before a cent has touched it.
  assert.ok(drawn.pool > 0, 'there is credit-funded spend this month');
  assert.equal(
    onCard.spent,
    0,
    'credit-funded spend must not be counted as money charged to the card',
  );
  assert.equal(onCard.against, 'card', 'past expiry, spending is the user\'s own money');
  assert.equal(onCard.limit, afterwardsCap(), 'and the small monthly cap takes over');
  assert.ok(
    onCard.limit < poolSize(),
    'the cap after the credit must be smaller than the credit, or it is not a revert',
  );
  ok('the cap reverts on its own the day the credit expires');

  await bill('gemini-3.8-flash', 400_000_000, 400_000_000);
  await assert.rejects(
    requireBudget(),
    /stopped rather than letting it run onto your card/,
    'past the pool, she must refuse before spending more',
  );
  ok('she stops before the credit runs onto the card');

  // ---- attention modes ---------------------------------------------------
  // These are not decoration: the mode has to reach the model, or "Focus" is
  // a button that changes a colour and nothing else.
  const focused = await call('/mode', {
    method: 'POST',
    body: JSON.stringify({mode: 'focus'}),
  });
  assert.equal(focused.status, 200);
  assert.equal(((await focused.json()) as {mode: string}).mode, 'focus');

  await chat('Still there?');
  assert.match(stub.lastSystem, /Focus mode/, 'the mode must reach the model');
  assert.match(stub.lastSystem, /Volunteer nothing/, 'and bring its guidance with it');
  ok('attention mode reaches the system prompt');

  const state = (await (await call('/state')).json()) as {
    mode: {mode: string};
    storage: {backend: string; encrypted: boolean};
  };
  assert.equal(state.mode.mode, 'focus', 'the mode must survive a reload');
  assert.equal(state.storage.encrypted, true, 'the dashboard must report the truth');
  ok('dashboard readouts come from real state, not placeholders');

  for (const rejected of ['nap', 'toString', 'constructor', '__proto__', 'valueOf']) {
    assert.equal(
      (await call('/mode', {method: 'POST', body: JSON.stringify({mode: rejected})}))
        .status,
      400,
      `"${rejected}" must be refused as a mode`,
    );
  }
  ok('unknown modes rejected, including inherited property names');

  await call('/mode', {method: 'POST', body: JSON.stringify({mode: 'open'})});

  // ---- every route must be a single path segment -------------------------
  // Vercel answers /api/a/b with a 404 that never reaches the app, while the
  // same request works perfectly on a local machine. That divergence silently
  // broke forgetting a fact and clearing the conversation in production, and
  // nothing here noticed until someone probed the deployed server by hand.
  const routes = [
    ...readFileSync('server/api.ts', 'utf8').matchAll(
      /api\.(?:get|post|put|delete|patch)\(\s*'([^']+)'/g,
    ),
  ].map((match) => match[1]);

  assert.ok(routes.length > 15, 'the route scan should have found the routes');
  const nested = routes.filter((route) => route.split('/').filter(Boolean).length > 1);
  assert.deepEqual(nested, [], `these routes are unreachable once deployed: ${nested}`);
  ok(`all ${routes.length} routes are a single segment, so Vercel can reach them`);

  // ---- she can actually do things ----------------------------------------
  const openBefore = (await outstanding()).length;
  const added = await runTool({
    name: 'add_reminder',
    args: {text: 'ring the dentist', due: '2026-08-01T09:00:00Z'},
  });
  assert.ok(added.ok, `adding a reminder should work: ${added.result}`);
  assert.equal((await outstanding()).length, openBefore + 1, 'and should persist');
  ok('tools run and their effects last');

  const listed = await runTool({name: 'list_reminders', args: {}});
  assert.match(listed.result, /dentist/, 'the list should come back');

  const finished = await runTool({
    name: 'complete_reminder',
    args: {text: 'dentist'},
  });
  assert.ok(finished.ok);
  assert.equal(
    (await outstanding()).length,
    openBefore,
    'completing should take it off the outstanding list',
  );
  assert.equal(
    (await allReminders()).length,
    openBefore + 1,
    'but must not delete it — nothing is ever destroyed',
  );
  ok('completed items are marked, never deleted');

  const missing = await runTool({name: 'add_reminder', args: {}});
  assert.equal(missing.ok, false, 'a call with no text must not silently succeed');
  const unknown = await runTool({name: 'launch_missiles', args: {}});
  assert.equal(unknown.ok, false, 'an invented tool must not run');
  ok('malformed and invented tool calls refused');

  // The two hard limits, proved about the tool list itself rather than about
  // any particular call: there is no tool that sends, spends, or destroys, so
  // there is nothing to be talked past.
  assert.deepEqual(auditTools(), [], 'no tool may send, spend, or destroy');
  ok('no tool exists that could send, spend, or destroy anything');

  // ---- everything she does is on the record ------------------------------
  const deeds = await recentDeeds(50);
  assert.ok(
    deeds.some((deed) => /added to the list/i.test(deed.text)),
    'adding a reminder should appear in the journal',
  );
  assert.equal(deeds[0].at >= deeds[deeds.length - 1].at, true, 'newest first');
  ok('every action she takes lands in a record the user can read');

  // ---- the PlayStation, and the limit of it ------------------------------
  const console_ = allTools().find((tool) => tool.name === 'check_playstation');
  assert.ok(console_, 'she should be able to look at the console');
  assert.equal(console_.category, 'home');
  // Read-only is not a matter of intent here: there is no write to be had.
  // What matters is that she says so rather than implying she pressed
  // something, and that a missing credential is an explanation, not a crash.
  const looked = await runTool({name: 'check_playstation', args: {}});
  assert.ok(looked.ok, 'a missing PlayStation token must not throw');
  assert.match(
    looked.result,
    /not connected|paste/i,
    'with no token she must say it is not connected',
  );
  ok('she can look at the PlayStation, and says so when it is not connected');

  // ---- an audition is heard in the voice being auditioned ------------------
  // The override was once applied with a pattern that no longer matched the
  // file: the edit silently changed nothing, shipped, and every audition
  // played in the current voice. The resolution order is now a bare function
  // precisely so this can be proved without a network.
  const {voiceFor} = await import('../server/llm/gemini');
  assert.equal(
    voiceFor({text: 'sample', voice: 'Aoede'}),
    'Aoede',
    'a sample must come out in the voice being auditioned',
  );
  assert.ok(
    voiceFor({text: 'sample'}).length > 0,
    'and with no override she still has a voice to fall back to',
  );
  ok('auditioning a voice is heard in that voice, not the current one');

  // ---- filler words never hide a page or a situation -----------------------
  // "my Berlin" is asking for Berlin; "the govee order" should settle
  // "Govee order EU641959". Both once returned nothing, because the asked-side
  // filler was never dropped before the whole-word check.
  await runTool({name: 'write_note', args: {title: 'Berlin trip', text: 'Packing list started'}});
  const askedWithMy = await runTool({name: 'read_note', args: {title: 'my Berlin'}});
  assert.match(askedWithMy.result, /Packing list/, '"my Berlin" finds the Berlin trip');

  await runTool({
    name: 'track_situation',
    args: {title: 'Govee order EU641959', update: 'Shipped from the EU warehouse.'},
  });
  const settledLoose = await runTool({
    name: 'resolve_situation',
    args: {title: 'the govee order'},
  });
  assert.match(settledLoose.result, /resolved/i, '"the govee order" settles it');
  ok('filler words never hide a note or keep a situation open');

  // ---- a near-miss title is a new page, never a wrong merge ----------------
  // Substring matching used to file "Oscar plans" into a note called "car",
  // because "oscar" contains "car" — and a wrong merge is invisible in a way
  // a second question is not. Exact titles only, for notes and situations.
  await runTool({name: 'write_note', args: {title: 'car', text: 'MOT booked'}});
  await runTool({name: 'write_note', args: {title: 'Oscar plans', text: 'dinner Friday'}});
  const {liveNotes: liveN} = await import('../server/notes');
  const titles = (await liveN()).map((note) => note.title);
  assert.ok(
    titles.includes('car') && titles.includes('Oscar plans'),
    `"Oscar plans" must be its own note, not merged into "car" — got ${titles.join(', ')}`,
  );

  await runTool({name: 'track_situation', args: {title: 'PS5', update: 'bought'}});
  await runTool({name: 'track_situation', args: {title: 'PS5 bridge', update: 'pairing'}});
  const {allSituations: allBySub} = await import('../server/situations');
  const sitTitles = (await allBySub()).map((one) => one.title);
  assert.ok(
    sitTitles.includes('PS5') && sitTitles.includes('PS5 bridge'),
    `"PS5 bridge" must be its own situation — got ${sitTitles.join(', ')}`,
  );
  // Left open they would leak into the "Nothing open" assertion below; a test
  // that dirties shared state is a test of nothing.
  await runTool({name: 'resolve_situation', args: {title: 'PS5'}});
  await runTool({name: 'resolve_situation', args: {title: 'PS5 bridge'}});
  ok('near-miss titles start their own note and situation, never a wrong merge');

  // ---- notes, situations, timers, watches ----------------------------------
  // The keeping tools: everything appends or files; nothing destroys.
  const noted = await runTool({
    name: 'write_note',
    args: {title: 'Berlin trip', text: 'Flights are booked for March.'},
  });
  assert.match(noted.result, /Berlin trip/);
  await runTool({
    name: 'write_note',
    args: {title: 'berlin trip', text: 'Hotel shortlist is down to two.'},
  });
  const readBack = await runTool({name: 'read_note', args: {title: 'Berlin'}});
  assert.match(readBack.result, /Flights are booked/, 'first entry kept');
  assert.match(readBack.result, /Hotel shortlist/, 'and the second appended');
  const wrongNote = await runTool({name: 'read_note', args: {title: 'Mars base'}});
  assert.match(wrongNote.result, /No note called that/);
  ok('a note is one page per topic, appended to, matched loosely by title');

  await runTool({
    name: 'track_situation',
    args: {title: 'the deposit dispute', update: 'Letter sent to the landlord.'},
  });
  await runTool({
    name: 'track_situation',
    args: {title: 'deposit dispute', update: 'They replied offering half.'},
  });
  const open_ = await runTool({name: 'list_situations', args: {}});
  assert.match(open_.result, /offering half/, 'the latest development is the status');
  const settled = await runTool({
    name: 'resolve_situation',
    args: {title: 'deposit'},
  });
  assert.match(settled.result, /resolved/i);
  assert.match(
    (await runTool({name: 'list_situations', args: {}})).result,
    /Nothing open/,
    'resolved means off the open list',
  );
  const {allSituations: allSit} = await import('../server/situations');
  const depositFiled = (await allSit()).find((one) => /deposit/.test(one.title));
  assert.ok(depositFiled, 'but filed, never deleted');
  assert.equal(depositFiled.status, 'resolved');
  ok('a situation carries its history, resolves, and is never destroyed');

  const timed = await runTool({
    name: 'set_timer',
    args: {duration: '20 minutes', label: 'pasta'},
  });
  assert.match(timed.result, /pasta, 20 minutes/);
  assert.equal(parseDuration('1h30m'), 90 * 60_000);
  assert.equal(parseDuration('90 seconds'), 90_000);
  assert.equal(parseDuration('20'), 20 * 60_000, 'a bare number means minutes');
  assert.equal(parseDuration('yesterday'), null);
  const ticking = (await (await call('/timers')).json()) as {timers: {id: string}[]};
  assert.equal(ticking.timers.length, 1, 'the client can see it to ring it');
  await call('/timer-fired', {
    method: 'POST',
    body: JSON.stringify({id: ticking.timers[0].id}),
  });
  assert.equal(
    ((await (await call('/timers')).json()) as {timers: unknown[]}).timers.length,
    0,
    'and a fired timer never rings twice',
  );
  ok('timers parse spoken durations, surface to the client, and fire once');

  const badWatch = await runTool({
    name: 'start_watch',
    args: {what: 'nothing', url: 'not-a-url'},
  });
  assert.equal(badWatch.ok, false, 'a watch without a real address is refused');
  await runTool({
    name: 'start_watch',
    args: {what: 'the restock', url: 'https://example.com/x', keyword: 'in stock'},
  });
  assert.match(
    (await runTool({name: 'list_watches', args: {}})).result,
    /the restock.*in stock/,
  );
  const stopped = await runTool({name: 'stop_watch', args: {what: 'restock'}});
  assert.match(stopped.result, /Stopped/);
  ok('watches want a keyword, list honestly, and stop by filing');

  // Read-only integrations degrade to a sentence, not a stack trace.
  const noGithub = await runTool({name: 'check_github', args: {}});
  assert.match(noGithub.result, /not connected/i);
  const noN8n = await runTool({name: 'check_workflows', args: {}});
  assert.match(noN8n.result, /not connected/i);
  ok('github and n8n say what is missing rather than guessing');

  // ---- billing: cached tokens cost a quarter, and nothing double-counts -----
  // The meter-once fix lives in the real provider, which the stub can't
  // exercise; the cost maths it feeds, though, is exact and worth pinning.
  const spent0 = (await readSpend()).dollars;
  await bill('gemini-2.5-flash', 1_000_000, 0, 0);
  const full = (await readSpend()).dollars - spent0;
  await bill('gemini-2.5-flash', 1_000_000, 0, 1_000_000);
  const cached = (await readSpend()).dollars - spent0 - full;
  assert.ok(Math.abs(full - 0.3) < 1e-6, 'a million fresh input tokens is thirty cents');
  assert.ok(
    Math.abs(cached - 0.075) < 1e-6,
    'the same million served from cache is a quarter of that',
  );
  ok('cached input is billed at a quarter, and usage is counted once');

  // ---- correcting and editing what she keeps -------------------------------
  // The user's hand on her memory: supersede a fact without deleting it, and
  // fix a note she wrote.
  await runTool({
    name: 'write_note',
    args: {title: 'Flat', text: 'Landlord is fixing the boiler.'},
  });
  const notesNow = (await (await call('/notes')).json()) as {
    notes: {id: string; title: string; body: string}[];
  };
  assert.ok(notesNow.notes.length >= 1, 'the note is visible to the interface');
  const edited = (await (
    await call('/note-save', {
      method: 'POST',
      body: JSON.stringify({
        id: notesNow.notes[0].id,
        title: notesNow.notes[0].title,
        body: 'Corrected by the user.',
      }),
    })
  ).json()) as {notes: {body: string}[]};
  assert.match(edited.notes[0].body, /Corrected by the user/, 'the user can fix a note');
  ok('notes are visible and the user can correct what she wrote');

  // Files: text kept, searchable, listed without the body, and capped.
  await call('/file-add', {
    method: 'POST',
    body: JSON.stringify({name: 'lease.txt', text: 'The notice period is two months.'}),
  });
  const filed = (await (await call('/files')).json()) as {
    files: {name: string; chars: number}[];
  };
  assert.ok(filed.files.some((f) => f.name === 'lease.txt'), 'the file is kept');
  assert.ok(
    !JSON.stringify(filed.files).includes('notice period'),
    'but the list never ships the body back',
  );
  const found = await runTool({name: 'search_files', args: {about: 'notice period'}});
  assert.match(found.result, /two months/, 'and she can search the text');
  const emptyAdd = await call('/file-add', {
    method: 'POST',
    body: JSON.stringify({name: 'blank.txt', text: '   '}),
  });
  assert.equal(emptyAdd.status, 400, 'an empty document is refused, not stored');
  ok('documents are kept as text, searchable, and never handed back wholesale');

  const weather = (await (await call('/weather')).json()) as {line: string | null};
  assert.equal(weather.line, null, 'no location fact means no invented forecast');
  ok('weather stays silent rather than guess a city it was never given');

  // ---- the rooms of the app ------------------------------------------------
  // A workspace is data rather than code, which is the whole reason the user
  // can add one without waiting for a deploy. Everything below is about it
  // staying data: found by name however it was said, saved, and hidden rather
  // than destroyed.
  const rooms = (await (await call('/workspaces')).json()) as {
    workspaces: {id: string; name: string; opens: string[]}[];
  };
  assert.ok(
    rooms.workspaces.some((one) => one.id === 'work'),
    'the default rooms should be there on a fresh install',
  );

  const switched = await runTool({name: 'open_workspace', args: {name: 'work mode'}});
  assert.ok(switched.ok);
  assert.match(switched.result, /Work/, 'a loosely spoken name should still land');

  const nowhere = await runTool({name: 'open_workspace', args: {name: 'atlantis'}});
  assert.match(nowhere.result, /no workspace by that name/i);

  // A bare word is a domain guess, which is what makes "open youtube" work.
  const opened = await runTool({name: 'open_pages', args: {urls: 'youtube'}});
  assert.match(opened.result, /youtube\.com/, 'a bare name should become an address');
  const nonsense = await runTool({name: 'open_pages', args: {urls: '!!!'}});
  assert.match(nonsense.result, /did not look like an address/i);

  const madeRoom = (await (
    await call('/workspace-save', {
      method: 'POST',
      body: JSON.stringify({
        id: 'study',
        name: 'Study',
        icon: 'sparkles',
        accent: 'rose',
        opens: ['https://example.com', 'not-a-url'],
        panels: ['needs'],
      }),
    })
  ).json()) as {workspaces: {id: string; opens: string[]}[]};

  const study = madeRoom.workspaces.find((one) => one.id === 'study');
  assert.ok(study, 'a room the user made should be saved');
  assert.deepEqual(
    study.opens,
    ['https://example.com'],
    'and anything that is not an address should be dropped rather than stored',
  );

  const hidden = (await (
    await call('/workspace-hide', {method: 'POST', body: JSON.stringify({id: 'study'})})
  ).json()) as {workspaces: {id: string}[]};
  assert.ok(
    !hidden.workspaces.some((one) => one.id === 'study'),
    'hiding should take it out of the rail',
  );
  const stillThere = (await (
    await call('/workspace-save', {
      method: 'POST',
      body: JSON.stringify({id: 'study', name: 'Study', panels: []}),
    })
  ).json()) as {workspaces: {id: string}[]};
  assert.ok(
    stillThere.workspaces.some((one) => one.id === 'study'),
    'and it must come back, because nothing here is ever destroyed',
  );
  ok('rooms are data: found by name, made by the user, hidden but never deleted');

  // ---- she says something when you walk in, but not every time -------------
  const hello = (await (await call('/greeting', {method: 'POST'})).json()) as {
    say: string | null;
  };
  assert.ok(hello.say, 'she should have something to say on the first open');
  const secondHello = (await (await call('/greeting', {method: 'POST'})).json()) as {
    say: string | null;
  };
  assert.equal(
    secondHello.say,
    null,
    'and nothing on the next — three greetings while you find the right tab is worse than none',
  );
  ok('she greets you when you walk in, and not again for hours');

  // ---- she can ask, with the answers laid out ------------------------------
  stub.nextToolCall = {
    name: 'ask_choice',
    args: {question: 'Tuesday or Thursday?', choices: 'Tuesday — sooner | Thursday'},
  };
  const question = await chat('Book the inspection.');
  const put = question.find((event) => event.type === 'asked');
  assert.ok(put && put.type === 'asked', 'the question should reach the interface');
  assert.equal(put.question, 'Tuesday or Thursday?');
  // Note the second has no detail at all rather than an empty one: it travels
  // as JSON, and an absent key is what arrives.
  assert.deepEqual(put.choices, [
    {label: 'Tuesday', detail: 'sooner'},
    {label: 'Thursday'},
  ]);

  // One button is not a choice, and must not render as though it were.
  const tooFew = await runTool({
    name: 'ask_choice',
    args: {question: 'Shall I?', choices: 'Yes'},
  });
  assert.match(tooFew.result, /at least two/i);
  ok('she can put a question on screen with the answers as buttons');

  // ---- what an action looks like on screen --------------------------------
  // The provider hands onToolUsed whatever onToolCall returned — the raw
  // result — so however carefully the tool layer worded its short summary, the
  // interface showed the wall of text instead. Checking the mail printed the
  // whole inbox under her reply, twice over, including the guidance meant only
  // for her. Asserted end to end, through the same seam that leaked.
  for (let index = 0; index < 12; index += 1) {
    await runTool({name: 'add_reminder', args: {text: `something to do ${index}`}});
  }
  const bulky = await runTool({name: 'list_reminders', args: {}});
  assert.ok(bulky.result.length > 200, 'the raw result should be genuinely long');

  stub.nextToolCall = {name: 'list_reminders', args: {}};
  const withAction = await chat('What is on my list?');
  const acted = withAction.find((event) => event.type === 'acted');
  assert.ok(acted && acted.type === 'acted', 'the action should reach the interface');
  assert.ok(
    acted.summary.length < 70 && !acted.summary.includes('\n'),
    `what is shown must be one short line, got ${acted.summary.length} characters`,
  );
  assert.ok(
    !acted.summary.includes('something to do'),
    'and must not be the tool output itself',
  );
  ok('an action reaches the screen as a short line, not the tool’s output');

  // ---- tool output is working material, not something to read out ---------
  // She was handed the inbox — senders, subjects and a preview of each — and
  // read the whole thing back, so asking her to check the mail buried her
  // answer under other people's marketing. The rule against it is structural
  // enough to be worth asserting.
  await chat('Check my mail.');
  assert.match(
    stub.lastSystem,
    /Never reproduce a list a tool handed you/,
    'she must be told that tool output is for her to read, not to pass on',
  );
  ok('she is told to report what a tool found, not to recite it');

  // ---- her voice does not stop mid-word -----------------------------------
  // A long answer used to be packed into batches that could overshoot what the
  // speech route accepts, and the route cut the overflow without a word. The
  // only symptom was her trailing off, which no test could see.
  const longWinded =
    'She had a great deal to say about it. '.repeat(60) +
    `And then one sentence with no full stop in it at all that simply keeps ${'going on '.repeat(200)}`;

  const pieces = chunkForSpeech(longWinded);
  assert.ok(pieces.length > 1, 'a long answer should be broken up');
  for (const piece of pieces) {
    assert.ok(
      piece.length <= CHUNK_TARGET,
      `every piece must fit what the route accepts, got ${piece.length}`,
    );
  }

  // Nothing may be dropped. Whitespace is renormalised, the words are not.
  const words = (text: string) => text.split(/\s+/).filter(Boolean);
  assert.deepEqual(
    words(pieces.join(' ')),
    words(longWinded),
    'every word must come out the other side — this is the whole point',
  );
  ok('a long reply is split without losing a word, and never cut mid-sentence');

  // ---- what the interface shows about an action ---------------------------
  // Checking the mail hands the model every subject line in the inbox. Showing
  // that to the user buried her actual reply under other people's email.
  const inbox = await runTool({name: 'check_mail', args: {}});
  assert.ok(
    inbox.summary.length < 70,
    `what the user sees must stay short, got ${inbox.summary.length} characters`,
  );
  assert.ok(
    !inbox.summary.includes('\n'),
    'and must be one line, not a list pasted under her reply',
  );
  ok('an action shows as a short line, not the tool’s whole output');

  // ---- the laptop bridge --------------------------------------------------
  // Grace hands out the bridge program herself, so getting it onto a locked-
  // down laptop needs no git, no installer and no administrator. That copy
  // has to be the same program, or she is serving something that has quietly
  // stopped matching what is tested here.
  assert.equal(
    readFileSync('public/bridge.mjs', 'utf8'),
    readFileSync('bridge/bridge.mjs', 'utf8'),
    'the downloadable bridge has drifted from the real one — run npm run sync:bridge',
  );
  ok('the bridge she hands out is the same program that is tested');

  // The bridge now opens pages on the laptop's own screen, which makes what it
  // will accept an address a security question rather than a tidiness one:
  // file:// reaches local documents and the shell schemes start programs.
  const bridgeCode = readFileSync('bridge/bridge.mjs', 'utf8');
  assert.match(
    bridgeCode,
    /protocol !== 'http:' && address\.protocol !== 'https:'/,
    'the bridge must open web addresses and nothing else',
  );
  /*
   * There is exactly one shell on that machine, and it is the one that was
   * asked for.
   *
   * This used to forbid shells outright, which was right when the bridge only
   * opened web pages: an address composed by a model and handed to a shell is
   * an injection waiting to happen. The user has since asked for a terminal,
   * so a blanket ban is no longer the rule — but the reasoning behind it is
   * unchanged for everything else. Counting is what keeps both true. One is
   * `run_command`, deliberate and gated; two means something else grew a
   * shell quietly, which is precisely how the old class of bug returns.
   */
  const shells = bridgeCode.match(/shell: true/g) ?? [];
  assert.equal(
    shells.length,
    1,
    'only the terminal may use a shell — anything else must not have grown one',
  );
  assert.match(
    bridgeCode,
    /async function runCommand[\s\S]{0,600}shell: true/,
    'and the one shell must be the terminal, not something that drifted into one',
  );
  assert.doesNotMatch(
    bridgeCode,
    // Quoted, so the comment explaining why cmd is avoided does not itself
    // fail the check that cmd is avoided.
    /['"]cmd\.exe['"]/,
    'opening a page must never go via cmd',
  );
  ok('the bridge opens web addresses without a shell, and has exactly one terminal');

  // The boundary on the machine is the thing standing between a sentence and
  // somebody's home directory, so it is proved against a real filesystem —
  // real symlinks, real `..`, real absolute paths — rather than by reading it.
  //
  // Spawned rather than run inline, and asynchronously rather than with
  // spawnSync: this suite is serving its own HTTP server on this same event
  // loop, and blocking it for the couple of seconds those checks take drops
  // the connections underneath it. The failure that produced was an
  // ECONNRESET a thousand lines later, which is a genuinely horrible thing to
  // debug and entirely self-inflicted.
  const boundary = await new Promise<{code: number; out: string}>((settle) => {
    const child = spawn('node', ['bridge/check.mjs']);
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => settle({code: code ?? 1, out}));
  });
  assert.equal(boundary.code, 0, `the bridge's own boundary checks failed:\n${boundary.out}`);
  assert.match(boundary.out, /16 checks passed/, 'and all of them ran');
  ok('paths outside the allowed folders are refused on the machine itself');

  // ---- she keeps listening while you are reading something else ----------
  // The detection loop ran on requestAnimationFrame, which every browser stops
  // for a tab nobody is looking at — so she went deaf the moment another site
  // was opened and could hear again the instant you came back. An AudioWorklet
  // is driven by the soundcard and does not know whether anyone is watching.
  const ambient = readFileSync('src/voice/useAmbient.ts', 'utf8');
  assert.match(ambient, /audioWorklet\.addModule/, 'listening must run on the audio thread');
  assert.match(
    ambient,
    /registerProcessor\('grace-ears'/,
    'the worklet itself has to be there, not merely referenced',
  );
  // The worklet is only pulled if it reaches the destination; unconnected, its
  // process() is never called and she is silently deaf everywhere.
  assert.match(ambient, /silent\.connect\(context\.destination\)/);
  // The frame clock still exists and must stay strictly a fallback. Two ways
  // to reach it now, and both are failures: the worklet refusing to load, and
  // the worklet loading but never being called — which is silent, and is
  // exactly how she ended up hearing nothing at all while appearing to listen.
  assert.equal(ambient.split('const watchOnScreen').length - 1, 1);
  assert.equal(
    ambient.split('watchOnScreen();').length - 1,
    2,
    'the frame clock is reached only from the two failure paths',
  );
  assert.ok(
    ambient.indexOf('audioWorklet.addModule') < ambient.indexOf('watchOnScreen()'),
    'the worklet is tried first; the frame clock only when it fails',
  );
  // The watchdog is the whole point of the second path, so it is asserted
  // rather than left to survive at the mercy of a future tidy-up.
  assert.match(
    ambient,
    /if \(!runningRef\.current \|\| heardSomething\) return;/,
    'a worklet that loads and then never runs must still be caught',
  );
  // Calibration has to start from the first reading. Started from the clock,
  // a slow worklet load consumed the whole window and left the room floor at
  // zero, with no way back because the window had passed.
  assert.match(ambient, /if \(openedAt === 0\) \{\s*\n\s*openedAt = now;/);
  // And the floor has to keep tracking the room rather than being fixed by
  // whatever happened during the first six hundred milliseconds.
  assert.match(ambient, /floor = rms < floor \? floor \* 0\.9/);
  assert.match(
    ambient,
    /if \(!collected\) \{/,
    'the floor must not be learned from someone talking',
  );
  ok('listening falls back rather than failing silently, and calibrates late');

  // ---- she should not pause at every full stop ---------------------------
  // The speech model pads the end of every clip with silence. One clip, nobody
  // notices; a reply is three or four clips, so it is three or four pauses,
  // each landing exactly on a full stop — which a listener hears as her
  // hesitating rather than as an encoder finishing up.
  const wavOf = (frames: number[]) => {
    const bytes = new Uint8Array(44 + frames.length * 2);
    const view = new DataView(bytes.buffer);
    const put = (at: number, text: string) => {
      for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
    };
    put(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 24_000, true);
    view.setUint32(28, 48_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    put(36, 'data');
    view.setUint32(40, frames.length * 2, true);
    frames.forEach((value, i) => view.setInt16(44 + i * 2, value, true));
    return bytes;
  };

  // Half a second of speech, then a full second of the encoder's padding.
  const speech = Array.from({length: 12_000}, (_, i) => Math.round(8000 * Math.sin(i / 4)));
  const padded = wavOf([...speech, ...new Array(24_000).fill(0)]);
  const tightened = trimTrailingSilence(padded);

  assert.ok(tightened.byteLength < padded.byteLength, 'the padding should come off');
  assert.ok(
    tightened.byteLength > 44 + speech.length * 2,
    'and the words themselves must survive it',
  );

  // The two length fields a player actually reads. Left stale, every player
  // either reads past the end of the file or refuses it outright — which is
  // why this is trimmed by arithmetic and asserted rather than eyeballed.
  const check = new DataView(
    tightened.buffer,
    tightened.byteOffset,
    tightened.byteLength,
  );
  assert.equal(check.getUint32(4, true), tightened.byteLength - 8, 'RIFF size');
  assert.equal(check.getUint32(40, true), tightened.byteLength - 44, 'data size');

  // Anything it does not fully understand comes back untouched, because the
  // cost of guessing here is a file that will not play at all.
  assert.equal(trimTrailingSilence(wavOf(new Array(2000).fill(0))).byteLength,
    wavOf(new Array(2000).fill(0)).byteLength, 'silence throughout is left alone');
  const garbage = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(trimTrailingSilence(garbage), garbage, 'a non-WAV is left alone');
  ok('trailing silence is cut from her speech, and only when it is understood');

  // ---- did somebody say her name -----------------------------------------
  // Nothing here ever sees the word "Grace". It sees a transcriber's guess at
  // a word, from a second of speech in a room, from someone who may have an
  // accent and may be across it. The old test was a literal match against four
  // spellings, and everything else was silently not-for-her — which from the
  // other side of the room looks exactly like being heard and ignored.
  for (const said of [
    'Grace, what time is it',
    'grace whats on today',
    'sorry Grace, one more thing',
    'Gracie turn the lights off',
    'greys put the kettle on',
    'Race, what is the weather',
    'okay grays lights out',
    'Grease, open my mail',
  ]) {
    assert.equal(heardName(said).called, true, `"${said}" should reach her`);
  }

  // And the words that must not, because they turn up in ordinary speech and
  // waking on them would be worse than missing one call.
  for (const said of [
    'that was a great idea',
    'the grade came back',
    'brace yourself',
    'leave a space there',
    'trace it back to Tuesday',
  ]) {
    assert.equal(heardName(said).called, false, `"${said}" must not wake her`);
  }

  // Her name comes out of the request, and takes its punctuation with it —
  // a request that begins ", what time is it" reads to the model as a
  // transcription fault and gets remarked upon instead of answered.
  assert.equal(heardName('Grace, what time is it').request, 'what time is it');
  assert.equal(heardName('sorry Grace, one more thing').request, 'sorry one more thing');
  assert.equal(heardName('Grace').request, '', 'her name alone is not a request');
  assert.equal(heardName('Grace!').request, '');
  ok('her name is recognised however it was transcribed, and only her name');

  // Being told to leave it. Decided here rather than by the model, because
  // "go to sleep" followed by a thoughtful paragraph about going to sleep is a
  // joke at her expense, and it has to work at the moment something has gone
  // wrong — which is when a round trip is the least dependable thing there is.
  for (const said of [
    'go to sleep',
    'goodnight',
    'stop listening',
    "that's all",
    'be quiet',
    'stand down',
  ]) {
    assert.equal(toldToSleep(said), true, `"${said}" should send her to sleep`);
  }
  // "Sleep" alone is deliberately not enough: going silent when someone was
  // making conversation is worse than missing one phrasing of the instruction.
  for (const said of [
    'did you sleep well',
    'set a sleep timer for twenty minutes',
    'what time did I go to sleep last night',
    'all of the lights',
  ]) {
    assert.equal(toldToSleep(said), false, `"${said}" must not silence her`);
  }
  ok('she can be told to leave it, and only when she was actually told');

  // ---- what a transcriber says when it was given nothing -----------------
  // Every speech model trained on captioned video does this: handed a second
  // of room tone it does not answer "nothing", it answers with whatever phrase
  // most often accompanied silence in its training data, confidently. Which is
  // why they are so oddly specific — they are the end-credits of a million
  // videos, and "I created" was arriving from an empty room.
  for (const phantom of [
    'I created',
    'Thank you.',
    'Thanks for watching!',
    'you',
    'Subtitles by the Amara.org community',
    '  ',
    'Okay.',
  ]) {
    assert.equal(isPhantom(phantom), true, `"${phantom}" is the model filling a gap`);
  }

  // The whole point is that this must not deafen her to real speech. Anything
  // longer than a few words is real regardless, and a phantom phrase inside a
  // real sentence is real too.
  for (const real of [
    'thank you for sorting that out',
    'okay do it',
    'you were right about the invoice',
    'I created a new workflow yesterday, remind me to check it',
    'lights off',
  ]) {
    assert.equal(isPhantom(real), false, `"${real}" is somebody talking`);
  }
  ok('a transcriber inventing words into a silence is caught, and speech is not');

  // ---- typed commands ----------------------------------------------------
  // A slash counts only in front of a name she has. Someone typing a path, a
  // fraction or a date is not issuing an instruction, and treating "/usr/bin"
  // as a failed command rather than a message is the kind of cleverness that
  // makes an input box feel hostile.
  assert.deepEqual(parseCommand('/compact'), {name: 'compact', rest: ''});
  assert.deepEqual(parseCommand('/research is the M4 worth it'), {
    name: 'research',
    rest: 'is the M4 worth it',
  });
  for (const typed of ['/usr/local/bin', '1/2 of the way', '/nonsense', 'compact', '']) {
    assert.equal(parseCommand(typed), null, `"${typed}" is not a command`);
  }
  // The menu narrows as you type and vanishes once there is an argument,
  // because by then you know what you are doing.
  assert.ok(suggest('/').length >= 5);
  assert.deepEqual(
    suggest('/re').map((one) => one.name),
    ['research'],
  );
  assert.deepEqual(suggest('/research something'), []);
  ok('typed commands are recognised, and only when they were typed');

  // ---- more than one conversation ----------------------------------------
  // The riskiest change in a while: the message log went from one document to
  // one per conversation. The first conversation deliberately keeps the keys
  // the single one always used, so there is no migration step and no moment
  // where a running install has to be upgraded — an existing log simply *is*
  // the first chat. If that ever stops being true, a week of conversation
  // becomes unreachable, which is why it is asserted rather than assumed.
  assert.equal(logKey('main'), 'conversation');
  assert.equal(metaKey('main'), 'meta');
  assert.notEqual(logKey('abc123'), 'conversation');

  const wasHolding = (await getMessages()).length;
  assert.ok(wasHolding > 0, 'there should be a conversation to carry over');

  const started = await call('/chat-new', {method: 'POST'});
  const madeChat = (await started.json()) as {current: string; chats: {id: string}[]};
  assert.notEqual(madeChat.current, 'main', 'a new conversation is a new one');
  assert.equal((await getMessages()).length, 0, 'and it starts empty');

  // Everything she knows about the user is deliberately *not* split. An
  // assistant who forgot your name because you opened a new conversation
  // would be worse than the one that could only hold a single thread.
  assert.ok(
    (await getProfile()).entries.length > 0,
    'what she knows about you follows you between conversations',
  );

  await call('/chat-open', {method: 'POST', body: JSON.stringify({id: 'main'})});
  assert.equal(
    (await getMessages()).length,
    wasHolding,
    'and going back finds the first one exactly as it was',
  );

  // Put away, never removed — this is the record of everything either of you
  // said, and the standing instruction applies here more than anywhere.
  await call('/chat-archive', {
    method: 'POST',
    body: JSON.stringify({id: madeChat.current}),
  });
  const chatList = (await (await call('/chats')).json()) as {chats: {id: string}[]};
  assert.ok(
    !chatList.chats.some((chat) => chat.id === madeChat.current),
    'an archived conversation leaves the list',
  );
  assert.equal(
    (await new Document<unknown[]>(logKey(madeChat.current), () => []).read()).length,
    0,
    'and its messages are left exactly where they were',
  );

  // The first one cannot be put away, because something has to be current.
  await call('/chat-archive', {method: 'POST', body: JSON.stringify({id: 'main'})});
  assert.ok(
    ((await (await call('/chats')).json()) as {chats: {id: string}[]}).chats.some(
      (chat) => chat.id === 'main',
    ),
    'the first conversation stays, or there is nothing to be in',
  );
  ok('conversations are separate, the first is preserved, and none are removed');

  // ---- she can be put on a phone -----------------------------------------
  // Every one of these is refused *silently* by a browser when it is wrong:
  // no prompt, no warning, nothing in the console. Which makes them precisely
  // the things worth asserting rather than eyeballing once and forgetting.
  const manifest = JSON.parse(
    readFileSync('public/manifest.webmanifest', 'utf8'),
  ) as {
    display: string;
    start_url: string;
    icons: {src: string; sizes: string; purpose: string; type: string}[];
  };

  assert.equal(manifest.display, 'standalone', 'or it opens as a browser tab');
  assert.equal(manifest.start_url, '/');

  // A PNG at each of the two sizes every platform agrees on, and a maskable
  // one so Android does not crop her into a shape with a corner missing.
  for (const wanted of ['192x192', '512x512']) {
    assert.ok(
      manifest.icons.some(
        (icon) => icon.sizes === wanted && icon.type === 'image/png',
      ),
      `a ${wanted} PNG icon is required for the install prompt`,
    );
  }
  assert.ok(
    manifest.icons.some((icon) => icon.purpose === 'maskable'),
    'a maskable icon, or Android crops the artwork',
  );

  for (const icon of manifest.icons) {
    assert.ok(existsSync(`public${icon.src}`), `${icon.src} is declared but missing`);
  }
  // Declared as PNG and actually PNG. A mislabelled file is accepted by the
  // manifest parser and rejected by the icon loader, silently.
  for (const png of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    const bytes = readFileSync(`public/${png}`);
    assert.deepEqual(
      [...bytes.subarray(0, 4)],
      [0x89, 0x50, 0x4e, 0x47],
      `${png} is not a PNG`,
    );
  }

  // The worker has to exist and has to have a fetch handler, or the browser
  // will not offer to install her — and will not say why.
  const worker = readFileSync('public/sw.js', 'utf8');
  assert.match(worker, /addEventListener\('fetch'/, 'no fetch handler, no install');
  assert.doesNotMatch(
    // A call, not the word — the comment explaining why there is no call
    // would otherwise fail the check that there is no call.
    worker,
    /\.respondWith\(/,
    'she must never serve a cached copy of herself',
  );
  // Registered on load rather than by the notifications panel, which is what
  // made her uninstallable until you went looking for an unrelated setting.
  assert.match(readFileSync('src/main.tsx', 'utf8'), /serviceWorker\.register/);
  ok('she is installable on a phone, and every silent requirement is met');
  ok('listening runs on the audio thread, so a hidden tab still hears');

  // This is the only route that anything on the open internet can reach
  // without the password, so what it refuses matters more than what it does.
  const refused = await fetch(`${base}/bridge`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: 'not-the-token', state: null}),
  });
  assert.equal(refused.status, 401, 'a wrong token must get nowhere');
  assert.equal(
    ((await refused.json()) as {error: string}).error,
    'no',
    'and must not be told anything about why',
  );
  ok('the bridge route refuses anything without the right token');

  const token = (
    (await (await call('/bridge-status')).json()) as {token: string; online: boolean}
  ).token;
  assert.ok(token.length > 20, 'a token should be generated on first ask');

  // With no laptop answering, she must say so rather than claim to have done
  // it. Reporting success about a console that never moved is the one failure
  // that would make this whole feature untrustworthy.
  const noBridge = await runTool({
    name: 'open_on_laptop',
    args: {url: 'https://example.com'},
  });
  assert.match(
    noBridge.result,
    /not running|no way into/i,
    'with no bridge she must say she cannot reach the laptop',
  );
  ok('with no laptop listening she says so, rather than claiming success');

  // Now stand in for the laptop: check in, take the instruction, report back.
  const asBridge = (body: unknown) =>
    fetch(`${base}/bridge`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });

  const consoleState = {
    found: true,
    status: 'STANDBY',
    name: 'PS5-1234',
    address: '192.168.1.20',
    at: new Date().toISOString(),
  };
  const firstCheckIn = (await (await asBridge({token, state: consoleState})).json()) as {
    commands: {id: string}[];
  };
  assert.deepEqual(firstCheckIn.commands, [], 'nothing queued yet');

  const woken = runTool({name: 'open_on_laptop', args: {url: 'https://example.com'}});
  // Give the tool a moment to queue the instruction before the laptop looks.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const collected = (await (await asBridge({token, state: consoleState})).json()) as {
    commands: {id: string; action: string}[];
  };
  assert.equal(collected.commands.length, 1, 'the laptop should be given the job');
  assert.equal(collected.commands[0].action, 'open');

  const claimedAgain = (await (await asBridge({token, state: consoleState})).json()) as {
    commands: unknown[];
  };
  assert.deepEqual(
    claimedAgain.commands,
    [],
    'and must not be handed the same job twice — that is two tabs, or two locks',
  );

  await asBridge({
    token,
    state: consoleState,
    results: [{id: collected.commands[0].id, ok: true, detail: 'sent'}],
  });

  const said = await woken;
  assert.match(said.result, /laptop screen/i, 'she reports what the laptop actually did');
  assert.doesNotMatch(said.result, /on its way/i, 'and states it rather than predicting it');

  /*
   * The laptop must not take playactor's word for it.
   *
   * playactor exits zero having opened a Remote Play session, sent the
   * request and closed again — whether or not the console acted. On a PS5
   * with more than one account the standby is routinely swallowed by a
   * Remote Play connection the wake left unfinished, so the console stays on,
   * playactor exits zero, and she reports it asleep. Structural rather than
   * behavioural because the bridge runs on someone's laptop and cannot be
   * exercised from here; what is asserted is that the unverified path is
   * gone and the verified one consults the console.
   */
  const bridgeProgram = readFileSync('bridge/bridge.mjs', 'utf8');
  for (const straightThrough of [
    "return playactor('wake')",
    "return playactor('standby')",
  ]) {
    assert.ok(
      !bridgeProgram.includes(straightThrough),
      `${straightThrough} reports an exit code as a fact — it must go through settle()`,
    );
  }
  assert.match(
    bridgeProgram,
    /async function settle\([\s\S]*?await discover\(\)/,
    'settle must ask the console what state it is actually in',
  );
  assert.match(
    bridgeProgram,
    /attempt <= 2/,
    'and must send it again once, since a single drop is cheap to be wrong about',
  );
  ok('waking and sleeping are verified against the console, not against an exit code');
  ok('an instruction reaches the laptop once, and she reports back what happened');

  // She can look at the console, and she cannot operate it beyond on and off.
  assert.ok(
    !allTools().some((tool) => /launch|start_game|press|button/i.test(tool.name)),
    'nothing may claim to start a game — a PS5 will not accept it',
  );
  ok('she has switching on and off, and claims nothing beyond it');

  // ---- she can go back and look ------------------------------------------
  // Her working memory is the recent window and a short summary. Everything
  // older used to be unreachable, which meant "I don't remember" about things
  // sitting in the log — the same as being wrong.
  await chat('The flat in Porto has a leaking tap in the back bathroom.');
  for (let filler = 0; filler < 14; filler += 1) {
    await chat(`Something unrelated, number ${filler}.`);
  }

  const recalled = await runTool({name: 'search_memory', args: {about: 'Porto tap'}});
  assert.ok(recalled.ok);
  assert.match(recalled.result, /leaking tap/, 'she should find what was said');
  // It has to be far enough back to be a real search rather than a glance at
  // the last few turns, which is the only case that would have worked before.
  const log = await getMessages();
  const buried = log.findIndex((message) => /leaking tap/.test(message.text));
  assert.ok(
    log.length - buried > 20,
    `the hit should be well back in the log, not in the recent window (${
      log.length - buried
    } messages back)`,
  );

  const nothing = await runTool({name: 'search_memory', args: {about: 'submarines'}});
  assert.match(nothing.result, /nothing in the record/i, 'and not invent a hit');
  ok('she searches the whole record rather than claiming to have forgotten');

  // ---- reaching the phone ------------------------------------------------
  const keyed = (await (await call('/push-key')).json()) as {
    key: string;
    devices: number;
  };
  assert.ok(keyed.key.length > 20, 'a signing key should be generated on first ask');
  assert.equal(keyed.devices, 0, 'and no device is subscribed yet');
  assert.equal(
    ((await (await call('/push-key')).json()) as {key: string}).key,
    keyed.key,
    'the key must be stable — a new one on every request unsubscribes every phone',
  );

  const rubbish = await call('/push-subscribe', {
    method: 'POST',
    body: JSON.stringify({subscription: {endpoint: 'https://example.test/x'}}),
  });
  assert.equal(rubbish.status, 400, 'a subscription with no keys must be refused');

  const device = {
    endpoint: 'https://push.example.test/device-one',
    keys: {p256dh: 'BJxxxxx', auth: 'aaaa'},
  };
  const subscribed = (await (
    await call('/push-subscribe', {
      method: 'POST',
      body: JSON.stringify({subscription: device}),
    })
  ).json()) as {devices: number};
  assert.equal(subscribed.devices, 1);

  // Browsers rotate endpoints and re-subscribe constantly. Piling them up is
  // how one phone ends up buzzing six times for one reminder.
  const again = (await (
    await call('/push-subscribe', {
      method: 'POST',
      body: JSON.stringify({subscription: device}),
    })
  ).json()) as {devices: number};
  assert.equal(again.devices, 1, 're-subscribing the same device must not duplicate it');
  ok('a phone can be subscribed once, and re-subscribing does not double it');

  // ---- her own initiative ------------------------------------------------
  // Something due in the past, which is the plainest thing that wants a person.
  await runTool({
    name: 'add_reminder',
    args: {text: 'ring the landlord', due: new Date(Date.now() - 60_000).toISOString()},
  });

  const first = await pulse();
  assert.ok(
    first.concerns.some((concern) => /landlord/.test(concern.text)),
    'an overdue reminder should be noticed',
  );
  assert.ok(first.say, 'and she should have something to say about it');
  assert.ok(
    (await getMessages()).some((message) => message.text === first.say),
    'what she says unprompted must be in the conversation, or the next reply is lost',
  );
  ok('she notices what is overdue and says so without being asked');

  const second = await pulse();
  assert.deepEqual(
    second.concerns,
    [],
    'the same concern must never be raised twice — that is what makes it bearable',
  );
  assert.equal(second.say, null, 'and nothing is spent looking at nothing');
  ok('nothing is raised twice, and an uneventful look costs nothing');

  // Focus mode exists to be obeyed. An assistant who honours it except when
  // she has something interesting is one nobody leaves running.
  await setMode('focus');
  await runTool({
    name: 'add_reminder',
    args: {text: 'water the plants', due: new Date(Date.now() + 30 * 60_000).toISOString()},
  });
  const quiet = await pulse();
  assert.ok(quiet.concerns.length > 0, 'she still notices while you are heads-down');
  assert.equal(quiet.say, null, 'she simply does not interrupt with it');
  assert.ok(quiet.held, 'and says why she is holding it');
  await setMode('open');
  ok('in Focus she notices but holds her tongue');

  // She can act on mail and diary now, and the shape of that matters: a tool
  // that drafts is fine, a tool that sends is not, and the difference must be
  // visible in the list rather than trusted to the model.
  const names = allTools().map((tool) => tool.name);
  for (const expected of ['check_mail', 'read_mail', 'draft_reply', 'check_diary']) {
    assert.ok(names.includes(expected), `${expected} should exist`);
  }
  assert.ok(
    !names.some((name) => /send/i.test(name)),
    'no tool may be named for sending — that limit has no exceptions',
  );
  /*
   * Destroying is a different case from sending, and the difference is the
   * user's own.
   *
   * Sending is impossible: there is no tool, so there is nothing to talk her
   * past. Destroying exists — they asked for their own machine — and is never
   * silent. So the assertion is not "no such tool" but "no such tool that
   * could run without being held", which is the promise that was actually
   * made. A delete_file that quietly lost its marking would pass the old
   * check by being renamed, and fails this one.
   */
  for (const tool of allTools()) {
    if (!/delete|remove|trash|destroy/i.test(tool.name)) continue;
    assert.equal(
      tool.category,
      'machine',
      `${tool.name} destroys, so it belongs to the machine policy`,
    );
    assert.ok(
      tool.destructive || tool.risky,
      `${tool.name} destroys and must declare it, or the gate waves it through`,
    );
  }
  ok('mail and diary tools exist, none sends, and nothing destroys unannounced');

  // ---- she cannot send mail, as a matter of code -------------------------
  // Google publishes no draft-only scope, so gmail.compose carries the ability
  // to send whether we want it or not. The user's first hard limit therefore
  // cannot be enforced by scope, and is enforced here instead: if a send call
  // ever appears in this repository, this fails.
  const googleSources = readdirSync('server/google')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(`server/google/${name}`, 'utf8'));

  for (const source of googleSources) {
    assert.doesNotMatch(
      source,
      /drafts\/[^'"`\s]*\/send|messages\/send|\.send\(/,
      'nothing in the Google layer may send mail',
    );
  }
  assert.ok(
    googleSources.some((source) => source.includes('drafts')),
    'the draft path should exist, or this check is proving nothing',
  );
  ok('no code path exists that sends mail on the user’s behalf');

  // ---- she cannot destroy mail either, now that she can move it ----------
  // gmail.modify is what lets her file and label. It also carries the ability
  // to bin, which the user has forbidden outright, so the same style of proof
  // applies: no endpoint that destroys, and no request that applies the two
  // labels which amount to destroying.
  for (const source of googleSources) {
    assert.doesNotMatch(
      source,
      /messages\/[^'"`\s]*\/trash|messages\/[^'"`\s]*\/untrash|method: 'DELETE'/,
      'nothing in the Google layer may bin mail or remove a diary entry',
    );
  }
  assert.ok(
    googleSources.some((source) => source.includes('/modify')),
    'the modify path should exist, or this check is proving nothing',
  );
  // And the refusal is real rather than an absence: asked outright to apply
  // Gmail's bin label, the one function that changes labels says no, before it
  // reaches the network.
  await assert.rejects(
    () => labelMail('any-message', 'TRASH'),
    /not hers to touch/,
    'the bin must be refused at the seam, not merely never asked for',
  );
  await assert.rejects(() => labelMail('any-message', 'spam'), /not hers to touch/);
  ok('she can file and label mail, and cannot bin it by any route');

  // ---- the tools she points at herself -----------------------------------
  const heldBefore = (await getProfile()).entries.length;
  const kept = await runTool({
    name: 'remember_this',
    args: {fact: 'The user keeps a standing desk at the window', kind: 'fact'},
  });
  assert.equal(kept.ok, true);
  assert.equal((await getProfile()).entries.length, heldBefore + 1, 'it should be held');

  const corrected = await runTool({
    name: 'correct_memory',
    args: {old: 'The user keeps a standing desk at the window'},
  });
  assert.equal(corrected.ok, true);
  const entry = (await getProfile()).entries.find((one) =>
    one.text.includes('standing desk'),
  );
  assert.ok(entry?.supersededAt, 'a correction marks it overtaken');
  assert.equal(
    (await getProfile()).entries.length,
    heldBefore + 1,
    'and keeps it — that it used to be true is itself a fact',
  );
  ok('she can commit something to memory and correct it, losing nothing');

  const unmatched = await runTool({name: 'correct_memory', args: {old: 'utter invention'}});
  assert.match(
    unmatched.result,
    /Do not claim you changed anything/,
    'correcting nothing must not read to the model as a success',
  );
  ok('a correction that matched nothing says so rather than claiming a change');

  await runTool({name: 'set_attention', args: {mode: 'work'}});
  assert.equal((await getMode()).mode, 'work', 'she can change her own mode');
  const badMode = await runTool({name: 'set_attention', args: {mode: 'sleepy'}});
  assert.match(badMode.result, /no "sleepy" mode/);
  assert.equal((await getMode()).mode, 'work', 'and an invented one changes nothing');
  await runTool({name: 'set_attention', args: {mode: 'open'}});
  ok('she can move herself between attention modes, and refuses invented ones');

  const built = await runTool({
    name: 'make_room',
    args: {name: 'Gym', panels: 'day, weather', accent: 'rose'},
  });
  assert.equal(built.ok, true);
  const gym = (await workspaces()).find((room) => room.name === 'Gym');
  assert.ok(gym, 'the room should be in the rail');
  assert.deepEqual(gym.panels, ['day', 'weather']);

  // Saying the same name again edits that room rather than making a second one
  // called Gym, which is what "add the weather to my gym room" has to mean.
  await runTool({name: 'make_room', args: {name: 'Gym', panels: 'day, weather, notes'}});
  const gyms = (await workspaces()).filter((room) => room.name === 'Gym');
  assert.equal(gyms.length, 1, 'a second room of the same name is never right');
  assert.deepEqual(gyms[0].panels, ['day', 'weather', 'notes']);
  ok('she can build a room by voice, and naming it again edits it');

  // ---- she is only offered what is plugged in ----------------------------
  // Every declaration is paid for on every request, so a tool for a service
  // with no key is a standing charge for something that can only answer "not
  // connected". Nothing is offered here, which is this account's actual state.
  const unplugged = {
    google: false,
    github: false,
    n8n: false,
    playstation: false,
    room: false,
    phone: false,
    lights: false,
    coding: false,
  };
  const offeredBare = declarations(unplugged).map((tool) => tool.name);
  const offeredAll = declarations().map((tool) => tool.name);

  for (const gated of [
    'check_mail',
    'check_github',
    'pause_workflow',
    'lock_laptop',
    'set_lights',
    // Offering to write code on a machine with no coding agent on it means
    // promising and then explaining, on every single request, for ever.
    'write_code',
  ]) {
    assert.ok(offeredAll.includes(gated), `${gated} should exist at all`);
    assert.ok(!offeredBare.includes(gated), `${gated} needs a key and must not be offered`);
  }
  for (const always of ['search_web', 'add_reminder', 'remember_this', 'ask_choice']) {
    assert.ok(offeredBare.includes(always), `${always} depends on unplugged and must stay`);
  }
  assert.ok(
    JSON.stringify(declarations(unplugged)).length <
      JSON.stringify(declarations()).length * 0.8,
    'gating should be worth doing — a fifth of the payload at least',
  );

  // Two calls with the same picture must be byte-identical, or the prompt
  // prefix changes between messages and Gemini's cache discount is lost —
  // which would cost more than the tools left out.
  assert.equal(
    JSON.stringify(declarations(unplugged)),
    JSON.stringify(declarations({...unplugged})),
    'the offered list must be stable for the same set of connections',
  );
  ok('only connected tools are offered, and the offer is stable enough to cache');

  // The prompt narrows on the same picture, for a reason beyond the tokens: a
  // paragraph teaching her to pause a failing n8n workflow, on an account with
  // no n8n and therefore no pause_workflow, can only teach her to promise
  // something she has no way to do.
  const wholeSelf = buildSystemPrompt({
    profile: await getProfile(),
    summary: null,
    policies: [],
    via: 'text',
    now: new Date(),
    mode: 'open',
  });
  const thisAccount = buildSystemPrompt({
    profile: await getProfile(),
    summary: null,
    policies: [],
    via: 'text',
    now: new Date(),
    mode: 'open',
    available: unplugged,
  });
  assert.match(wholeSelf, /pause_workflow/, 'the whole of her still describes it');
  assert.doesNotMatch(
    thisAccount,
    /pause_workflow|open_on_laptop|notify_phone|recent_games/,
    'nothing unconnected may be described',
  );
  // The rules that hold whatever is plugged in must survive the narrowing.
  for (const rule of ['never send', 'search_web', 'ask_choice', 'remember_this']) {
    assert.ok(thisAccount.includes(rule), `"${rule}" is not conditional on anything`);
  }
  assert.ok(
    thisAccount.length < wholeSelf.length * 0.9,
    'and the narrowing should be worth doing',
  );
  ok('the prompt describes only the powers she actually has');

  // Lights are the one gated thing that has to say something when it is
  // absent: "I can't do that" is a worse answer than "that needs a key".
  assert.match(thisAccount, /Govee API key/, 'unconnected lights explain themselves');
  assert.doesNotMatch(thisAccount, /dim_lights/, 'without saying she can work them');
  ok('a power she has not got yet explains how to give it to her');

  // ---- whose voice she answers to ----------------------------------------
  // The maths, proved against synthesised voices with known fundamentals and
  // known formants. A recording of a real person would be worse on every
  // count: it would commit someone's voice to the repository, and when it
  // failed nobody could say which property had failed.
  voiceChecks(assert);
  ok('the speaker check separates one voice from another, and refuses silence');

  const fresh = await call('/voice-guard');
  assert.equal(fresh.status, 200);
  const atFirst = (await fresh.json()) as {enrolment: unknown; on: boolean};
  assert.equal(atFirst.enrolment, null, 'nothing enrolled to begin with');
  assert.equal(atFirst.on, false, 'and never guarding by default');

  // Turning the guard on with no print would mean refusing every voice
  // including the owner's — a lockout, so it is quietly refused.
  const premature = await call('/voice-set', {
    method: 'POST',
    body: JSON.stringify({on: true}),
  });
  assert.equal(((await premature.json()) as {on: boolean}).on, false);
  ok('she cannot be set to refuse everyone, which is what a lockout would be');

  // A print is numbers arriving from a browser, so it is checked rather than
  // trusted: wrong length, missing pitch, and impossible tightness all bounce.
  for (const bad of [
    {print: {bands: [1, 2, 3], pitch: 120, voiced: 1}, samples: 3, tightness: 0.9},
    {print: {bands: new Array(BANDS).fill(0), pitch: 120, voiced: 0}, samples: 3, tightness: 0.9},
    {print: {bands: new Array(BANDS).fill(0), pitch: 120, voiced: 1}, samples: 3, tightness: 5},
    'not an object',
  ]) {
    const refused = await call('/voice-enrol', {
      method: 'POST',
      body: JSON.stringify({enrolment: bad}),
    });
    assert.equal(refused.status, 400, 'a malformed print must not be stored');
  }

  const good = {
    print: {bands: new Array(BANDS).fill(0.1), pitch: 118, voiced: 0.9},
    samples: 3,
    tightness: 0.94,
    spread: new Array(BANDS).fill(0.2),
    at: '2026-01-01T00:00:00.000Z',
  };
  const enrolled = await call('/voice-enrol', {
    method: 'POST',
    body: JSON.stringify({enrolment: good}),
  });
  assert.equal(enrolled.status, 200);
  const guarded = await call('/voice-set', {
    method: 'POST',
    body: JSON.stringify({on: true, strictness: 'strict'}),
  });
  const settings = (await guarded.json()) as {on: boolean; strictness: string};
  assert.equal(settings.on, true, 'with a print, the guard can be turned on');
  assert.equal(settings.strictness, 'strict');
  ok('a voiceprint is validated atFirst it is stored, and then it can guard');

  // The only thing in this app that is really erased rather than filed. That
  // asymmetry is deliberate: the standing instruction protects the user's
  // records, and this is not a record — it is a measurement of their body.
  const forgotten = (await (
    await call('/voice-forget', {method: 'POST'})
  ).json()) as {enrolment: unknown; on: boolean};
  assert.equal(forgotten.enrolment, null, 'forgetting a voice really removes it');
  assert.equal(forgotten.on, false, 'and stops the guard with it');
  ok('a voice can be taken back, and taking it back means gone');

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
  // Two messages per exchange, and enough of them to be past the threshold
  // whatever that threshold is set to — the seeding used to be a bare number
  // and quietly stopped testing anything the moment the window was widened.
  const enough = Math.ceil(config.summarizeAfter / 2) + 2;
  for (let i = 0; i < enough; i += 1) await chat(`Message number ${i}.`);
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

  // ---- the lights, and telling the truth about them ----------------------
  /*
   * She said she had done it and the room did not change.
   *
   * Govee accepts a second command to the same device within about a second,
   * answers 200, and drops it. Ask for something that is two changes — dimmer
   * and warmer — and she calls two tools back to back a few milliseconds
   * apart, so one of them never reaches the bulb. There is no error anywhere,
   * which is why she reported it as done, entirely sincerely.
   *
   * A stand-in for Govee that behaves exactly that way, so the bug is
   * reproduced rather than described.
   */
  const realFetch = globalThis.fetch;
  const arrivals: {at: number; capability?: string}[] = [];
  /** What the pretend bulb is actually set to, as opposed to what it accepted. */
  const bulb = {powerSwitch: 0, brightness: 100, colorRgb: 0xffffff};
  let dropped = 0;
  let lastAcceptedAt = 0;
  /** Forces the swallow-it-silently behaviour, to prove the recovery works. */
  let dropNext = false;
  /** Makes the pretend strip report a stale colour, as real ones do briefly. */
  let staleColour = false;
  /** Adds a device the account lists but nothing answers for. */
  let ghost = false;

  const asGovee = async (url: string, init?: {body?: string}) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, any>) : null;
    const json = (payload: unknown) =>
      new Response(JSON.stringify({code: 200, msg: 'success', ...(payload as object)}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });

    if (url.endsWith('/user/devices')) {
      return json({
        data: [
          {sku: 'H6199', device: 'AA:BB', deviceName: 'Strip'},
          ...(ghost ? [{sku: 'H6199', device: 'CC:DD', deviceName: 'Ghost'}] : []),
        ],
      });
    }

    if (body?.payload?.device === 'CC:DD') {
      // The unplugged one: the account lists it and nothing ever answers.
      return new Response('{}', {status: 500});
    }

    if (url.endsWith('/device/control')) {
      const capability = body?.payload?.capability;
      const now = Date.now();
      arrivals.push({at: now, capability: capability?.instance});

      // The whole defect, in three lines: too soon after the last one, so it
      // is accepted and thrown away. Success is reported either way.
      if (dropNext || now - lastAcceptedAt < 800) {
        dropNext = false;
        dropped += 1;
        return json({});
      }
      lastAcceptedAt = now;
      bulb[capability.instance as keyof typeof bulb] = capability.value;
      return json({});
    }

    if (url.endsWith('/device/state')) {
      return json({
        payload: {
          capabilities: [
            {instance: 'online', state: {value: true}},
            {instance: 'powerSwitch', state: {value: bulb.powerSwitch}},
            {instance: 'brightness', state: {value: bulb.brightness}},
            {
              instance: 'colorRgb',
              // A read-back that lags behind what the strip is visibly doing.
              state: {value: staleColour ? 0x010203 : bulb.colorRgb},
            },
          ],
        },
      });
    }

    throw new Error(`unexpected Govee call: ${url}`);
  };

  globalThis.fetch = ((url: string, init?: {body?: string}) =>
    String(url).includes('openapi.api.govee.com')
      ? asGovee(String(url), init)
      : realFetch(url as never, init as never)) as typeof fetch;

  await setKey('govee', 'pretend-key');
  forgetLights();

  try {
    // Two changes in one breath, exactly as she issues them: no gap at all.
    const dimmed = await runTool({name: 'dim_lights', args: {percent: 20}});
    const warmed = await runTool({name: 'colour_lights', args: {colour: 'warm'}});

    assert.ok(dimmed.ok && warmed.ok, 'both commands should report success');

    // The point: reported success and real state now agree. Before the fix the
    // second of these was 100 and 0xffffff — untouched, and reported as done.
    assert.equal(bulb.brightness, 20, 'the brightness must really be set');
    assert.equal(bulb.colorRgb, (255 << 16) | (180 << 8) | 110, 'and so must the colour');

    // Not dropped at all, because they were spaced out rather than fired
    // together. Prevention is the fix; the retry below is the safety net.
    const gaps = arrivals
      .slice(1)
      .map((one, at) => one.at - arrivals[at]!.at);
    assert.ok(
      gaps.every((gap) => gap >= 800),
      `commands to one device must be spaced out, got gaps ${gaps.join(', ')}ms`,
    );
    assert.equal(dropped, 0, 'and so none of them should have been swallowed');
    ok(`two changes in one breath both land, spaced ${Math.min(...gaps)}ms apart`);

    // The safety net, for every other reason a bulb ignores an instruction:
    // one it accepted and threw away must be noticed and sent again.
    // Lit, because a light that is off cannot confirm a colour and is
    // deliberately not asked to — so this is the only state in which the
    // re-send is reachable at all.
    bulb.powerSwitch = 1;
    dropNext = true;
    const forced = await runTool({name: 'colour_lights', args: {colour: 'blue'}});
    assert.ok(forced.ok, 'a swallowed command should still end in success');
    assert.equal(dropped, 1, 'the stand-in must really have swallowed one');
    assert.equal(
      bulb.colorRgb,
      (0 << 16) | (90 << 8) | 255,
      'a swallowed command must be noticed and sent again, not reported as done',
    );
    ok('a command the light accepts and ignores is caught by reading it back');

    // And she can now ask rather than assume. Switched on by hand here, the
    // way a person does, which is exactly the case she cannot remember her way
    // out of and has to look.
    bulb.powerSwitch = 1;
    const seen = await runTool({name: 'check_lights', args: {}});
    assert.match(seen.result, /Strip/, 'the light should be named');
    assert.match(seen.result, /20%/, 'and its real brightness reported');
    assert.match(seen.result, /blue/, 'and its real colour, in a word she can say');
    ok('she can read the room back from the lights themselves');

    /*
     * A light that will not confirm is not a light that failed.
     *
     * The verification added above went too far: a strip whose colour
     * read-back lags, reports one segment of several, or answers on a scale
     * it was not commanded in reads as disobedient. She then told someone
     * standing in a visibly-changed room that their light was not working,
     * which is worse than the silence it was added to fix — it teaches you to
     * stop believing her.
     */
    staleColour = true;
    const shy = await runTool({name: 'colour_lights', args: {colour: 'green'}});
    assert.ok(shy.ok, 'a light that will not confirm must not be an error');
    assert.doesNotMatch(
      shy.result,
      /did not act|could not be reached|failed/i,
      `and must never be asserted to have failed — got: ${shy.result}`,
    );
    assert.match(shy.result, /would not confirm/i, 'the uncertainty is reported honestly');
    assert.match(
      shy.result,
      /Do NOT say it is not working/,
      'and she is told plainly not to call it broken',
    );
    assert.equal(bulb.colorRgb, (0 << 16) | (255 << 8) | 60, 'and it really was set');
    staleColour = false;
    ok('a light that will not confirm is reported as unconfirmed, not broken');

    /*
     * One dead device beside a working one.
     *
     * A Govee account goes on listing a strip long after it is unplugged, so
     * "the lights" is one real light and one ghost. Every command then had one
     * half throw, and Promise.all turns one thrown half into a total failure —
     * so a strip that had just changed colour perfectly was reported as not
     * working. That is very probably what has been happening.
     */
    ghost = true;
    forgetLights();
    const beside = await runTool({name: 'set_lights', args: {on: true}});
    assert.ok(beside.ok, 'one unreachable light must not sink the working one');
    assert.match(beside.result, /Strip/, 'the working light is named as having worked');
    assert.match(beside.result, /Ghost/, 'and the unreachable one is named separately');
    assert.match(
      beside.result,
      /rather than calling the whole thing a failure/,
      'and she is told not to generalise from it',
    );
    ok('one unreachable light is named, and does not sink the ones that worked');

    const counted = await runTool({name: 'list_lights', args: {}});
    assert.match(counted.result, /2 lights/, 'she can say how many the account lists');
    assert.match(counted.result, /stale/i, 'and explain a count that looks wrong');
    ok('she can say how many lights the account thinks exist');

    ghost = false;
    forgetLights();

    /*
     * A dark light has nothing to say about its colour.
     *
     * Most models report brightness and colour as zero while powered down,
     * which matches nothing anyone asked for. Verifying it anyway meant every
     * command sent to a dark room did its work, disagreed with itself,
     * re-sent everything, waited, disagreed again, and finished by doubting a
     * command it had carried out perfectly — three seconds to manufacture an
     * uncertainty.
     */
    bulb.powerSwitch = 0;
    bulb.brightness = 0;
    bulb.colorRgb = 0;
    const inTheDark = arrivals.length;
    const dimmed2 = await runTool({name: 'dim_lights', args: {percent: 40}});
    assert.ok(dimmed2.ok);
    assert.doesNotMatch(dimmed2.result, /would not confirm/i, 'no manufactured doubt');
    assert.match(dimmed2.result, /switched off/i, 'but she is told nothing will show');
    assert.equal(
      arrivals.length - inTheDark,
      1,
      'and it must not be re-sent chasing a confirmation a dark light cannot give',
    );
    ok('a command to a dark light is not re-sent chasing an impossible confirmation');
    bulb.powerSwitch = 1;

    // ---- the named settings ---------------------------------------------
    // Kelvin is the axis because it is the language the research uses and
    // because "warmer" and "cooler" then mean something you can slide along.
    // The behaviour that matters is at the bottom of the range: a bedroom
    // setting must contain no blue at all, or it is not a bedroom setting.
    const [, , night] = kelvinToRgb(1200);
    assert.equal(night, 0, '1200K must have no blue in it whatsoever');
    assert.ok(kelvinToRgb(1200)[0] > 200, 'and must still be a real, red light');
    assert.ok(
      kelvinToRgb(6000)[2] > kelvinToRgb(3000)[2],
      'and cooler must actually mean more blue',
    );
    ok('colour temperature converts to something a bedroom can use at midnight');

    // The phrase people actually say. "Mode" carries nothing and is dropped;
    // the longest alias wins, so "night light" is not swallowed by "night".
    for (const [spoken, wanted] of [
      ['sleep mode', 'sleep'],
      ['activate sleep mode', 'sleep'],
      ['put it in sleep mode please', 'sleep'],
      ['goodnight', 'sleep'],
      ['night light', 'night light'],
      ['work mode', 'work'],
      ['movie time', 'film'],
      ['wind down', 'wind down'],
    ] as const) {
      const found = await findScene(spoken);
      assert.equal(found?.id, wanted, `"${spoken}" should mean ${wanted}`);
    }

    // Whole words only. Plain containment made "day" match inside "today", so
    // asking what was on could have put the room into daylight at midnight.
    for (const innocent of ['today', 'birthday', 'workshop', 'relaxation']) {
      assert.equal(
        await findScene(innocent),
        null,
        `"${innocent}" must not match a setting hiding inside it`,
      );
    }
    ok('the settings answer to the words people actually say, and only those');

    const asked = await runTool({name: 'set_scene', args: {scene: 'sleep mode'}});
    assert.ok(asked.ok, `sleep mode should apply: ${asked.result}`);
    assert.equal(bulb.powerSwitch, 1, 'a scene turns the light on');
    assert.equal(bulb.brightness, 1, 'and sets its brightness');
    assert.equal(bulb.colorRgb & 0xff, 0, 'and leaves no blue in a bedroom at night');
    ok('a named setting lands as colour and brightness together');

    // "Make sleep mode a bit dimmer" has to survive until tomorrow night or it
    // was not worth saying.
    const already = (await allScenes()).find((one) => one.id === 'sleep')!;
    await runTool({
      name: 'adjust_scene',
      args: {scene: 'sleep', nudge: 'brighter', much: true},
    });
    const after = (await allScenes()).find((one) => one.id === 'sleep')!;
    assert.ok(after.brightness > already.brightness, 'brighter must mean brighter');
    assert.equal(bulb.brightness, after.brightness, 'and must be shown, not just stored');

    const reapplied = await runTool({name: 'set_scene', args: {scene: 'sleep'}});
    assert.ok(reapplied.ok);
    assert.equal(bulb.brightness, after.brightness, 'the change must stick for next time');
    ok('an adjustment shows immediately and is still there next time');

    await runTool({name: 'restore_scene', args: {scene: 'sleep'}});
    assert.equal(
      (await allScenes()).find((one) => one.id === 'sleep')!.brightness,
      already.brightness,
      'restoring must put the researched value back',
    );
    ok('a setting can be put back to where it started');

    // A colour set on a light that is off is a complete success and a visible
    // nothing — which is the exact thing that made her look like a liar.
    bulb.powerSwitch = 0;
    const invisible = await runTool({name: 'colour_lights', args: {colour: 'red'}});
    assert.match(
      invisible.result,
      /switched off/i,
      'she must be told when a change cannot be seen',
    );
    ok('a change nobody can see is reported as such, not as done');
  } finally {
    globalThis.fetch = realFetch;
    await setKey('govee', '');
    forgetLights();
  }

  // ---- reaching her from outside the browser -----------------------------
  // The door Siri knocks on. It is on the open internet with a token in front
  // of it and nothing else, so what is asserted here is mostly what it refuses.
  const noToken = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({text: 'turn the light off'}),
  });
  assert.equal(noToken.status, 401, 'the relay must not answer without a token');

  const badToken = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({token: 'not-the-token', text: 'turn the light off'}),
  });
  assert.equal(badToken.status, 401);
  assert.deepEqual(
    await badToken.json(),
    {error: 'no'},
    'a wrong token learns nothing about the right one',
  );
  ok('the relay refuses a missing or wrong token, and says nothing else');

  // Both doors have to be replaceable. A credential you cannot change is one
  // you have to be perfect about, and nobody is — it gets read over a
  // shoulder, pasted into the wrong window, left in a screenshot.
  const bridgeBefore = (await (await call('/bridge-status')).json()) as {token: string};
  const bridgeRolled = await call('/bridge-roll', {method: 'POST'});
  assert.equal(bridgeRolled.status, 200);
  const bridgeAfter = (await (await call('/bridge-status')).json()) as {token: string};
  assert.notEqual(bridgeAfter.token, bridgeBefore.token, 'rolling must change it');

  const staleLaptop = await call('/bridge', {
    method: 'POST',
    body: JSON.stringify({token: bridgeBefore.token, state: null}),
  });
  assert.equal(staleLaptop.status, 401, 'the old token must stop working at once');

  const freshLaptop = await call('/bridge', {
    method: 'POST',
    body: JSON.stringify({token: bridgeAfter.token, state: null}),
  });
  assert.equal(freshLaptop.status, 200, 'and the new one must work');
  ok('the laptop token can be replaced, and the old one dies immediately');

  // The token itself is behind the password. Anyone who could read it without
  // signing in would not need to guess at the door it opens.
  assert.equal(
    (await call('/relay-key', {headers: {cookie: ''}})).status,
    401,
    'the relay token must never be handed to a stranger',
  );

  const keyResponse = await call('/relay-key');
  assert.equal(keyResponse.status, 200);
  const relayKey = (await keyResponse.json()) as {token: string; url: string};
  assert.ok(relayKey.token.length >= 30, 'the token must be long enough to be a token');
  assert.match(relayKey.url, /\/api\/relay$/, 'the panel shows the address that works');
  ok('the relay token is issued to a signed-in browser, with its address');

  // A request through two proxies carries both hostnames in one header, and
  // node hands a repeated header back as an array. Stringifying either put a
  // comma in the middle of the address, which a phone rejects as an
  // unsupported URL — a baffling thing to be told when all you did was tap
  // Copy. The address must be an address whatever arrives here.
  assert.equal(
    relayUrl('front.example.com, inner.internal', undefined, true),
    'https://front.example.com/api/relay',
    'a comma-joined header must yield the outermost host, not both',
  );
  assert.equal(
    relayUrl(['front.example.com', 'inner.internal'], undefined, true),
    'https://front.example.com/api/relay',
    'a repeated header arrives as an array and must be handled the same way',
  );
  assert.equal(
    relayUrl(undefined, 'grace.example.com', true),
    'https://grace.example.com/api/relay',
    'with no proxy, the plain Host header is the answer',
  );
  assert.equal(
    relayUrl(undefined, 'localhost:3000', true),
    'http://localhost:3000/api/relay',
    'a machine on your desk has no certificate and never will',
  );
  for (const junk of ['', ' ', 'not a host', 'evil.com/path', '<script>']) {
    assert.equal(
      relayUrl(junk, undefined, true),
      '/api/relay',
      `"${junk}" is not a hostname and must not become half an address`,
    );
  }
  ok('the address survives proxies, arrays and nonsense, or admits it cannot');

  const relayed = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({token: relayKey.token, text: 'Is there anything on today?'}),
  });
  assert.equal(relayed.status, 200);
  const spokenBack = (await relayed.json()) as {
    reply: string;
    spoken: string;
    acted: unknown[];
    open: string[];
  };
  assert.equal(spokenBack.reply, REPLY, 'the relay runs a real turn, not a stub of one');
  ok('a valid token gets a full answer back');

  /*
   * The voice runs somewhere else, and must not become a second Grace.
   *
   * The machine holding a spoken conversation open has her tool list but
   * none of her hands: every tool call travels back here and is carried out
   * by the same code a typed conversation uses. If that seam ever breaks
   * open — if the outpost grows its own copy of the tools — the two Graces
   * drift, and the drift shows up as her denying she did something she had
   * just done out loud.
   */
  const probed = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({token: relayKey.token, probe: true}),
  });
  assert.equal(probed.status, 200, 'the outpost must be able to check a token');
  assert.equal(
    (
      await call('/relay', {
        method: 'POST',
        body: JSON.stringify({token: 'not-the-token', probe: true}),
      })
    ).status,
    401,
    'and must be refused when the token is wrong, like every other way in',
  );

  const ran = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({
      token: relayKey.token,
      tool: 'list_reminders',
      args: {},
    }),
  });
  assert.equal(ran.status, 200, 'a tool called by the voice must actually run');
  assert.ok(
    typeof (await ran.json()).result === 'string',
    'and must answer with something the model can say out loud',
  );

  const madeUp = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({token: relayKey.token, tool: 'drop_the_database', args: {}}),
  });
  assert.equal(madeUp.status, 200, 'an invented tool is answered, not crashed on');
  assert.match(
    (await madeUp.json()).result,
    /no tool called/i,
    'and is refused by name rather than run',
  );
  ok('the voice borrows her hands rather than growing its own');

  /*
   * The voice is briefed from the same place as the typed conversation.
   *
   * Without this the outpost opened its model session with no system prompt
   * and no tools: a nameless model that could do nothing, wearing her voice.
   * The briefing has to be hers — her name in it, her tool list — and come
   * from the one function the typed path also uses, so the two cannot drift.
   */
  /*
   * The brake reaches the voice.
   *
   * A spoken session costs money from the moment it opens and the outpost
   * cannot see the pool, so it asks for her briefing first and is refused
   * when the credit is gone. By this point in the suite the pool has been
   * deliberately exhausted, which makes this the natural place to prove it.
   */
  const refusedVoice = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({token: relayKey.token, brief: true}),
  });
  assert.equal(refusedVoice.status, 402, 'past the pool, no new voice session');
  assert.match(
    ((await refusedVoice.json()) as {error: string}).error,
    /credit|limit/i,
    'and the refusal says why, in words the outpost can pass on',
  );

  // With room to spend, the same request briefs her. Restored afterwards so
  // nothing below inherits a raised cap.
  const realPool = process.env.GRACE_CREDIT_POOL;
  process.env.GRACE_CREDIT_POOL = '1000000';
  const briefed = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({token: relayKey.token, brief: true}),
  });
  if (realPool === undefined) delete process.env.GRACE_CREDIT_POOL;
  else process.env.GRACE_CREDIT_POOL = realPool;
  assert.equal(briefed.status, 200);
  const herBrief = (await briefed.json()) as {system: string; tools: {name: string}[]};
  assert.match(herBrief.system, /Grace/, 'the briefing must be hers, by name');
  assert.ok(herBrief.tools.length > 0, 'and must carry her tools');
  assert.ok(
    herBrief.tools.some((tool) => tool.name === 'confirm_action'),
    'including the one that lets a held action be approved',
  );
  ok('the spoken Grace is briefed from the same place as the typed one');

  /*
   * What is said aloud lands in the same memory as what is typed.
   *
   * Otherwise she remembers nothing you ever told her by voice — which is
   * most of what you tell her — and the next typed message has no idea what
   * was just said out loud.
   */
  const {getMessages: readLog} = await import('../server/memory');
  const logBefore = (await readLog()).length;
  const recorded = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({
      token: relayKey.token,
      record: true,
      heard: 'remind me the bins go out on Thursday',
      said: 'Thursday it is. I will remind you the night before.',
    }),
  });
  assert.equal(recorded.status, 200);
  const logNow = await readLog();
  assert.equal(logNow.length, logBefore + 2, 'both halves of the exchange are recorded');
  assert.equal(logNow[logNow.length - 2]?.speaker, 'user');
  assert.equal(logNow[logNow.length - 1]?.speaker, 'grace');
  assert.equal(logNow[logNow.length - 1]?.via, 'voice', 'and marked as spoken');
  ok('what is said aloud is remembered like what is typed');

  // The whole point of one pipeline: what arrives by phone is in the same
  // conversation as what was typed, or walking in the door and carrying on
  // does not work.
  const afterRelay = await getMessages();
  assert.ok(
    afterRelay.some((message) => message.text === 'Is there anything on today?'),
    'a relayed message must land in the conversation like any other',
  );
  assert.equal(
    afterRelay[afterRelay.length - 1]?.via,
    'voice',
    'a sentence spoken to a phone is a spoken sentence',
  );
  ok('relayed turns share the conversation, the memory and the input mode');

  // Same tools, same guardrails. A second door into her that offered a
  // different set of powers would be the bug this whole refactor exists to
  // make impossible.
  const relayTools = (stub.lastTools ?? []).map((tool) => tool.name).sort();
  await chat('And through the browser?');
  const browserTools = (stub.lastTools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(relayTools, browserTools, 'both doors must reach the same Grace');
  assert.match(stub.lastSystem, /never send|without asking/i, 'limits present either way');
  ok('the phone and the browser get identical tools and the same hard limits');

  // Markdown read aloud is noise: asterisks are pronounced by some voices, and
  // nobody has ever wanted to hear a URL spoken.
  const aloud = forSpeaking(
    '**Two** things:\n- [the invoice](https://example.com/really/long) is due\n- `npm` broke',
  );
  assert.doesNotMatch(aloud, /[*`\[\]]/, 'no markup should survive into speech');
  assert.doesNotMatch(aloud, /https?:/, 'no URL should be read out');
  assert.match(aloud, /the invoice is due/, 'the words themselves must survive');
  ok('replies are stripped of markup before anything speaks them');

  // Siri hands over an empty string when it mishears silence, often enough
  // that an error would be the usual outcome rather than the exception.
  const misheard = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({token: relayKey.token, text: '   '}),
  });
  assert.equal(misheard.status, 200, 'silence is not an error, it is a non-answer');
  assert.match(
    ((await misheard.json()) as {spoken: string}).spoken,
    /didn.t catch/i,
    'and it must be something sayable',
  );
  ok('a misheard silence gets an answer rather than an error tone');

  const rolled = await call('/relay-roll', {method: 'POST'});
  assert.equal(rolled.status, 200);
  const {token: newToken} = (await rolled.json()) as {token: string};
  assert.notEqual(newToken, relayKey.token, 'rolling must actually change it');

  const stale = await call('/relay', {
    method: 'POST',
    body: JSON.stringify({token: relayKey.token, text: 'still there?'}),
  });
  assert.equal(stale.status, 401, 'the old token must stop working immediately');
  ok('replacing the token locks out every shortcut carrying the old one');

  /*
   * ---- the shell, and which commands stop to ask -------------------------
   *
   * The half of the machine gate that lives on this side. The other half —
   * whether a path is allowed at all — is enforced on the user's own computer
   * and proved there, by bridge/check.mjs, because a boundary checked where
   * the request was written is not a boundary.
   *
   * What matters here is that the classifier is generous in the right
   * direction. A confirmation nobody needed costs a second; a deletion nobody
   * expected costs a day, so every case below that could destroy something
   * must come back true, and the plainly harmless ones must not — a gate that
   * asks about `ls` trains you to say yes without reading it.
   */
  for (const command of [
    'rm -rf ~/notes',
    'rm file.txt',
    'mv a b',
    'sudo apt install thing',
    'dd if=/dev/zero of=/dev/sda',
    'echo hi > notes.txt',
    'git reset --hard',
    'git push origin main --force',
    'chmod 777 .',
    'shutdown now',
  ]) {
    assert.equal(looksDestructive(command), true, `must stop and ask: ${command}`);
  }
  for (const command of [
    'ls -la',
    'cat notes.txt',
    'git status',
    'git log --oneline -20',
    'npm test',
    'grep -rn todo .',
    'echo hi >> log.txt',
    'node build.js 2>&1',
    'df -h',
  ]) {
    assert.equal(looksDestructive(command), false, `must not ask: ${command}`);
  }
  ok('commands that can destroy something stop and ask, and plain ones do not');

  // A tool is only as good as its category: if `run_command` were filed under
  // anything the user has set to "act freely", the classifier above would be
  // decoration. This asserts the wiring, not the intent.
  const machine = allTools().filter((tool) =>
    ['list_folder', 'read_file', 'write_file', 'delete_file', 'run_command'].includes(
      tool.name,
    ),
  );
  assert.equal(machine.length, 5, 'all five machine tools are registered');
  for (const tool of machine) {
    assert.equal(tool.category, 'machine', `${tool.name} is governed by the machine policy`);
  }
  assert.equal(
    machine.find((tool) => tool.name === 'delete_file')?.destructive,
    true,
    'deleting always asks, whatever else is going on',
  );
  assert.equal(
    machine.find((tool) => tool.name === 'write_file')?.risky?.({replace: true}),
    true,
    'overwriting asks',
  );
  assert.equal(
    machine.find((tool) => tool.name === 'write_file')?.risky?.({}),
    false,
    'writing something new does not',
  );
  assert.equal(
    await requiresConfirmation('machine', true),
    true,
    'the machine policy holds the risky ones',
  );
  assert.equal(
    await requiresConfirmation('machine', false),
    false,
    'and lets her get on with the rest',
  );
  ok('reading is hers; deleting and overwriting are the user’s to allow');

  /*
   * And the promise survives the settings.
   *
   * "Can delete, but always asks" is not a default — it is the instruction. A
   * gate that a dropdown can switch off is that promise only until somebody
   * changes the dropdown, so this sets the machine policy to the most
   * permissive value there is and proves a delete is still held.
   */
  await setPolicy('machine', 'never');
  const held = await runTool({name: 'delete_file', args: {path: '~/anything'}});
  assert.equal(held.ok, false, 'a delete is refused even when policy says act freely');
  assert.match(held.result, /go-ahead/, 'and is held for the user to confirm');
  await setPolicy('machine', 'high-risk');
  ok('deleting asks even with the machine policy set to act freely');

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
