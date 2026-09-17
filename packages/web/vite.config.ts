import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied so the browser sees one origin in dev. CORS on the
    // server is still configured and tested, because production will not proxy.
    proxy: {
      '/api': { target: process.env.VITE_API_URL ?? 'http://localhost:8787', changeOrigin: true },
      '/health': { target: process.env.VITE_API_URL ?? 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
