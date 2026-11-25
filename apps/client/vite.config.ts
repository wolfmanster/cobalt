import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: { __PWA_BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4100',
    },
  },
});
