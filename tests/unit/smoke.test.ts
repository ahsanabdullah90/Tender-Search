import { describe, it, expect } from 'vitest';

describe('Node Project Smoke Test', () => {
  it('runs basic node tests successfully', () => {
    expect(1 + 1).toBe(2);
    expect(process.env.TENDER_DATA_DIR).toBeDefined();
  });
});
