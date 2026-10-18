import { defineConfig } from 'vite';

// Relative base so the build runs from any folder or server path (static host now, intranet later).
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
  worker: { format: 'es' },
});
