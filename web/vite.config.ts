import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Offline app shell + push notifications. The service worker source is src/sw.ts:
    // once the page has been opened over HTTPS the browser keeps a copy of the HTML, scripts
    // and styles (a DNS hiccup shows the app reconnecting instead of "server not found"), and
    // the worker shows notifications pushed by the agent, opening the right chat on tap.
    // Nothing dynamic is cached: conversations only travel over the WebSocket to the PC.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      manifest: false, // public/manifest.webmanifest is hand-written
      includeAssets: ['favicon.svg', 'manifest.webmanifest'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
      },
    }),
  ],
  server: { port: 5173 },
  build: { target: 'es2020', sourcemap: false },
});
