import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest config has globals: false, so RTL's auto-cleanup hook does not run.
// Wire it up here so render() output is torn down between tests; without
// this the jsdom DOM accumulates and getByRole('textbox') sees multiple
// fields across consecutive renders.
afterEach(() => {
  cleanup();
});
