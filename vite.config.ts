import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

/**
 * Mounts Grace's API into the dev server so `npm run dev` is a single process
 * and the API key never reaches the browser. Production uses server/index.ts,
 * which mounts the very same router.
 */
function graceApi(): Plugin {
  return {
    name: 'grace-api',
    async configureServer(server) {
      const {createApi} = await server.ssrLoadModule('/server/api.ts');
      server.middlewares.use('/api', createApi());
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), graceApi()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
