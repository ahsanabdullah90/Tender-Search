import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertSafeTestDataDir } from './test-env.js';

if (!process.env.TENDER_DATA_DIR) {
  const globalTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ui-temp-'));
  process.env.TENDER_DATA_DIR = globalTemp;
}

assertSafeTestDataDir();

afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => {
      const listeners: ((e: any) => void)[] = [];
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: (cb: any) => listeners.push(cb),
        removeListener: (cb: any) => {
          const idx = listeners.indexOf(cb);
          if (idx !== -1) listeners.splice(idx, 1);
        },
        addEventListener: (event: string, cb: any) => {
          if (event === 'change') listeners.push(cb);
        },
        removeEventListener: (event: string, cb: any) => {
          if (event === 'change') {
            const idx = listeners.indexOf(cb);
            if (idx !== -1) listeners.splice(idx, 1);
          }
        },
        dispatchEvent: (e: any) => {
          listeners.forEach(l => l(e));
          return true;
        }
      };
    }
  });
}
