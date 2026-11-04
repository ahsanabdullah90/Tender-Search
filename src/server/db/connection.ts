import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Root of project is three levels up from src/server/db
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// Ensure required data directories exist relative to project root
export const DATA_DIR = process.env.TENDER_DATA_DIR
  ? path.resolve(process.env.TENDER_DATA_DIR)
  : path.resolve(PROJECT_ROOT, 'data');
export const BACKUPS_DIR = path.resolve(DATA_DIR, 'backups');
export const DOSSIERS_DIR = path.resolve(DATA_DIR, 'dossiers');
export const SESSIONS_DIR = path.resolve(DATA_DIR, 'sessions');

for (const dir of [DATA_DIR, BACKUPS_DIR, DOSSIERS_DIR, SESSIONS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const DB_PATH = path.resolve(DATA_DIR, 'tender_tracker.db');
export const db = new Database(DB_PATH);

// Configure SQLite pragmas for solo laptop performance and concurrency safety
db.pragma('journal_mode = WAL');
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
