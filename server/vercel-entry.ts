import express from 'express';
import {createApi} from './api';

/**
 * Source for Grace's Vercel function.
 *
 * This is not the file Vercel runs. It gets bundled into `api/[...path].js`,
 * because Vercel ships the function entry alone and leaves the rest of the
 * server behind as TypeScript that Node cannot load — every request died with
 * ERR_MODULE_NOT_FOUND on `../server/api`. Bundling ahead of time means the
 * deployed function has no relative imports left to resolve.
 *
 * Regenerate with `npm run build:api` after changing anything under server/.
 *
 * A catch-all route rather than a rewrite, so /api/chat arrives at Express as
 * /api/chat instead of being rewritten to /api and missing every route.
 */
const app = express();
app.use('/api', createApi());

export default app;
