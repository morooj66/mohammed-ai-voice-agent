import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// draft-public/ (unapproved draft recording) is served ONLY by the local dev server, never copied into a build.
export default defineConfig(({ command }) => ({ root: 'preview', envDir: false, publicDir: command === 'serve' ? 'draft-public' : false, plugins: [react()], build: { outDir: '../preview-dist', emptyOutDir: false }, server: { host: '127.0.0.1' } }));
