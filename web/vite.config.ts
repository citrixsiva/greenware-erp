import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API listens on 8080. Everything under /api is proxied so the browser only ever talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: { sourcemap: false, target: 'es2022' },
});
