import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During local dev the React app runs on :5173 and proxies /api to the
// Node queue server on :4000. In production the app is static and talks to
// the same origin (Vercel function or the single-service Node deploy).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
