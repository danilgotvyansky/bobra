import { defineConfig } from 'vite';

export default defineConfig({
  // Assets must be served under /dashboard/ so the router forwards them to this worker
  base: '/dashboard/',
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
  },
});
