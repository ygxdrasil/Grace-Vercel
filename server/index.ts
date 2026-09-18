import express from 'express';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createApi} from './api';
import {config, isConfigured} from './config';
import {startHeartbeat} from './heartbeat';
import {localPolicy, SECURITY_HEADERS} from '../shared/headers';

/**
 * Production entry point. In development the same router is mounted straight
 * into the Vite dev server (see vite.config.ts), so there is one API either way.
 */
// Grace is meant to sit running for weeks. A stray rejection in background work
// should cost a log line, not the process.
process.on('unhandledRejection', (reason) => {
  console.error('[grace] unhandled rejection:', reason);
});

const app = express();

// On Vercel the page and the bundle come off a CDN that never reaches this
// code, so vercel.json declares the same list. Here so that running her
// locally is the same shape as running her deployed, rather than a laxer one
// where a mistake would go unnoticed until production.
app.use((_req, res, next) => {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(header, value);
  }
  // Her voice, when she is running here, is a socket to this machine — which
  // the deployed policy has no reason to allow and every reason not to.
  if (!config.deployed) res.setHeader('Content-Security-Policy', localPolicy());
  next();
});

app.use('/api', createApi());

const dist = path.resolve(process.cwd(), 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(config.port, () => {
  console.log(`[grace] listening on http://localhost:${config.port}`);
  console.log(`[grace] model: ${config.model}`);
  console.log(`[grace] memory: ${config.dataDir}`);

  if (!isConfigured()) {
    console.warn('[grace] GEMINI_API_KEY is not set — she cannot think yet.');
  }
  /*
   * Her heartbeat, which only exists where there is a process to hold it.
   *
   * The loop used to live in the browser, so she noticed things only while a
   * tab was open. Here it runs for as long as she does.
   */
  if (startHeartbeat()) {
    console.log('[grace] looking around on her own, hourly');
  }

  if (!process.env.GRACE_SECRET) {
    console.warn(
      '[grace] GRACE_SECRET is not set — memory is stored unencrypted.',
    );
  }
});
