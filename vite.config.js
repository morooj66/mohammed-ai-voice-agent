import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The token server (server/token-server.mjs) holds the ElevenLabs API key.
// The browser only ever talks to /api on this origin; the key never reaches the frontend.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.DEMO_API_PORT || '8787'}`,
    },
  },
});
