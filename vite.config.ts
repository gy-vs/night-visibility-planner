import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.NWB_PORT ? Number(process.env.NWB_PORT) : 4317;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
