import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REAL_DATA_DIR = path.resolve(REPO_ROOT, 'data');

/**
 * Asserts that the currently configured data directory is NOT the production data directory.
 * Throws immediately if unsafe.
 */
export function assertSafeTestDataDir(): void {
  const currentDataDir = process.env.TENDER_DATA_DIR ? path.resolve(process.env.TENDER_DATA_DIR) : null;
  if (!currentDataDir) {
    throw new Error(
      '[Test Safety Guard] TENDER_DATA_DIR is not set! Tests must never run without an isolated data directory.'
    );
  }
  if (currentDataDir === REAL_DATA_DIR) {
    throw new Error(
      `[Test Safety Guard] TENDER_DATA_DIR (${currentDataDir}) matches production data dir! Tests must never touch production data.`
    );
  }
}

/**
 * Creates an isolated temp directory for a test suite and sets TENDER_DATA_DIR.
 * Returns the path and a cleanup callback.
 */
export function createTempTestDataDir(prefix: string = 'tt-test-'): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.TENDER_DATA_DIR = dir;
  assertSafeTestDataDir();

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  };

  return { dir, cleanup };
}
