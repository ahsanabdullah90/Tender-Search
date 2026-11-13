import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '..', '..', '..');
}

const PROJECT_ROOT = findProjectRoot(__dirname);

// Ensure required data directories exist relative to project root
export const DATA_DIR = process.env.TENDER_DATA_DIR
  ? path.resolve(process.env.TENDER_DATA_DIR)
  : path.resolve(PROJECT_ROOT, 'data');
export const BACKUPS_DIR = path.resolve(DATA_DIR, 'backups');
export const DOSSIERS_DIR = path.resolve(DATA_DIR, 'dossiers');
export const SESSIONS_DIR = path.resolve(DATA_DIR, 'sessions');
export const MODELS_DIR = path.resolve(DATA_DIR, 'models');
export const LOGS_DIR = path.resolve(DATA_DIR, 'logs');
export const TESSDATA_DIR = path.resolve(DATA_DIR, 'tessdata');

for (const dir of [DATA_DIR, BACKUPS_DIR, DOSSIERS_DIR, SESSIONS_DIR, MODELS_DIR, LOGS_DIR, TESSDATA_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const DB_PATH = path.resolve(DATA_DIR, 'tender_tracker.db');
export const db = new Database(DB_PATH);

// Configure SQLite pragmas for solo laptop performance and concurrency safety
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
