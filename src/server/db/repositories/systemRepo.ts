import fs from 'fs';
import path from 'path';
import { db, BACKUPS_DIR, DOSSIERS_DIR } from '../connection.js';

export function getAppSetting(key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function setAppSetting(key: string, value: string | null): void {
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
  if (value === null || !value.trim()) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  } else {
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value.trim());
  }
}

export function getGeminiApiKey(): string | null {
  const dbKey = getAppSetting('gemini_api_key');
  if (dbKey && dbKey.trim() && dbKey !== 'MY_GEMINI_API_KEY') {
    return dbKey.trim();
  }
  const envKey = process.env.GEMINI_API_KEY;
  if (envKey && envKey.trim() && envKey !== 'MY_GEMINI_API_KEY') {
    return envKey.trim();
  }
  return null;
}

export function getKpiStats() {
  const totalTracked = (db.prepare('SELECT COUNT(*) as c FROM tenders').get() as any).c;
  
  // Accurate Julian-day comparison handles both ISO 'T' and SQLite space formats cleanly
  const closingSoon = (db.prepare(`
    SELECT COUNT(*) as c FROM tenders 
    WHERE closing_date IS NOT NULL 
    AND julianday(closing_date) > julianday('now')
    AND julianday(closing_date) <= julianday('now', '+3 days')
    AND pipeline_status NOT IN ('Won', 'Passed')
  `).get() as any).c;

  // In active pipeline
  const inPipeline = (db.prepare(`
    SELECT COUNT(*) as c FROM tenders 
    WHERE pipeline_status IN ('Under Review', 'Preparing Bid', 'Submitted')
  `).get() as any).c;

  // Unacknowledged corrigenda
  const unackCorrigenda = (db.prepare(`
    SELECT COUNT(*) as c FROM corrigendum_logs 
    WHERE is_acknowledged = 0
  `).get() as any).c;

  // Portals online
  const totalPortals = (db.prepare('SELECT COUNT(*) as c FROM portal_health').get() as any).c;
  const onlinePortals = (db.prepare("SELECT COUNT(*) as c FROM portal_health WHERE status = 'online'").get() as any).c;
  const hitlRequiredCount = (db.prepare("SELECT COUNT(*) as c FROM portal_health WHERE status = 'hitl_required'").get() as any).c;

  return {
    totalTracked,
    closingSoon,
    inPipeline,
    unackCorrigenda,
    totalPortals,
    onlinePortals,
    hitlRequiredCount
  };
}

export async function backupDatabase(): Promise<{ success: boolean; path?: string; skipped?: boolean }> {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8);
  const backupPath = path.resolve(BACKUPS_DIR, `tender_tracker_${timestamp}.db`);
  
  // Skip if today's backup already exists
  if (fs.existsSync(backupPath)) {
    return { success: true, path: backupPath, skipped: true };
  }

  try {
    await db.backup(backupPath);
    console.log(`[Tender Tracker DB] Daily backup generated: ${backupPath}`);
    // Prune backups older than 14 days
    const files = fs.readdirSync(BACKUPS_DIR);
    const now = Date.now();
    for (const f of files) {
      const filePath = path.resolve(BACKUPS_DIR, f);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 14 * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    }
    return { success: true, path: backupPath };
  } catch (err) {
    console.error('Database backup failed:', err);
    return { success: false };
  }
}

export interface BackupInfo {
  name: string;
  created_at: string;
  size_bytes: number;
}

export function listBackups(): BackupInfo[] {
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.db'))
    .map(name => {
      const stat = fs.statSync(path.resolve(BACKUPS_DIR, name));
      return { name, created_at: stat.mtime.toISOString(), size_bytes: stat.size };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** On-demand backup. Unlike the daily one, it never skips and keeps its own file name. */
export async function backupNow(): Promise<BackupInfo | null> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const name = `tender_tracker_${stamp}_manual.db`;
  try {
    await db.backup(path.resolve(BACKUPS_DIR, name));
    return listBackups().find(b => b.name === name) ?? null;
  } catch (err) {
    console.error('Manual backup failed:', err);
    return null;
  }
}

function folderSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.resolve(dir, entry.name);
    total += entry.isDirectory() ? folderSize(full) : fs.statSync(full).size;
  }
  return total;
}

export function getStorageStats() {
  const passed = db.prepare(`SELECT id FROM tenders WHERE pipeline_status = 'Passed'`).all() as { id: string }[];
  const passedBytes = passed.reduce((sum, t) => sum + folderSize(path.resolve(DOSSIERS_DIR, t.id)), 0);
  const withDocs = db.prepare(`SELECT COUNT(*) AS n FROM tenders WHERE cached_dossiers IS NOT NULL AND cached_dossiers != '[]'`).get() as { n: number };
  return {
    total_bytes: folderSize(DOSSIERS_DIR),
    passed_bytes: passedBytes,
    passed_tenders: passed.length,
    tenders_with_documents: withDocs.n
  };
}

/** Deletes saved documents for Passed tenders only. Returns the bytes freed. */
export function pruneDossiersForPassed(): { freed_bytes: number; tenders: number } {
  const passed = db.prepare(`SELECT id FROM tenders WHERE pipeline_status = 'Passed'`).all() as { id: string }[];
  let freed = 0;
  let count = 0;
  for (const { id } of passed) {
    const dir = path.resolve(DOSSIERS_DIR, id);
    // Never follow an id that would leave the dossiers folder.
    if (!dir.startsWith(DOSSIERS_DIR + path.sep) || !fs.existsSync(dir)) continue;
    freed += folderSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    db.prepare(`UPDATE tenders SET cached_dossiers = '[]' WHERE id = ?`).run(id);
    count++;
  }
  return { freed_bytes: freed, tenders: count };
}

/**
 * Clear Tenders:
 * - unreviewedOnly = true: Preserves user-curated opportunities (Under Review, Preparing Bid, Submitted, Won) and bookmarks.
 * - unreviewedOnly = false: Complete factory wipe of all tenders.
 */
export function clearAllTenders(unreviewedOnly: boolean = false) {
  const wipeTx = db.transaction(() => {
    if (unreviewedOnly) {
      // Delete only New Opportunity and Passed tenders that are NOT bookmarked
      db.prepare(`
        DELETE FROM corrigendum_logs 
        WHERE tender_id IN (
          SELECT id FROM tenders WHERE pipeline_status IN ('New Opportunity', 'Passed') AND is_bookmarked = 0
        )
      `).run();
      db.prepare(`
        DELETE FROM pipeline_audit_logs 
        WHERE tender_id IN (
          SELECT id FROM tenders WHERE pipeline_status IN ('New Opportunity', 'Passed') AND is_bookmarked = 0
        )
      `).run();
      db.prepare(`
        DELETE FROM tenders 
        WHERE pipeline_status IN ('New Opportunity', 'Passed') AND is_bookmarked = 0
      `).run();
    } else {
      db.prepare('DELETE FROM corrigendum_logs').run();
      db.prepare('DELETE FROM pipeline_audit_logs').run();
      db.prepare('DELETE FROM tenders').run();
    }
  });

  wipeTx();
  return true;
}
