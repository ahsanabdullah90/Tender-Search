import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertSafeTestDataDir } from './test-env.js';

if (!process.env.TENDER_DATA_DIR) {
  const globalTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-suite-temp-'));
  process.env.TENDER_DATA_DIR = globalTemp;
}

assertSafeTestDataDir();
