import express, {type Express, type Request, type Response} from 'express';
import type {
  ActionCategory,
  ChatEvent,
  ConfirmationPolicy,
  GraceState,
  InputMode,
} from '../shared/types.ts';
import {getPolicies, setPolicy} from './actions.ts';
import {
  authStatus,
  checkPassword,
  clearSession,
  issueSession,
  pauseAfterFailure,
  requireAuth,
} from './auth.ts';
import {config, isConfigured} from './config.ts';
import {learnFrom} from './learn.ts';
import {getProvider} from './llm/index.ts';
import {
  clearConversation,
  compactIfNeeded,
  forget,
  getMessages,
  getProfile,
  getSummary,
  record,
  recentTurns,
  setAddressAs,
} from './memory.ts';
import {buildSystemPrompt} from './persona.ts';
import {getBackend} from './store/index.ts';

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

const NO_KEY_MESSAGE =
  'No Gemini API key is configured, so I have no voice to think with. ' +
  'Add GEMINI_API_KEY and restart me.';

/**
 * A full express app rather than a bare Router: Vite's dev middleware hands over
 * a plain Node response, and it is express itself — not Router — that adds
 * res.json and friends. Mounting the app works in dev, production and serverless.
 */
export function createApi(): Express {
  const api = express();
  api.use(express.json({limit: '1mb'}));

  // ---- open endpoints ----------------------------------------------------

  api.get('/health', (_req, res) => {
    res.json({
      ok: true,
      configured: isConfigured(),
      model: config.model,
      storage: getBackend().name,
      encrypted: Boolean(config.secret),
    });
  });

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

  // ---- everything below needs a session ----------------------------------

  api.use(requireAuth);

  api.get(
    '/state',
    guard(async (_req, res) => {
      const [messages, profile, policies] = await Promise.all([
        getMessages(),
        getProfile(),
        getPolicies(),
      ]);

      const state: GraceState = {
        messages,
        profile,
        policies,
        ready: isConfigured(),
        model: config.model,
      };
      res.json(state);
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

      if (!isConfigured()) {
        send({type: 'error', message: NO_KEY_MESSAGE});
        res.end();
        return;
      }

      const controller = new AbortController();
      res.on('close', () => controller.abort());

      await record('user', text, via);

      const [profile, summary, policies, turns] = await Promise.all([
        getProfile(),
        getSummary(),
        getPolicies(),
        recentTurns(),
      ]);

      const system = buildSystemPrompt({
        profile,
        summary,
        policies,
        via,
        now: new Date(),
      });

      let reply = '';

      try {
        for await (const delta of getProvider().stream({
          system,
          turns,
          signal: controller.signal,
          temperature: 0.7,
          fast: true,
        })) {
          reply += delta;
          send({type: 'delta', text: delta});
        }
      } catch (error) {
        const message = (error as Error).message ?? 'unknown error';
        console.error('[grace] generation failed:', message);

        // A half-finished reply is still worth keeping; the user heard it.
        if (reply.trim()) await record('grace', reply, via);
        send({
          type: 'error',
          message: `I couldn't finish that thought — ${message}`,
        });
        res.end();
        return;
      }

      if (!reply.trim()) {
        send({type: 'error', message: 'I drew a blank there. Try me again.'});
        res.end();
        return;
      }

      send({type: 'done', message: await record('grace', reply, via)});
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

      const learned =
        graceAt >= 0 && userAt >= 0
          ? await learnFrom(log[userAt].text, log[graceAt].text)
          : [];

      // If this times out the condition persists, so the next reflect retries.
      const compacted = await compactIfNeeded();
      res.json({learned, compacted});
    }),
  );

  api.post(
    '/profile/address',
    guard(async (req, res) => {
      const raw = req.body?.addressAs;
      const addressAs =
        typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 40) : null;
      res.json(await setAddressAs(addressAs));
    }),
  );

  api.delete(
    '/profile/:id',
    guard(async (req, res) => {
      res.json(await forget(req.params.id));
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
    '/conversation/clear',
    guard(async (_req, res) => {
      await clearConversation();
      res.json({ok: true});
    }),
  );

  return api;
}
