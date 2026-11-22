import fs from 'fs';
import path from 'path';
import { db, BACKUPS_DIR, DOSSIERS_DIR } from '../connection.js';
import { deleteTenders, NOT_STAGING_SQL } from './tendersRepo.js';
import { DigestAlertItem, DigestSummary } from '../../../shared/types.js';

export function getAppSetting(key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function setAppSetting(key: string, value: string | null): void {
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
  // Staging rows (mid-ingest) are not counted until they are ready.
  const totalTracked = (db.prepare(`SELECT COUNT(*) as c FROM tenders WHERE ${NOT_STAGING_SQL}`).get() as any).c;

  // Accurate Julian-day comparison handles both ISO 'T' and SQLite space formats cleanly
  const closingSoon = (db.prepare(`
    SELECT COUNT(*) as c FROM tenders
    WHERE ${NOT_STAGING_SQL}
    AND closing_date IS NOT NULL
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

/**
 * Proactive closing alerts & daily digest summary (Plan B).
 * Queries active non-Passed/non-Won tenders closing within `withinHours` (default 48h),
 * unacknowledged corrigenda, and new matches discovered in the last 24h.
 */
export function getAlertsDigest(withinHours: number = 48): DigestSummary {
  const safeHours = Math.max(1, Math.min(336, Math.floor(withinHours) || 48));
  const nowMs = Date.now();

  const closingRows = db.prepare(`
    SELECT id, reference_no, title, organization, portal_id, portal_name,
           pipeline_status, closing_date, closing_date_formatted, direct_url, is_bookmarked
    FROM tenders
    WHERE ${NOT_STAGING_SQL}
      AND closing_date IS NOT NULL
      AND julianday(closing_date) > julianday('now')
      AND julianday(closing_date) <= julianday('now', ?)
      AND pipeline_status NOT IN ('Won', 'Passed')
    ORDER BY julianday(closing_date) ASC
    LIMIT 50
  `).all(`+${safeHours} hours`) as any[];

  const closingSoon: DigestAlertItem[] = closingRows.map(r => {
    const closeMs = new Date(r.closing_date).getTime();
    const hoursRemaining = Math.max(0, Math.round(((closeMs - nowMs) / 3600000) * 10) / 10);
    return {
      id: r.id,
      reference_no: r.reference_no ?? null,
      title: r.title,
      organization: r.organization,
      portal_id: r.portal_id,
      portal_name: r.portal_name,
      pipeline_status: r.pipeline_status,
      closing_date: r.closing_date,
      closing_date_formatted: r.closing_date_formatted || 'Not Available',
      hours_remaining: hoursRemaining,
      direct_url: r.direct_url,
      is_bookmarked: Number(r.is_bookmarked || 0)
    };
  });

  const unackCorrigendaCount = (db.prepare(`
    SELECT COUNT(*) as c FROM corrigendum_logs WHERE is_acknowledged = 0
  `).get() as any).c || 0;

  const newMatchesLast24hCount = (db.prepare(`
    SELECT COUNT(*) as c FROM tenders
    WHERE ${NOT_STAGING_SQL}
      AND julianday(created_at) >= julianday('now', '-24 hours')
  `).get() as any).c || 0;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    withinHours: safeHours,
    closingSoonCount: closingSoon.length,
    closingSoon,
    unacknowledgedCorrigendaCount: unackCorrigendaCount,
    newMatchesLast24hCount
  };
}

export interface DigestSettings {
  enabled: boolean;
  webhookUrl: string;
  withinHours: number;
  lastSentDatePkt: string | null;
}

export function getDigestSettings(): DigestSettings {
  const enabled = getAppSetting('digest_enabled') === 'true';
  const webhookUrl = getAppSetting('digest_webhook_url') || '';
  const hoursRaw = Number(getAppSetting('digest_within_hours') || '48');
  const withinHours = Number.isFinite(hoursRaw) && hoursRaw >= 1 && hoursRaw <= 336 ? Math.floor(hoursRaw) : 48;
  const lastSentDatePkt = getAppSetting('last_digest_sent_at');
  return { enabled, webhookUrl, withinHours, lastSentDatePkt };
}

export function updateDigestSettings(input: Partial<{ enabled: boolean; webhookUrl: string; withinHours: number }>): DigestSettings {
  if (input.enabled !== undefined) {
    setAppSetting('digest_enabled', input.enabled ? 'true' : 'false');
  }
  if (input.webhookUrl !== undefined) {
    setAppSetting('digest_webhook_url', input.webhookUrl.trim() || null);
  }
  if (input.withinHours !== undefined) {
    const clamped = Math.max(1, Math.min(336, Math.floor(Number(input.withinHours) || 48)));
    setAppSetting('digest_within_hours', String(clamped));
  }
  return getDigestSettings();
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
    // Prune backups older than 15 days
    const files = fs.readdirSync(BACKUPS_DIR);
    const now = Date.now();
    for (const f of files) {
      const filePath = path.resolve(BACKUPS_DIR, f);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 15 * 24 * 60 * 60 * 1000) {
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
  const awaitingScope = db.prepare(`SELECT COUNT(*) AS n FROM tenders WHERE ingestion_status = 'awaiting_scope'`).get() as { n: number };
  return {
    total_bytes: folderSize(DOSSIERS_DIR),
    passed_bytes: passedBytes,
    passed_tenders: passed.length,
    tenders_with_documents: withDocs.n,
    awaiting_scope_count: awaitingScope ? awaitingScope.n : 0
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
  let ids: string[];
  if (unreviewedOnly) {
    const rows = db.prepare(`
      SELECT id FROM tenders WHERE pipeline_status IN ('New Opportunity', 'Passed') AND is_bookmarked = 0
    `).all() as { id: string }[];
    ids = rows.map(r => r.id);
  } else {
    const rows = db.prepare('SELECT id FROM tenders').all() as { id: string }[];
    ids = rows.map(r => r.id);
  }

  deleteTenders(ids, 'user');
  return true;
}

/**
 * Deletes daily Gemini Vision call counter rows in app_settings (`ingest_vision_calls_YYYY-MM-DD`)
 * older than `keepDays` days (docs/14 P2-7).
 */
export function pruneOldDailyVisionCounters(keepDays: number = 7): number {
  try {
    const cutoffMs = Date.now() + 5 * 3600000 - Math.max(1, keepDays) * 86400000;
    const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
    // Vision counters: ingest_vision_calls_YYYY-MM-DD; AI text counters: ingest_ai_text_calls_YYYY-MM-DD.
    return db.prepare(`
      DELETE FROM app_settings
      WHERE (key LIKE 'ingest_vision_calls_20%' OR key LIKE 'ingest_ai_text_calls_20%')
        AND substr(key, -10) < ?
    `).run(cutoffDay).changes;
  } catch {
    return 0;
  }
}

export interface PendingFilePurgeRow {
  id: string;
  folder_path: string;
  attempts: number;
}

export function enqueuePendingFilePurge(id: string, folderPath: string, errorMessage: string): void {
  db.prepare(`
    INSERT INTO pending_file_purges (id, folder_path, attempts, last_error)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error
  `).run(id, folderPath, errorMessage);
}

export function getPendingFilePurges(maxAttempts: number = 10): PendingFilePurgeRow[] {
  return db.prepare('SELECT id, folder_path, attempts FROM pending_file_purges WHERE attempts < ?').all(maxAttempts) as PendingFilePurgeRow[];
}

export function deletePendingFilePurge(id: string): void {
  db.prepare('DELETE FROM pending_file_purges WHERE id = ?').run(id);
}

export function incrementPendingFilePurgeAttempt(id: string, errorMessage: string): void {
  db.prepare('UPDATE pending_file_purges SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(errorMessage, id);
}

export function countPendingFilePurges(maxAttempts: number = 10): number {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM pending_file_purges WHERE attempts < ?').get(maxAttempts) as { c: number } | undefined;
    return row?.c || 0;
  } catch {
    return 0;
  }
}

