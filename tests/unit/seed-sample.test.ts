import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

describe('seed-sample script smoke test', () => {
  it('seeds sample tenders and domain tracks into data-sample without error', async () => {
    // Run seed-sample
    await import('../../scripts/seed-sample.js');

    const sampleDbPath = path.resolve(process.cwd(), 'data-sample', 'tender_tracker.db');
    expect(fs.existsSync(sampleDbPath)).toBe(true);

    const checkDb = new Database(sampleDbPath, { readonly: true });
    try {
      const countResult = checkDb.prepare('SELECT COUNT(*) as count FROM tenders').get() as { count: number };
      expect(countResult.count).toBe(20);

      const portalsCount = checkDb.prepare('SELECT COUNT(*) as count FROM portal_health').get() as { count: number };
      expect(portalsCount.count).toBe(18);
    } finally {
      checkDb.close();
    }
  });
});
