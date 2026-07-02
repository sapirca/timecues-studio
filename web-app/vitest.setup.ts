import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom under our Node/vitest setup does not expose a working `localStorage`
// (it's undefined even via `window`, because the default document origin is
// opaque). Services like capabilities.ts read/write it, so provide a minimal
// in-memory Storage polyfill when the global is missing. Mirrors the real
// Storage contract closely enough for the cache tests.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear: () => { store.clear(); },
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => { store.delete(key); },
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  globalThis.localStorage = storage;
}

// vitest config has globals: false, so RTL's auto-cleanup hook does not run.
// Wire it up here so render() output is torn down between tests; without
// this the jsdom DOM accumulates and getByRole('textbox') sees multiple
// fields across consecutive renders.
afterEach(() => {
  cleanup();
});
