import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DomainTrack, PortalHealth, Tender, CorrigendumLog } from '../types.js';
import { PORTAL_DEFINITIONS } from './scrapers/portalList.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Root of project is two levels up from src/server
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

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

const DB_PATH = path.resolve(DATA_DIR, 'tender_tracker.db');
export const db = new Database(DB_PATH);

// Configure SQLite pragmas for solo laptop performance and concurrency safety
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function initDatabase() {
  // 1. Tenders Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenders (
      id TEXT PRIMARY KEY,
      canonical_id TEXT NOT NULL,
      reference_no TEXT,
      title TEXT NOT NULL,
      organization TEXT NOT NULL,
      portal_id TEXT NOT NULL,
      portal_name TEXT NOT NULL,
      direct_url TEXT NOT NULL,
      secondary_sources TEXT DEFAULT '[]',
      domain_tracks TEXT NOT NULL DEFAULT '[]',
      matched_keywords TEXT NOT NULL DEFAULT '[]',
      match_score INTEGER DEFAULT 0,
      publish_date TEXT,
      closing_date TEXT,
      closing_date_formatted TEXT,
      estimated_value TEXT,
      location TEXT,
      description TEXT,
      cached_dossiers TEXT DEFAULT '[]',
      has_corrigendum INTEGER DEFAULT 0,
      pipeline_status TEXT DEFAULT 'New Opportunity',
      status_notes TEXT DEFAULT '',
      is_bookmarked INTEGER DEFAULT 0,
      viewed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tenders_canonical ON tenders(canonical_id);
    CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders(pipeline_status);
    CREATE INDEX IF NOT EXISTS idx_tenders_closing ON tenders(closing_date);

    -- 2. Corrigendum & Delta Alert Logs
    CREATE TABLE IF NOT EXISTS corrigendum_logs (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      is_acknowledged INTEGER DEFAULT 0,
      detected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(tender_id) REFERENCES tenders(id) ON DELETE CASCADE
    );

    -- 3. Solo Status History Log
    CREATE TABLE IF NOT EXISTS pipeline_audit_logs (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(tender_id) REFERENCES tenders(id) ON DELETE CASCADE
    );

    -- 4. Dynamic User-Configurable Domain Tracks
    CREATE TABLE IF NOT EXISTS domain_tracks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      positive_keywords TEXT NOT NULL,
      negative_keywords TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );

    -- 5. Portal Operational Health & Watchdog
    CREATE TABLE IF NOT EXISTS portal_health (
      portal_id TEXT PRIMARY KEY,
      portal_name TEXT NOT NULL,
      category TEXT NOT NULL,
      tier TEXT NOT NULL,
      base_url TEXT NOT NULL,
      tenders_url TEXT NOT NULL,
      login_url TEXT,
      auth_username TEXT,
      auth_password TEXT,
      session_cookies TEXT,
      status TEXT DEFAULT 'online',
      last_scan_at TEXT,
      last_items_found INTEGER DEFAULT 0,
      consecutive_zero_yields INTEGER DEFAULT 0,
      last_error_message TEXT,
      access_mode TEXT DEFAULT 'public',
      verified_status TEXT
    );
  `);

  seedDefaultDomainTracks();
  // Optional date the owner expects the award result. Older databases get the column here.
  try { db.prepare('ALTER TABLE tenders ADD COLUMN result_expected_date TEXT').run(); } catch {}

  seedPortalHealth();
}

function seedDefaultDomainTracks() {
  const count = (db.prepare('SELECT COUNT(*) as count FROM domain_tracks').get() as { count: number }).count;
  if (count > 0) return;

  const defaultTracks = [
    {
      id: 'track-construction',
      name: 'Construction & Civil Works',
      positive: ['construction', 'civil works', 'renovation', 'rehabilitation', 'infrastructure', 'masonry', 'building repair', 'prefabricated', 'asphalt', 'earthwork'],
      negative: ['software', 'janitorial']
    },
    {
      id: 'track-solar',
      name: 'Solar & Clean Energy',
      positive: ['solar', 'solarization', 'pv system', 'photovoltaic', 'inverter', 'net metering', 'clean energy', 'hybrid solar', 'solar panels', 'battery bank'],
      negative: ['solar geyser repair']
    },
    {
      id: 'track-education',
      name: 'Education & Learning',
      positive: ['education', 'curriculum', 'textbooks', 'learning material', 'school supplies', 'classroom', 'literacy', 'edtech', 'teacher training', 'scholarships'],
      negative: []
    },
    {
      id: 'track-tvet',
      name: 'Vocational Training (TVET)',
      positive: ['tvet', 'vocational', 'skill development', 'technical training', 'capacity building', 'youth skills', 'apprenticeship', 'employability', 'vocational courses', 'training service provider', 'skills for', 'tool kits'],
      negative: []
    },
    {
      id: 'track-stationery',
      name: 'Stationery & Office Supplies',
      positive: ['stationery', 'office supplies', 'printing', 'paper rim', 'toner', 'cartridge', 'office equipment', 'consumables', 'it consumables', 'photocopier'],
      negative: []
    },
    {
      id: 'track-media',
      name: 'Media, Documentaries & Communications',
      positive: ['documentary', 'media production', 'video production', 'digital communications', 'animation', 'short film', 'advocacy campaign', 'awareness campaign', 'public relations', 'audio visual', 'event management'],
      negative: ['cctv', 'surveillance camera', 'security camera']
    }
  ];

  const insertStmt = db.prepare(`
    INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active)
    VALUES (?, ?, ?, ?, 1)
  `);

  const insertMany = db.transaction((tracks: typeof defaultTracks) => {
    for (const t of tracks) {
      insertStmt.run(t.id, t.name, JSON.stringify(t.positive), JSON.stringify(t.negative));
    }
  });

  insertMany(defaultTracks);
}

function seedPortalHealth() {
  // Check if columns exist; if not, add them (schema migration)
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN access_mode TEXT DEFAULT "public"').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN verified_status TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN login_url TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN auth_username TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN auth_password TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN session_cookies TEXT').run(); } catch {}

  // INSERT OR IGNORE so user edits to URLs, access modes, tiers, and statuses are NEVER overwritten on reboot
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO portal_health (
      portal_id, portal_name, category, tier, base_url, tenders_url, login_url,
      status, last_items_found, consecutive_zero_yields, access_mode, verified_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);

  const insertMany = db.transaction((portals: typeof PORTAL_DEFINITIONS) => {
    for (const p of portals) {
      const initialStatus = p.accessMode === 'login_required'
        ? 'hitl_required'
        : p.accessMode === 'offline_broken'
        ? 'error'
        : p.accessMode === 'cloudflare'
        ? 'hitl_required'
        : 'online';
      insertStmt.run(p.id, p.name, p.category, p.tier, p.baseUrl, p.tendersUrl, p.loginUrl || null, initialStatus, p.accessMode, p.verifiedStatus);
      
      // If loginUrl is defined in PORTAL_DEFINITIONS and not set in DB, populate it
      if (p.loginUrl) {
        try {
          db.prepare('UPDATE portal_health SET login_url = ? WHERE portal_id = ? AND (login_url IS NULL OR login_url = "")').run(p.loginUrl, p.id);
        } catch {}
      }
    }
  });

  insertMany(PORTAL_DEFINITIONS);
}

// Data Access Helpers
export function getAllTenders(filters?: {
  track?: string;
  status?: string;
  search?: string;
  bookmarkedOnly?: boolean;
  corrigendumOnly?: boolean;
}): Tender[] {
  let query = 'SELECT * FROM tenders WHERE 1=1';
  const params: any[] = [];

  if (filters?.status && filters.status !== 'All') {
    query += ' AND pipeline_status = ?';
    params.push(filters.status);
  }

  if (filters?.bookmarkedOnly) {
    query += ' AND is_bookmarked = 1';
  }

  if (filters?.corrigendumOnly) {
    query += ' AND has_corrigendum = 1';
  }

  if (filters?.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    query += ' AND (title LIKE ? OR organization LIKE ? OR reference_no LIKE ? OR portal_name LIKE ?)';
    params.push(term, term, term, term);
  }

  if (filters?.track && filters.track !== 'All') {
    query += ' AND EXISTS (SELECT 1 FROM json_each(tenders.domain_tracks) WHERE value = ?)';
    params.push(filters.track);
  }

  query += ' ORDER BY CASE WHEN closing_date IS NULL THEN 1 ELSE 0 END, closing_date ASC, updated_at DESC';

  const rows = db.prepare(query).all(...params) as any[];

  return rows.map(row => ({
    ...row,
    secondary_sources: safeJsonParse(row.secondary_sources, []),
    domain_tracks: safeJsonParse(row.domain_tracks, []),
    matched_keywords: safeJsonParse(row.matched_keywords, []),
    cached_dossiers: safeJsonParse(row.cached_dossiers, [])
  }));
}

export function getTenderById(id: string): Tender | null {
  const row = db.prepare('SELECT * FROM tenders WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    ...row,
    secondary_sources: safeJsonParse(row.secondary_sources, []),
    domain_tracks: safeJsonParse(row.domain_tracks, []),
    matched_keywords: safeJsonParse(row.matched_keywords, []),
    cached_dossiers: safeJsonParse(row.cached_dossiers, [])
  };
}

export function updateTenderStatus(id: string, newStatus: string, notes?: string) {
  const tender = getTenderById(id);
  if (!tender) return false;

  const previousStatus = tender.pipeline_status;

  const updateTx = db.transaction(() => {
    db.prepare(`
      UPDATE tenders 
      SET pipeline_status = ?, status_notes = COALESCE(?, status_notes), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newStatus, notes, id);

    db.prepare(`
      INSERT INTO pipeline_audit_logs (id, tender_id, previous_status, new_status, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run('log-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6), id, previousStatus, newStatus, notes || null);
  });

  updateTx();
  return true;
}

export function toggleTenderBookmark(id: string): { success: boolean; is_bookmarked: number } {
  const tender = getTenderById(id);
  if (!tender) return { success: false, is_bookmarked: 0 };

  const nextState = tender.is_bookmarked === 1 ? 0 : 1;
  db.prepare(`
    UPDATE tenders 
    SET is_bookmarked = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextState, id);

  return { success: true, is_bookmarked: nextState };
}

export function updateTenderNotes(id: string, notes: string): boolean {
  const res = db.prepare(`
    UPDATE tenders SET status_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(notes, id);
  return res.changes > 0;
}

/** Pass null or an empty string to clear the date. */
export function updateTenderResultDate(id: string, date: string | null): boolean {
  const res = db.prepare(`
    UPDATE tenders SET result_expected_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(date || null, id);
  return res.changes > 0;
}

export function getAllDomainTracks(): DomainTrack[] {
  const rows = db.prepare('SELECT * FROM domain_tracks ORDER BY name ASC').all() as any[];
  return rows.map(r => ({
    ...r,
    positive_keywords: safeJsonParse(r.positive_keywords, []),
    negative_keywords: safeJsonParse(r.negative_keywords, [])
  }));
}

export function saveDomainTrack(track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[]; is_active?: number }) {
  const id = track.id || 'track-' + Date.now();
  const existing = track.id ? db.prepare('SELECT id FROM domain_tracks WHERE id = ?').get(track.id) : null;

  if (existing) {
    db.prepare(`
      UPDATE domain_tracks
      SET name = ?, positive_keywords = ?, negative_keywords = ?, is_active = ?
      WHERE id = ?
    `).run(track.name, JSON.stringify(track.positive_keywords), JSON.stringify(track.negative_keywords), track.is_active ?? 1, id);
  } else {
    db.prepare(`
      INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        positive_keywords = excluded.positive_keywords,
        negative_keywords = excluded.negative_keywords,
        is_active = excluded.is_active
    `).run(id, track.name, JSON.stringify(track.positive_keywords), JSON.stringify(track.negative_keywords), track.is_active ?? 1);
  }

  // Re-evaluate tenders against tracks when track rules change
  reScoreTendersAgainstTracks();
  return id;
}

export function deleteDomainTrack(id: string) {
  db.prepare('DELETE FROM domain_tracks WHERE id = ?').run(id);
  reScoreTendersAgainstTracks();
  return true;
}

export function reScoreTendersAgainstTracks() {
  const tracks = getAllDomainTracks().filter(t => t.is_active === 1);
  const tenders = db.prepare('SELECT id, title, description, organization, reference_no FROM tenders').all() as any[];

  const updateStmt = db.prepare(`
    UPDATE tenders SET domain_tracks = ?, matched_keywords = ?, match_score = ? WHERE id = ?
  `);

  const updateTx = db.transaction(() => {
    for (const tender of tenders) {
      const combinedText = `${tender.title} ${tender.description || ''} ${tender.organization} ${tender.reference_no || ''}`.toLowerCase();
      const matchedTracks: string[] = [];
      const matchedKeywords: string[] = [];

      for (const track of tracks) {
        const hasNegative = track.negative_keywords.some((neg: string) => combinedText.includes(neg.toLowerCase()));
        if (hasNegative) continue;

        const hitKeywords = track.positive_keywords.filter((pos: string) => combinedText.includes(pos.toLowerCase()));
        if (hitKeywords.length > 0) {
          matchedTracks.push(track.name);
          matchedKeywords.push(...hitKeywords);
        }
      }

      const matchScore = Math.min(100, Math.max(30, matchedKeywords.length * 20));
      updateStmt.run(JSON.stringify(matchedTracks), JSON.stringify(Array.from(new Set(matchedKeywords))), matchScore, tender.id);
    }
  });

  updateTx();
}

export function getPortalHealthList(): PortalHealth[] {
  const rows = db.prepare('SELECT * FROM portal_health ORDER BY portal_name ASC').all() as any[];
  return rows.map(r => ({
    portal_id: r.portal_id,
    portal_name: r.portal_name,
    category: r.category,
    tier: r.tier,
    base_url: r.base_url,
    tenders_url: r.tenders_url,
    login_url: r.login_url,
    auth_username: r.auth_username,
    has_credentials: Boolean(r.auth_password),
    session_cookies: r.session_cookies,
    status: r.status,
    last_scan_at: r.last_scan_at,
    last_items_found: r.last_items_found,
    consecutive_zero_yields: r.consecutive_zero_yields,
    last_error_message: r.last_error_message,
    access_mode: r.access_mode,
    verified_status: r.verified_status
  }));
}

export function updatePortalHealth(portalId: string, updates: Partial<PortalHealth> & { auth_password?: string }) {
  const existing = db.prepare('SELECT * FROM portal_health WHERE portal_id = ?').get(portalId);
  if (!existing) return;

  const allowedColumns = new Set([
    'portal_name', 'category', 'tier', 'base_url', 'tenders_url', 'login_url',
    'auth_username', 'auth_password', 'session_cookies',
    'status', 'last_scan_at', 'last_items_found', 'consecutive_zero_yields',
    'last_error_message', 'access_mode', 'verified_status'
  ]);

  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (allowedColumns.has(key) && val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (fields.length === 0) return;
  values.push(portalId);

  db.prepare(`UPDATE portal_health SET ${fields.join(', ')} WHERE portal_id = ?`).run(...values);
}

export function savePortalCredentials(portalId: string, creds: { username?: string; password?: string; loginUrl?: string }) {
  const updates: any = {};
  if (creds.username !== undefined) updates.auth_username = creds.username;
  if (creds.password !== undefined && creds.password.trim().length > 0) updates.auth_password = creds.password;
  if (creds.loginUrl !== undefined) updates.login_url = creds.loginUrl;
  updatePortalHealth(portalId, updates);
}

export function getPortalAuthCredentials(portalId: string): { username?: string; password?: string; loginUrl?: string; cookies?: string } | null {
  const row = db.prepare('SELECT auth_username, auth_password, login_url, session_cookies FROM portal_health WHERE portal_id = ?').get(portalId) as any;
  if (!row) return null;
  return {
    username: row.auth_username,
    password: row.auth_password,
    loginUrl: row.login_url,
    cookies: row.session_cookies
  };
}

export function getUnacknowledgedCorrigenda(): (CorrigendumLog & { tender_title: string; portal_name: string })[] {
  return db.prepare(`
    SELECT c.*, t.title as tender_title, t.portal_name
    FROM corrigendum_logs c
    JOIN tenders t ON c.tender_id = t.id
    WHERE c.is_acknowledged = 0
    ORDER BY c.detected_at DESC
  `).all() as any[];
}

export function acknowledgeCorrigendum(id: string) {
  const log = db.prepare('SELECT tender_id FROM corrigendum_logs WHERE id = ?').get(id) as { tender_id: string } | undefined;
  if (!log) return false;

  const updateTx = db.transaction(() => {
    db.prepare('UPDATE corrigendum_logs SET is_acknowledged = 1 WHERE id = ?').run(id);

    // If no other unacknowledged corrigenda remain for this tender, clear tender flag
    const remaining = (db.prepare('SELECT COUNT(*) as c FROM corrigendum_logs WHERE tender_id = ? AND is_acknowledged = 0').get(log.tender_id) as any).c;
    if (remaining === 0) {
      db.prepare('UPDATE tenders SET has_corrigendum = 0 WHERE id = ?').run(log.tender_id);
    }
  });

  updateTx();
  return true;
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
