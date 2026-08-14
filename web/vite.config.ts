import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Where /api goes when vite is serving the page.
 *
 * In production Caddy does this and none of it applies. It is a variable rather
 * than a constant so the browser tests can point a preview server at their own
 * API on another port, instead of colliding with a development one.
 */
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:4000';
const apiProxy = {
  '/api': { target: apiTarget, changeOrigin: true },
  '/uploads': { target: apiTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  // The same proxy for `vite preview`, which serves the built assets. The
  // browser tests run against that rather than the dev server, so they exercise
  // the bundle a school actually gets - including the lazily loaded admin chunk,
  // which only exists after a build.
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Mermaid is large and only needed by questions that contain a flow
        // diagram, so it is split out and loaded on demand.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          katex: ['katex'],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
});
