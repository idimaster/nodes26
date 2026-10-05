import { defineConfig } from 'vite';

// The gate server serves viz/dist (T4.2). In dev, `vite` proxies /api to it.
export default defineConfig({
  root: __dirname,
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.GATE_PORT ?? '4646'}` } },
});
