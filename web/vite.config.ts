import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Offline app shell: once the page has been opened over HTTPS, the browser keeps a copy
    // of the HTML, scripts and styles. A DNS hiccup or a flaky network then shows the app
    // (reconnecting) instead of the browser's "server not found" page. Nothing dynamic is
    // cached: conversations only travel over the WebSocket to the user's own PC.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false, // public/manifest.webmanifest is hand-written
      includeAssets: ['favicon.svg', 'manifest.webmanifest'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
  server: { port: 5173 },
  build: { target: 'es2020', sourcemap: false },
});
