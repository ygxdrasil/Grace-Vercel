import express from 'express';
import {createApi} from '../server/api.ts';

/**
 * Grace's API as a single Vercel function.
 *
 * A catch-all rather than a rewrite, because a rewrite would rework the URL
 * before Express saw it and every route would miss. This way /api/chat arrives
 * as /api/chat.
 */
const app = express();
app.use('/api', createApi());

export default app;
