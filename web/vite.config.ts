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
    // Mermaid is 679 kB and only needed when a diagram actually renders.
    // Vite would otherwise emit a modulepreload link for it in index.html —
    // eagerly downloading the whole library on every page load, including
    // student phones on school Wi-Fi. Stripped from HTML preloads; the dynamic
    // import in BlockRenderer still preloads it at the moment it is needed.
    modulePreload: {
      resolveDependencies(filename, deps, { hostType }) {
        return hostType === 'html' ? deps.filter((d) => !d.includes('mermaid')) : deps;
      },
    },
    rollupOptions: {
      output: {
        // Mermaid and KaTeX are large and only needed when rendering
        // maths/diagrams — split so dashboard first paint stays small on
        // school Wi-Fi.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          katex: ['katex'],
          mermaid: ['mermaid'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
