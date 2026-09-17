import express, {type Express, type Request, type Response} from 'express';
import type {
  ActionCategory,
  ChatEvent,
  ConfirmationPolicy,
  GraceState,
  InputMode,
} from '../shared/types';
import {getPolicies, setPolicy} from './actions';
import {
  authStatus,
  checkPassword,
  clearSession,
  issueSession,
  pauseAfterFailure,
  requireAuth,
} from './auth';
import {bridgeStatus, bridgeToken, claim, report, rollBridgeToken} from './bridge';
import {spend, standing} from './budget';
import {config, isConfigured} from './config';
import {keyStatus, loadKeys, setKey} from './keys';
import {learnFrom, worthLearningFrom} from './learn';
import {briefFor} from './turn';
import {record as remember} from './memory';
import {upcoming} from './google/calendar';
import {recentMail} from './google/gmail';
import {
  authorizeUrl,
  completeSignIn,
  connection,
  disconnect,
  googleConfigured,
  missingScopes,
  redirectUri,
  type GoogleError,
} from './google/oauth';
import {greet} from './greeting';
import {recentDeeds} from './journal';
import {addFile, archiveFile, liveFiles} from './files';
import {archiveNote, liveNotes, saveNoteBody} from './notes';
import {allSituations} from './situations';
import {GithubError, githubConfigured, githubView} from './github';
import {N8nError, n8nConfigured, n8nView} from './n8n';
import {getProvider} from './llm/index';
import {playstation, psnConfigured, PsnError, recentlyPlayed} from './ps5';
import {pulse} from './pulse';
import {devices, notify, publicKey, subscribe} from './push';
import {markFired, runningTimers} from './tools/timers';
import {liveWatches} from './watch';
import {outstanding} from './tools/reminders';
import {allTools, auditTools, declarations, runTool} from './tools/index';
import {forgetAvailable} from './available';
import {forgetLights} from './lights';
import {SECURITY_HEADERS} from '../shared/headers';
import {trimTrailingSilence} from '../shared/trim';
import {research} from './research';
import {takeTurn} from './turn';
import {
  forSpeaking,
  noteRelayUse,
  relayAllows,
  relayStatus,
  relayToken,
  relayUrl,
  rollRelayToken,
} from './relay';
import {
  allChats,
  archiveChat,
  currentChat,
  newChat,
  openChat,
  rename,
} from './chats';
import {enrol, forgetVoice, isEnrolment, setGuard, voiceGuard} from './voiceguard';
import {getMode, isMode, setMode} from './modes';
import {
  clearConversation,
  compactIfNeeded,
  compactNow,
  forget,
  getMessages,
  getProfile,
  getSummary,
  record,
  recentTurns,
  setAddressAs,
  supersedeEntry,
} from './memory';
import {learnWritingStyle} from './style';
import {weatherLine} from './weather';
import {getBackend} from './store/index';
import {hideWorkspace, saveWorkspace, workspaces} from './workspaces';

/**
 * Express 4 lets a rejected async handler escape as an unhandled rejection,
 * which takes the process down. Grace is meant to stay up, so every async route
 * goes through here.
 */
function guard(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error: Error) => {
      console.error('[grace] request failed:', error.message);
      if (!res.headersSent) res.status(500).json({error: 'something went wrong'});
      else if (!res.writableEnded) res.end();
    });
  };
}

/**
 * What she already knows, condensed into a hint for the transcriber.
 *
 * Recognising a name is the difference between "tell Yusuf I'll be late" and
 * "tell you soon I'll be late", and a model that has seen the name once gets
 * it right. Rebuilt at most every half minute, so it costs nothing per
 * recording.
 */
let contextCache: {text: string; until: number} | null = null;

async function listeningContext(): Promise<string> {
  if (contextCache && contextCache.until > Date.now()) return contextCache.text;

  const [profile, turns] = await Promise.all([getProfile(), recentTurns()]);

  const known = profile.entries
    .filter((entry) => !entry.supersededAt)
    .slice(-40)
    .map((entry) => entry.text)
    .join('; ');

  // The last few turns carry the names and topic currently in play.
  const recent = turns
    .slice(-4)
    .map((turn) => `${turn.role === 'assistant' ? 'Grace' : 'They'}: ${turn.text}`)
    .join('\n');

  const text = [
    known && `Things known about the speaker: ${known}`,
    recent && `The conversation so far:\n${recent}`,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000);

  contextCache = {text, until: Date.now() + 30_000};
  return text;
}

/**
 * A full express app rather than a bare Router: Vite's dev middleware hands over
 * a plain Node response, and it is express itself — not Router — that adds
 * res.json and friends. Mounting the app works in dev, production and serverless.
 */
/**
 * Every route below is a single path segment, and must stay that way.
 *
 * Vercel routes `/api/anything` to the catch-all function but answers
 * `/api/anything/else` with a 404 that never reaches this code at all. That
 * silently broke forgetting a fact and clearing the conversation on the
 * deployed app while both worked perfectly on a local machine. The self-test
 * fails if a nested route is ever added.
 */
export function createApi(): Express {
  const api = express();

  // Also set here, not only on the outer app: on Vercel this router is the
  // whole of the function, and the outer server never runs.
  api.use((_req, res, next) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(header, value);
    }
    next();
  });
  // Recorded speech arrives as base64 in a JSON body, so the default 100kb
  // ceiling would reject anything longer than a sentence or two.
  api.use(express.json({limit: '25mb'}));

  // ---- open endpoints ----------------------------------------------------

  api.get(
    '/health',
    guard(async (_req, res) => {
      // Keys are loaded here explicitly. This route sits in front of the
      // middleware that loads them, so it was reporting whatever the instance
      // happened to have cached — which made it report "no Google credentials"
      // about credentials that were stored and working.
      await loadKeys().catch(() => {});
      res.json({
        ok: true,
        configured: isConfigured(),
        model: config.model,
        storage: getBackend().name,
        encrypted: Boolean(config.secret),
        // Named here so a server-side deploy can actually be verified. A change
        // behind the API leaves the frontend bundle identical, so there was
        // previously no way to tell a live server from a stale one — which is
        // how "it's deployed" got said about something that wasn't.
        tools: allTools().map((tool) => tool.name),
        google: googleConfigured(),
        playstation: psnConfigured(),
        cap: (await standing()).limit,
      });
    }),
  );

  api.get('/session', (req, res) => {
    res.json({status: authStatus(req)});
  });

  api.post(
    '/login',
    guard(async (req, res) => {
      const status = authStatus(req);
      if (status === 'misconfigured') {
        res.status(503).json({error: 'no password is set on the server'});
        return;
      }

      if (!checkPassword(String(req.body?.password ?? ''))) {
        await pauseAfterFailure();
        res.status(401).json({error: 'that is not the password'});
        return;
      }

      issueSession(res);
      res.json({ok: true});
    }),
  );

  api.post('/logout', (_req, res) => {
    clearSession(res);
    res.json({ok: true});
  });

  /**
   * The laptop on the user's home network, checking in.
   *
   * Deliberately outside the password wall: the bridge is a program, not a
   * person, and it carries its own token instead. It is also the only route
   * here that anything on the open internet can reach without signing in, so
   * the token is compared in constant time and a wrong one is told nothing at
   * all beyond "no".
   */
  api.post(
    '/bridge',
    guard(async (req, res) => {
      await loadKeys().catch(() => {});
      const token = String(req.body?.token ?? '');

      const results = Array.isArray(req.body?.results) ? req.body.results : [];
      if (results.length > 0 && !(await report(token, results))) {
        res.status(401).json({error: 'no'});
        return;
      }

      const state = req.body?.state ?? null;
      const claimed = await claim(token, state);
      if (!claimed.ok) {
        res.status(401).json({error: 'no'});
        return;
      }

      res.json({commands: claimed.commands});
    }),
  );

  /**
   * Her, reachable from anything that can fetch a URL.
   *
   * This is what makes "Hey Siri, Grace — turn the light off" work with the
   * app closed and the phone locked. It cannot be otherwise: no web page is
   * permitted to listen for its own name while it isn't open, on any phone, by
   * deliberate design. So the listening is done by the one thing on the device
   * that is already allowed to do it, and this is where it hands the sentence
   * over. A watch face, a car button, a desk macro and a cron job all fit the
   * same shape.
   *
   * Deliberately outside the password wall, like the bridge, and for the same
   * reason: what calls it is a program, not a person, and it carries a token
   * instead of a session. A wrong token is told "no" and nothing else.
   *
   * It runs the identical turn the browser runs — same memory, same tools,
   * same guardrails. She will no more spend money from a phone shortcut than
   * she will from her own page, and everything said this way lands in the same
   * conversation, so walking in the door and picking up where the hallway left
   * off actually works.
   */
  api.post(
    '/relay',
    guard(async (req, res) => {
      await loadKeys().catch(() => {});

      const offered = String(
        req.body?.token ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
      );
      if (!(await relayAllows(offered))) {
        // Same pause the password path takes. This door is on the open
        // internet and guessing at it should be as slow as guessing at that one.
        await pauseAfterFailure();
        res.status(401).json({error: 'no'});
        return;
      }

      /*
       * The outpost checking that a browser's token is still good.
       *
       * It asks before opening a voice session, and asking is the point: the
       * check goes through her rather than against a copy the outpost keeps,
       * so replacing the token in her side panel drops every live
       * conversation at once. A cached copy would make the "replace the
       * token" button quietly untrue, which is the worst kind of security
       * control — one that reports success and does nothing.
       */
      if (req.body?.probe) {
        res.json({ok: true});
        return;
      }

      /*
       * A single tool call, arriving from the voice.
       *
       * The model holding the spoken conversation lives on the outpost and
       * has her tool list, but none of her hands. When it decides to turn a
       * light off, the decision comes here and is carried out by exactly the
       * code that would have carried it out in a typed conversation — same
       * permissions, same confirmations, same memory.
       *
       * The alternative was letting the outpost own a copy of the tools,
       * which would work on the first day and drift within a week. The drift
       * would surface as her denying she had done something she had just
       * done, and it would be nearly impossible to reproduce.
       */
      /*
       * The outpost asking who she is.
       *
       * The spoken conversation runs on another machine, in a model session
       * that machine holds. It is briefed from here — the same prompt, the
       * same tool list, the same memory — so that the voice is her and not a
       * nameless model with no hands wearing her voice. Asked for at the
       * start of every session, because what she knows changes between them.
       */
      if (req.body?.brief) {
        const brief = await briefFor('voice');
        res.json({system: brief.system, tools: brief.tools});
        return;
      }

      /*
       * The outpost handing back what was said.
       *
       * Both halves of a spoken exchange land in the same log as a typed one,
       * so the next thing anyone types knows what was just said aloud. And
       * the exchange is learned from, the way a typed one is — otherwise she
       * would remember nothing you ever told her by voice, which is most of
       * what you tell her.
       */
      const heard = String(req.body?.heard ?? '').trim().slice(0, 4000);
      const said = String(req.body?.said ?? '').trim().slice(0, 8000);
      if (req.body?.record) {
        if (heard) await remember('user', heard, 'voice');
        if (said) await remember('grace', said, 'voice');
        if (heard && said && worthLearningFrom(heard)) {
          // Fire and forget: learning is worth doing and never worth making
          // the voice wait for.
          void learnFrom(heard, said).catch(() => {});
        }
        await noteRelayUse();
        contextCache = null;
        res.json({ok: true});
        return;
      }

      const calling = String(req.body?.tool ?? '').trim();
      if (calling) {
        const args = (req.body?.args ?? {}) as Record<string, unknown>;
        if (!allTools().some((tool) => tool.name === calling)) {
          res.json({result: `I have no tool called ${calling}.`});
          return;
        }
        try {
          res.json({result: (await runTool({name: calling, args})).result});
        } catch (error) {
          // Handed back as a result rather than thrown, so the model can say
          // what went wrong out loud instead of the conversation dying.
          res.json({result: `That failed: ${(error as Error).message}`});
        }
        return;
      }

      const text = String(req.body?.text ?? '').trim().slice(0, 2000);
      if (!text) {
        // Siri hands over an empty string when it mishears silence, and it does
        // that often enough that a 400 would be the usual outcome. Answering
        // with something sayable is better than an error tone.
        res.json({reply: 'I didn’t catch that.', spoken: 'I didn’t catch that.', acted: [], open: []});
        return;
      }

      const open: string[] = [];
      const outcome = await takeTurn({
        text,
        // Spoken, because it is: she should answer the way she answers out
        // loud, not the way she writes on screen.
        via: 'voice',
        hooks: {onOpened: (urls) => open.push(...urls)},
      });

      if (outcome.error && !outcome.reply.trim()) {
        res.json({reply: outcome.error, spoken: outcome.error, acted: [], open: []});
        return;
      }

      await noteRelayUse();
      contextCache = null;

      res.json({
        reply: outcome.reply,
        // What to read aloud, with the markdown taken out of it.
        spoken: forSpeaking(outcome.reply),
        acted: outcome.acted,
        // Shortcuts can open these itself, which is the only way opening a page
        // can work when her own tab isn't the thing being spoken to.
        open,
      });
    }),
  );

  // ---- everything below needs a session ----------------------------------

  api.use(requireAuth);

  // Stored keys are read before any route that might need one, so a key pasted
  // into Grace takes effect on the very next request. A failure here must not
  // block the request: she falls back to the environment.
  api.use((_req, _res, next) => {
    loadKeys().then(
      () => next(),
      () => next(),
    );
  });

  api.get(
    '/state',
    guard(async (_req, res) => {
      const [messages, profile, policies, mode, summary] = await Promise.all([
        getMessages(),
        getProfile(),
        getPolicies(),
        getMode(),
        getSummary(),
      ]);

      const money = await spend();
      const now = await standing();
      const state: GraceState = {
        messages,
        profile,
        policies,
        ready: isConfigured(),
        model: config.model,
        // How many she actually has, counted rather than written down. The
        // panel shows this, and a hardcoded number would drift the first time
        // a tool was added and then be quietly wrong forever.
        tools: allTools().length,
        mode,
        summary,
        storage: {backend: getBackend().name, encrypted: Boolean(config.secret)},
        spend: {
          dollars: Math.round(money.dollars * 100) / 100,
          cap: now.limit,
          // Which pot this is coming out of, and how far through the funded
          // window she is. A bare number of dollars spent says nothing about
          // whether that is on track or alarming.
          against: now.against,
          pool: Math.round(now.spent * 100) / 100,
          remaining: Math.round(now.remaining * 100) / 100,
          elapsed: now.elapsed === null ? null : Math.round(now.elapsed * 100) / 100,
          requests: money.requests,
          byModel: Object.fromEntries(
            Object.entries(money.byModel ?? {}).map(([model, dollars]) => [
              model,
              Math.round(dollars * 1000) / 1000,
            ]),
          ),
        },
      };
      res.json(state);
    }),
  );

  api.get(
    '/keys',
    guard(async (_req, res) => {
      res.json(await keyStatus());
    }),
  );

  api.post(
    '/keys',
    guard(async (req, res) => {
      const allowed = [
        'gemini',
        'govee',
        'googleClientId',
        'googleClientSecret',
        'ownerEmail',
        'psn',
        'github',
        'n8n',
        'n8nUrl',
        'voice',
      ] as const;
      const name = String(req.body?.name ?? '') as (typeof allowed)[number];
      if (!allowed.includes(name)) {
        res.status(400).json({error: 'unknown key'});
        return;
      }
      await setKey(name, String(req.body?.value ?? ''));
      // Pasting a key is how a tool comes into existence for her, so the
      // cached picture of what is connected has to go with it.
      forgetAvailable();
      // And so does the device list it fetched. A new Govee key is usually a
      // different Govee account, and a minute of answering about the previous
      // account's lights — none of which respond — looks exactly like the key
      // not working.
      if (name === 'govee') forgetLights();
      // Never echoed back — the status says whether one is set, not what it is.
      res.json(await keyStatus());
    }),
  );

  api.post(
    '/mode',
    guard(async (req, res) => {
      const requested = req.body?.mode;
      if (!isMode(requested)) {
        res.status(400).json({error: 'unknown mode'});
        return;
      }
      res.json(await setMode(requested));
    }),
  );

  api.post(
    '/chat',
    guard(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      const via: InputMode = req.body?.via === 'voice' ? 'voice' : 'text';

      if (!text) {
        res.status(400).json({error: 'message was empty'});
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Stops proxies from buffering the stream into a single lump.
        'X-Accel-Buffering': 'no',
      });

      const send = (event: ChatEvent) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const controller = new AbortController();
      res.on('close', () => controller.abort());

      const outcome = await takeTurn({
        text,
        via,
        signal: controller.signal,
        hooks: {
          onDelta: (delta) => send({type: 'delta', text: delta}),
          onSearched: () => send({type: 'searched'}),
          onSearchFailed: (reason) => send({type: 'search-failed', reason}),
          onActed: (name, summary) => send({type: 'acted', name, summary}),
          onAsked: (question, choices) => send({type: 'asked', question, choices}),
          onOpened: (urls, workspace) => send({type: 'open', urls, workspace}),
        },
      });

      if (outcome.error) {
        send({type: 'error', message: outcome.error});
        res.end();
        return;
      }

      send({type: 'done', message: outcome.message!});
      // The conversation has moved on, so the hint the transcriber works from
      // has to move with it — a stale one misses the name just mentioned.
      contextCache = null;
      res.end();
    }),
  );

  /**
   * Profile extraction and compaction, as their own request.
   *
   * These used to run inside /chat, which was fine for a long-lived process but
   * pushes a serverless invocation towards its time limit for work the user is
   * not waiting on. The client calls this once a reply has landed.
   */
  api.post(
    '/reflect',
    guard(async (_req, res) => {
      if (!isConfigured()) {
        res.json({learned: [], compacted: false});
        return;
      }

      const log = await getMessages();
      const graceAt = log.findLastIndex((message) => message.speaker === 'grace');
      const userAt = log
        .slice(0, Math.max(graceAt, 0))
        .findLastIndex((message) => message.speaker === 'user');

      // A sweep every sixth exchange catches whatever the cheap gate missed;
      // in between, trivial turns cost nothing at all.
      const sweep = log.length % 12 < 2;
      const learned =
        graceAt >= 0 && userAt >= 0 && worthLearningFrom(log[userAt].text, sweep)
          ? await learnFrom(log[userAt].text, log[graceAt].text)
          : [];

      // If this times out the condition persists, so the next reflect retries.
      const compacted = await compactIfNeeded();

      // Reading the sent folder to see how they write belongs here, behind the
      // reply, and it no-ops until the description is a week old.
      learnWritingStyle().catch(() => {});

      res.json({learned, compacted});
    }),
  );

  /**
   * Spoken audio in, text out.
   *
   * The browser records; the transcription happens here. That is the whole
   * point: it works in browsers with no speech recognition of their own, and a
   * failure produces an error we can actually read rather than silence.
   */
  api.post(
    '/transcribe',
    guard(async (req, res) => {
      if (!isConfigured()) {
        res.status(503).json({error: 'No Gemini API key is configured.'});
        return;
      }

      const audio = String(req.body?.audio ?? '');
      const mimeType = String(req.body?.mimeType ?? 'audio/wav');

      if (!audio) {
        res.status(400).json({error: 'no audio was sent'});
        return;
      }

      try {
        const text = await getProvider().transcribe({
          audio,
          mimeType,
          context: await listeningContext(),
        });
        res.json({text});
      } catch (error) {
        // Providers return a wall of JSON. Keep it in the log and say
        // something the person holding the microphone can act on.
        const detail = (error as Error).message ?? 'unknown error';
        console.error('[grace] transcription failed:', detail);

        const explained = /API[_ ]?KEY|not valid|UNAUTHENTICATED/i.test(detail)
          ? 'My API key was rejected. Check GEMINI_API_KEY where I am running.'
          : /quota|RESOURCE_EXHAUSTED|rate/i.test(detail)
            ? 'I have hit the daily limit on my free allowance. It resets tomorrow.'
            : 'I could not make out that recording. Try again, a little closer to the microphone.';

        res.status(502).json({error: explained});
      }
    }),
  );

  // ---- Google -----------------------------------------------------------
  api.get('/google-status', guard(async (_req, res) => {
    const saved = await connection();
    const missing = await missingScopes();
    res.json({
      configured: googleConfigured(),
      connected: Boolean(saved && !saved.brokenReason),
      email: saved?.email ?? null,
      // A connection made before a power was added keeps working for everything
      // it was granted and fails with an unreadable 403 for the new part. Said
      // as a problem, it reads as one sentence and one button.
      problem:
        saved?.brokenReason ??
        (missing.length > 0
          ? 'She has learned to file and label your mail since you connected. ' +
            'Reconnect once to let her.'
          : null),
      redirectUri: redirectUri(),
    });
  }));

  api.get('/google-start', (req, res) => {
    if (!googleConfigured()) {
      res.status(503).json({
        error: 'Google is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      });
      return;
    }
    void req;
    res.redirect(authorizeUrl());
  });

  // Google sends the browser here, so it answers in HTML rather than JSON.
  api.get('/google-callback', guard(async (req, res) => {
    // Everything on this page is escaped. The session cookie is SameSite=Lax,
    // so a top-level navigation carries it, which would make a reflected
    // parameter here enough to run script on Grace's own origin against a
    // signed-in user and read the entire conversation.
    const escape = (value: string) =>
      value.replace(
        /[&<>"']/g,
        (character) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[character] as string,
      );

    const finish = (message: string) =>
      res.status(200).send(
        `<!doctype html><meta charset="utf-8"><title>Grace</title>` +
          `<body style="background:#07090c;color:#e2e8f0;font-family:system-ui;` +
          `display:grid;place-items:center;height:100vh;margin:0;text-align:center">` +
          `<div><p style="max-width:32rem;line-height:1.6">${escape(message)}</p>` +
          `<a href="/" style="color:#7dd3fc">Back to Grace</a></div>`,
      );

    if (req.query.error) {
      console.error('[grace] google declined:', String(req.query.error));
      finish('Google declined the connection. Nothing has changed.');
      return;
    }

    try {
      const {email} = await completeSignIn(
        String(req.query.code ?? ''),
        String(req.query.state ?? ''),
      );
      // Her mail and diary tools come into existence here.
      forgetAvailable();
      finish(`Connected as ${email || 'your Google account'}. You can close this.`);
    } catch (error) {
      finish(`Could not connect: ${(error as Error).message}`);
    }
  }));

  api.post('/google-disconnect', guard(async (_req, res) => {
    await disconnect();
    // Nine tools just stopped existing; she should not be offered them.
    forgetAvailable();
    res.json({ok: true});
  }));

  api.get('/google-mail', guard(async (req, res) => {
    try {
      res.json({
        messages: await recentMail(String(req.query.q ?? 'in:inbox'), 10),
      });
    } catch (error) {
      const failure = error as GoogleError;
      res.status(failure.needsReconnect ? 409 : 502).json({error: failure.message});
    }
  }));

  api.get('/google-diary', guard(async (_req, res) => {
    try {
      res.json({events: await upcoming(24)});
    } catch (error) {
      const failure = error as GoogleError;
      res.status(failure.needsReconnect ? 409 : 502).json({error: failure.message});
    }
  }));

  /** The token the laptop needs, and whether it has been heard from. */
  api.get(
    '/bridge-status',
    guard(async (_req, res) => {
      res.json({token: await bridgeToken(), ...(await bridgeStatus())});
    }),
  );

  api.post(
    '/bridge-roll',
    guard(async (_req, res) => {
      res.json({token: await rollBridgeToken()});
    }),
  );

  api.get(
    '/relay-key',
    guard(async (req, res) => {
      // The full URL is assembled here rather than in the browser, because the
      // thing that has to be typed into a phone must be the address that
      // actually works — not one guessed from whatever the page thinks it is.
      res.json({
        token: await relayToken(),
        url: relayUrl(req.headers['x-forwarded-host'], req.headers.host, config.deployed),
        ...(await relayStatus()),
      });
    }),
  );

  /*
   * Where to talk to her, and what to say to be let in.
   *
   * The token is the relay's, deliberately — one key for everything that
   * reaches her from outside her own page, so that replacing it in the side
   * panel closes every door at once rather than most of them. Two tokens
   * would mean rolling one and believing you were safe.
   *
   * `live` is false when no outpost is configured, which is a normal state
   * and not an error: she then speaks the older way, by recording and
   * replying. The browser needs to know which, because the two are entirely
   * different pieces of machinery on its side.
   */
  api.get(
    '/voice-key',
    guard(async (_req, res) => {
      res.json({
        live: Boolean(config.outpost),
        url: config.outpost,
        token: config.outpost ? await relayToken() : null,
        model: config.liveModel,
      });
    }),
  );

  api.post(
    '/relay-roll',
    guard(async (_req, res) => {
      res.json({token: await rollRelayToken()});
    }),
  );

  // ---- what she keeps ----------------------------------------------------

  api.get(
    '/notes',
    guard(async (_req, res) => {
      res.json({notes: await liveNotes()});
    }),
  );

  /** The user correcting what she wrote — the whole point of notes they can see. */
  api.post(
    '/note-save',
    guard(async (req, res) => {
      res.json({
        notes: await saveNoteBody(
          String(req.body?.id ?? ''),
          String(req.body?.title ?? ''),
          String(req.body?.body ?? ''),
        ),
      });
    }),
  );

  api.post(
    '/note-archive',
    guard(async (req, res) => {
      res.json({notes: await archiveNote(String(req.body?.id ?? ''))});
    }),
  );

  api.get(
    '/files',
    guard(async (_req, res) => {
      // The text is not sent back — a list is for choosing, not re-reading a
      // contract into the browser. Name and size are enough.
      const files = await liveFiles();
      res.json({
        files: files.map((file) => ({id: file.id, name: file.name, chars: file.chars})),
      });
    }),
  );

  api.post(
    '/file-add',
    guard(async (req, res) => {
      try {
        const file = await addFile(String(req.body?.name ?? ''), String(req.body?.text ?? ''));
        res.json({ok: true, id: file.id, name: file.name, chars: file.chars});
      } catch (error) {
        res.status(400).json({error: (error as Error).message});
      }
    }),
  );

  api.post(
    '/file-archive',
    guard(async (req, res) => {
      await archiveFile(String(req.body?.id ?? ''));
      res.json({ok: true});
    }),
  );

  api.get(
    '/situations',
    guard(async (_req, res) => {
      res.json({situations: await allSituations()});
    }),
  );

  api.get(
    '/timers',
    guard(async (_req, res) => {
      res.json({timers: await runningTimers()});
    }),
  );

  /** The client rang it; never ring the same timer twice. */
  api.post(
    '/timer-fired',
    guard(async (req, res) => {
      await markFired(String(req.body?.id ?? ''));
      res.json({ok: true});
    }),
  );

  api.get(
    '/watches',
    guard(async (_req, res) => {
      res.json({watches: await liveWatches()});
    }),
  );

  /**
   * Whose voice she answers to.
   *
   * The print goes out to the browser deliberately: the comparison happens
   * there, on audio it already holds, so nothing said in the room ever travels
   * to be identified. Two dozen numbers describing the shape of a voice cannot
   * be turned back into a recording, and the alternative — uploading every
   * sound in the room to ask whether it was you — is a far worse bargain than
   * the problem it solves.
   */
  /**
   * The typed commands.
   *
   * Kept off the chat route on purpose. These are instructions to the
   * machinery rather than things said to her — they do not belong in the
   * conversation, should not be interpreted by a model that might decline, and
   * two of them cost real money in a way a sentence does not.
   */
  api.post(
    '/research',
    guard(async (req, res) => {
      if (!isConfigured()) {
        res.status(503).json({error: 'No Gemini API key is configured.'});
        return;
      }
      try {
        const found = await research(String(req.body?.topic ?? ''));
        res.json(found);
      } catch (error) {
        res.status(400).json({error: (error as Error).message});
      }
    }),
  );

  api.get(
    '/chats',
    guard(async (_req, res) => {
      res.json({chats: await allChats(), current: await currentChat()});
    }),
  );

  api.post(
    '/chat-new',
    guard(async (_req, res) => {
      const chat = await newChat();
      res.json({chat, chats: await allChats(), current: chat.id});
    }),
  );

  api.post(
    '/chat-open',
    guard(async (req, res) => {
      const current = await openChat(String(req.body?.id ?? ''));
      res.json({current, chats: await allChats()});
    }),
  );

  api.post(
    '/chat-rename',
    guard(async (req, res) => {
      const chats = await rename(String(req.body?.id ?? ''), String(req.body?.title ?? ''));
      res.json({chats});
    }),
  );

  api.post(
    '/chat-archive',
    guard(async (req, res) => {
      const chats = await archiveChat(String(req.body?.id ?? ''));
      res.json({chats, current: await currentChat()});
    }),
  );

  api.post(
    '/compact',
    guard(async (_req, res) => {
      // Forced rather than "if needed": asking for it is the whole point, and
      // being told "not yet" by something you deliberately typed is useless.
      const folded = await compactNow();
      res.json({folded, summary: await getSummary()});
    }),
  );

  api.get(
    '/voice-guard',
    guard(async (_req, res) => {
      res.json(await voiceGuard());
    }),
  );

  api.post(
    '/voice-enrol',
    guard(async (req, res) => {
      const enrolment = req.body?.enrolment;
      if (!isEnrolment(enrolment)) {
        res.status(400).json({error: 'that is not a usable voiceprint'});
        return;
      }
      res.json(await enrol(enrolment));
    }),
  );

  api.post(
    '/voice-set',
    guard(async (req, res) => {
      const strictness = req.body?.strictness;
      res.json(
        await setGuard({
          ...(typeof req.body?.on === 'boolean' ? {on: req.body.on} : {}),
          ...(strictness === 'lenient' || strictness === 'normal' || strictness === 'strict'
            ? {strictness}
            : {}),
        }),
      );
    }),
  );

  api.post(
    '/voice-forget',
    guard(async (_req, res) => {
      res.json(await forgetVoice());
    }),
  );

  api.get(
    '/weather',
    guard(async (_req, res) => {
      if (!isConfigured()) {
        res.json({line: null});
        return;
      }
      res.json({line: await weatherLine().catch(() => null)});
    }),
  );

  // ---- the working world -------------------------------------------------

  api.get(
    '/github-view',
    guard(async (_req, res) => {
      if (!githubConfigured()) {
        res.json({configured: false});
        return;
      }
      try {
        res.json({configured: true, ...(await githubView())});
      } catch (error) {
        const failure = error as GithubError;
        res.status(failure.needsToken ? 409 : 502).json({error: failure.message});
      }
    }),
  );

  api.get(
    '/n8n-view',
    guard(async (_req, res) => {
      if (!n8nConfigured()) {
        res.json({configured: false});
        return;
      }
      try {
        res.json({configured: true, ...(await n8nView())});
      } catch (error) {
        const failure = error as N8nError;
        res.status(failure.needsKey ? 409 : 502).json({error: failure.message});
      }
    }),
  );

  // ---- the rooms of the app ----------------------------------------------

  api.get(
    '/workspaces',
    guard(async (_req, res) => {
      res.json({workspaces: await workspaces()});
    }),
  );

  api.post(
    '/workspace-save',
    guard(async (req, res) => {
      res.json({workspaces: await saveWorkspace(req.body ?? {})});
    }),
  );

  api.post(
    '/workspace-hide',
    guard(async (req, res) => {
      res.json({workspaces: await hideWorkspace(String(req.body?.id ?? ''))});
    }),
  );

  // ---- the PlayStation ---------------------------------------------------

  /**
   * What the console is doing.
   *
   * Reading only, and not by choice: Sony's app API shows the console, it does
   * not operate it. Switching a PS5 on happens over the local network, which
   * is somewhere a server in a data centre cannot reach.
   */
  api.get(
    '/ps5',
    guard(async (_req, res) => {
      if (!psnConfigured()) {
        res.json({configured: false});
        return;
      }
      try {
        const [state, games] = await Promise.all([
          playstation(),
          recentlyPlayed(5).catch(() => []),
        ]);
        res.json({configured: true, ...state, recent: games});
      } catch (error) {
        const failure = error as PsnError;
        res.status(failure.needsToken ? 409 : 502).json({
          configured: true,
          error: failure.message,
        });
      }
    }),
  );

  // ---- reaching the phone ------------------------------------------------

  api.get(
    '/push-key',
    guard(async (_req, res) => {
      res.json({key: await publicKey(), devices: await devices()});
    }),
  );

  api.post(
    '/push-subscribe',
    guard(async (req, res) => {
      const result = await subscribe(req.body?.subscription);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json({ok: true, devices: await devices()});
    }),
  );

  /** Proves the whole chain, which is the only way anyone trusts it. */
  api.post(
    '/push-test',
    guard(async (_req, res) => {
      const sent = await notify('Grace', 'That reached you. Everything is working.');
      res.json({sent});
    }),
  );

  /**
   * What she says when you walk in, at most once every few hours.
   *
   * Costs nothing on an ordinary reopen — the ration is checked before any
   * model is reached for.
   */
  api.post(
    '/greeting',
    guard(async (_req, res) => {
      if (!isConfigured()) {
        res.json({say: null});
        return;
      }

      res.json(
        await greet(async (context) =>
          getProvider().complete({
            system:
              'You are Grace, a composed personal assistant. The person you ' +
              'work for has just opened you. Greet them in one short sentence ' +
              'and, in the same breath, tell them the single most useful thing ' +
              'from what follows — the next thing in their diary, or what is ' +
              'overdue. If there is genuinely nothing, say only that the day ' +
              'looks clear. No lists, no markdown, no preamble, never more ' +
              'than two sentences.',
            turns: [{role: 'user', text: context}],
            temperature: 0.5,
            maxOutputTokens: 150,
            fast: true,
          }),
        ),
      );
    }),
  );

  // ---- her own initiative ------------------------------------------------

  /**
   * One look around, unprompted.
   *
   * The client calls this every few minutes while it is open. It costs nothing
   * when nothing has changed — the language model is only reached for when
   * there is genuinely something new to say — so it can run all day on a
   * ten-dollar budget.
   */
  api.post(
    '/pulse',
    guard(async (_req, res) => {
      if (!isConfigured()) {
        res.json({concerns: [], say: null, held: null});
        return;
      }
      res.json(await pulse());
    }),
  );

  /**
   * The journal alone, for the live activity feed.
   *
   * The feed used to poll /day for this, which fans out to Google and the
   * console — a whole day's aggregation pulled every minute to render seven
   * lines of deeds. This reads one document and nothing else.
   */
  api.get(
    '/journal',
    guard(async (_req, res) => {
      res.json({deeds: await recentDeeds(20)});
    }),
  );

  /**
   * The three questions the dashboard exists to answer: what does my day look
   * like, what needs me, and what has she been doing.
   */
  api.get(
    '/day',
    guard(async (_req, res) => {
      const google = await connection().catch(() => null);
      const connected = Boolean(google && !google.brokenReason);

      const [events, mail, list, deeds, console_] = await Promise.all([
        connected ? upcoming(24, 8).catch(() => []) : Promise.resolve([]),
        connected
          ? recentMail('in:inbox is:unread category:primary newer_than:2d', 6).catch(
              () => [],
            )
          : Promise.resolve([]),
        outstanding().catch(() => []),
        recentDeeds(20).catch(() => []),
        psnConfigured() ? playstation().catch(() => null) : Promise.resolve(null),
      ]);

      res.json({
        google: connected,
        events,
        mail,
        // Only what is actually wanted soon. A list of everything outstanding
        // is a list; the point of this panel is the shortlist.
        reminders: list.slice(0, 8),
        deeds,
        playstation: console_?.presence ?? null,
      });
    }),
  );

  /**
   * Does the web actually work, and does she actually reach for it?
   *
   * Two different failures look identical from the outside: grounding being
   * refused, and the model simply never choosing to search. This runs both
   * halves separately and reports each in the provider's own words, because
   * guessing between them has already cost days.
   */
  api.post(
    '/web-check',
    guard(async (_req, res) => {
      const report: Record<string, unknown> = {model: config.model};

      // Half one: can this key ground at all?
      try {
        const answer = await getProvider().complete({
          system: 'Answer in one short sentence.',
          turns: [{role: 'user', text: 'What is today\'s date and one news headline?'}],
          search: true,
          temperature: 0,
        });
        report.grounding = 'ok';
        report.groundedAnswer = answer.slice(0, 300);
      } catch (error) {
        report.grounding = 'failed';
        report.groundingError = (error as Error).message.slice(0, 500);
      }

      // Half two: given the tool, does she pick it up?
      const called: string[] = [];
      try {
        let reply = '';
        for await (const delta of getProvider().stream({
          system:
            'You are a helpful assistant with tools. Use them when they apply.',
          turns: [{role: 'user', text: 'What is the weather in London right now?'}],
          tools: declarations(),
          onToolCall: async (name, args) => {
            called.push(name);
            return (await runTool({name, args})).result;
          },
        })) {
          reply += delta;
        }
        report.toolsOffered = declarations().map((tool) => tool.name);
        report.toolsCalled = called;
        report.reachedForTheWeb = called.includes('search_web');
        report.reply = reply.slice(0, 300);
      } catch (error) {
        report.toolCalling = 'failed';
        report.toolError = (error as Error).message.slice(0, 500);
      }

      res.json(report);
    }),
  );

  api.post(
    '/speak',
    guard(async (req, res) => {
      if (!isConfigured()) {
        res.status(503).json({error: 'No Gemini API key is configured.'});
        return;
      }

      // A ceiling on one request, so a runaway reply cannot spend the day's
      // speech allowance in one go. The client splits a long answer into
      // pieces that fit; this used to cut silently at two thousand characters,
      // which is how she came to stop mid-word with no error anywhere. It now
      // says so when it has to cut, so the same bug can be found by reading.
      const asked = String(req.body?.text ?? '').trim();
      const text = asked.slice(0, 5000);
      if (text.length < asked.length) {
        console.error(
          `[grace] speech text was ${asked.length} characters and had to be cut. ` +
            'The client should have split it.',
        );
      }
      if (!text) {
        res.status(400).json({error: 'nothing to say'});
        return;
      }

      // An audition, not a commitment: the picker sends the voice it wants a
      // sample in, without that becoming her voice.
      const voice = String(req.body?.voice ?? '').replace(/[^a-zA-Z]/g, '').slice(0, 24);

      try {
        const spoken = await getProvider().speak({text, ...(voice ? {voice} : {})});

        /*
         * The padding comes off before it is sent.
         *
         * The speech model hands back the better part of a second of silence
         * after the last word. On one clip nobody notices; a reply is spoken in
         * three or four clips, so it is three or four pauses, each landing
         * exactly on a full stop — which is where a listener hears hesitation
         * rather than an encoder finishing up. Done here rather than in the
         * browser so it costs nothing to play and shrinks what goes over the
         * wire as well.
         */
        const trimmed = trimTrailingSilence(
          Buffer.from(spoken.audio, 'base64'),
        );
        res.json({
          ...spoken,
          audio: Buffer.from(trimmed).toString('base64'),
        });
      } catch (error) {
        const detail = (error as Error).message ?? 'unknown error';
        console.error('[grace] speech failed:', detail);

        const explained = /API[_ ]?KEY|not valid|UNAUTHENTICATED/i.test(detail)
          ? 'My API key was rejected. Check GEMINI_API_KEY where I am running.'
          : /quota|RESOURCE_EXHAUSTED|rate/i.test(detail)
            ? 'I have used up my speech allowance for now. It resets shortly.'
            : 'I could not put that into words out loud.';

        // The raw provider message goes back too. This is the user's own
        // server behind their own password, and without it every diagnosis of
        // a silent assistant is guesswork.
        res.status(502).json({error: explained, detail: detail.slice(0, 500)});
      }
    }),
  );

  api.post(
    '/profile-address',
    guard(async (req, res) => {
      const raw = req.body?.addressAs;
      const addressAs =
        typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 40) : null;
      res.json(await setAddressAs(addressAs));
    }),
  );

  // The id travels in the body rather than the path: every route here is a
  // single segment on purpose. See the note above the route table.
  /**
   * Correcting what she has learned.
   *
   * Supersede rather than forget: the interface can mark a fact no longer
   * true, and it drops out of what she believes while staying on the record.
   * Deleting outright is profile-forget, kept for genuine mistakes.
   */
  api.post(
    '/memory-supersede',
    guard(async (req, res) => {
      const text = String(req.body?.text ?? '');
      if (text) await supersedeEntry(text);
      res.json(await getProfile());
    }),
  );

  api.post(
    '/profile-forget',
    guard(async (req, res) => {
      const id = String(req.body?.id ?? '');
      if (!id) {
        res.status(400).json({error: 'which one?'});
        return;
      }
      res.json(await forget(id));
    }),
  );

  api.post(
    '/policies',
    guard(async (req, res) => {
      const category = req.body?.category as ActionCategory;
      const policy = req.body?.policy as ConfirmationPolicy;

      if (!['always', 'high-risk', 'never'].includes(policy)) {
        res.status(400).json({error: 'unknown confirmation policy'});
        return;
      }

      const result = await setPolicy(category, policy);
      if (!result.ok) {
        res.status(409).json({error: result.reason});
        return;
      }

      res.json(await getPolicies());
    }),
  );

  api.post(
    '/conversation-clear',
    guard(async (_req, res) => {
      await clearConversation();
      res.json({ok: true});
    }),
  );

  return api;
}
