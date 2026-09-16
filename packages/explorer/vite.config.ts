import { fundPlugin } from './fund-plugin';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The explorer talks same-origin (/v0/...) and vite proxies to the
// coordinator, so the browser never cares which port the coordinator is on.
// Point BTE_URL somewhere else if 8080 is taken:
//   BTE_URL=http://localhost:18080 pnpm dev
const target = process.env.BTE_URL ?? 'http://localhost:8080';
// The Peal Links node (ledger, requests, inbox) serves /links/v1 on its own
// port; same-origin through the proxy, like /v0 and /v1.
const links = process.env.LINKS_URL ?? 'http://localhost:8790';

export default defineConfig({
  // The explorer stays a vanilla-TS app; React + Tailwind are only pulled in
  // by the landing route (src/pages/landing.tsx), which mounts a React island.
  plugins: [fundPlugin(), react(), tailwindcss()],
  server: {
    proxy: {
      '/v0': { target, changeOrigin: true },
      '/v1': { target, changeOrigin: true },
      '/links': { target: links, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/v0': { target, changeOrigin: true },
      '/v1': { target, changeOrigin: true },
      '/links': { target: links, changeOrigin: true },
    },
  },
});
