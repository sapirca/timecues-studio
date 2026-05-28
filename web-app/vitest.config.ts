import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Standalone test config so vitest does not pick up the heavy custom
// middleware in vite.config.ts (BPM proxy, song-info handlers, etc.) —
// those are dev-server only and would refuse to load in a Node test env.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
