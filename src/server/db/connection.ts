import Database from 'better-sqlite3';
import {
  DATA_DIR,
  BACKUPS_DIR,
  DOSSIERS_DIR,
  SESSIONS_DIR,
  MODELS_DIR,
  LOGS_DIR,
  TESSDATA_DIR,
  DB_PATH
} from '../domain/paths.js';

export {
  DATA_DIR,
  BACKUPS_DIR,
  DOSSIERS_DIR,
  SESSIONS_DIR,
  MODELS_DIR,
  LOGS_DIR,
  TESSDATA_DIR,
  DB_PATH
};

export const db = new Database(DB_PATH);

// Configure SQLite pragmas for solo laptop performance and concurrency safety
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

export function closeDatabase(): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {}
  db.close();
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
