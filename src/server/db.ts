import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DomainTrack, PortalHealth, Tender, CorrigendumLog, PipelineAuditLog } from '../types.js';
import { PORTAL_DEFINITIONS } from './scrapers/portalList.js';

// Ensure required data directories exist
const DATA_DIR = path.resolve(process.cwd(), 'data');
const BACKUPS_DIR = path.resolve(DATA_DIR, 'backups');
const DOSSIERS_DIR = path.resolve(DATA_DIR, 'dossiers');
const SESSIONS_DIR = path.resolve(DATA_DIR, 'sessions');

for (const dir of [DATA_DIR, BACKUPS_DIR, DOSSIERS_DIR, SESSIONS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const DB_PATH = path.resolve(DATA_DIR, 'sentinel.db');
export const db = new Database(DB_PATH);

// Configure SQLite pragmas for solo laptop performance and concurrency safety
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

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
      positive: ['tvet', 'vocational', 'skill development', 'technical training', 'capacity building', 'youth skills', 'apprenticeship', 'employability', 'vocational courses'],
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
  try {
    db.prepare('ALTER TABLE portal_health ADD COLUMN access_mode TEXT DEFAULT "public"').run();
  } catch {}
  try {
    db.prepare('ALTER TABLE portal_health ADD COLUMN verified_status TEXT').run();
  } catch {}

  const insertStmt = db.prepare(`
    INSERT INTO portal_health (portal_id, portal_name, category, tier, base_url, tenders_url, status, last_items_found, consecutive_zero_yields, access_mode, verified_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT(portal_id) DO UPDATE SET
      portal_name = excluded.portal_name,
      category = excluded.category,
      tier = excluded.tier,
      base_url = excluded.base_url,
      tenders_url = excluded.tenders_url,
      access_mode = excluded.access_mode,
      verified_status = excluded.verified_status
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
      insertStmt.run(p.id, p.name, p.category, p.tier, p.baseUrl, p.tendersUrl, initialStatus, p.accessMode, p.verifiedStatus);
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

  query += ' ORDER BY CASE WHEN closing_date IS NULL THEN 1 ELSE 0 END, closing_date ASC, updated_at DESC';

  const rows = db.prepare(query).all(...params) as any[];

  // Filter track in memory or via JSON contains
  return rows
    .map(row => ({
      ...row,
      secondary_sources: JSON.parse(row.secondary_sources || '[]'),
      domain_tracks: JSON.parse(row.domain_tracks || '[]'),
      matched_keywords: JSON.parse(row.matched_keywords || '[]'),
      cached_dossiers: JSON.parse(row.cached_dossiers || '[]')
    }))
    .filter(t => {
      if (!filters?.track || filters.track === 'All') return true;
      return t.domain_tracks.includes(filters.track);
    });
}

export function getTenderById(id: string): Tender | null {
  const row = db.prepare('SELECT * FROM tenders WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    ...row,
    secondary_sources: JSON.parse(row.secondary_sources || '[]'),
    domain_tracks: JSON.parse(row.domain_tracks || '[]'),
    matched_keywords: JSON.parse(row.matched_keywords || '[]'),
    cached_dossiers: JSON.parse(row.cached_dossiers || '[]')
  };
}

export function updateTenderStatus(id: string, newStatus: string, notes?: string) {
  const tender = getTenderById(id);
  if (!tender) return false;

  const previousStatus = tender.pipeline_status;
  const updateStmt = db.prepare(`
    UPDATE tenders 
    SET pipeline_status = ?, status_notes = COALESCE(?, status_notes), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  updateStmt.run(newStatus, notes, id);

  // Log in pipeline_audit_logs
  const logStmt = db.prepare(`
    INSERT INTO pipeline_audit_logs (id, tender_id, previous_status, new_status, notes)
    VALUES (?, ?, ?, ?, ?)
  `);
  logStmt.run('log-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6), id, previousStatus, newStatus, notes || null);

  return true;
}

export function toggleTenderBookmark(id: string) {
  db.prepare(`
    UPDATE tenders 
    SET is_bookmarked = CASE WHEN is_bookmarked = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
  return true;
}

export function updateTenderNotes(id: string, notes: string) {
  db.prepare(`
    UPDATE tenders SET status_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(notes, id);
  return true;
}

export function getAllDomainTracks(): DomainTrack[] {
  const rows = db.prepare('SELECT * FROM domain_tracks ORDER BY name ASC').all() as any[];
  return rows.map(r => ({
    ...r,
    positive_keywords: JSON.parse(r.positive_keywords || '[]'),
    negative_keywords: JSON.parse(r.negative_keywords || '[]')
  }));
}

export function saveDomainTrack(track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[]; is_active?: number }) {
  const id = track.id || 'track-' + Date.now();
  const stmt = db.prepare(`
    INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      positive_keywords = excluded.positive_keywords,
      negative_keywords = excluded.negative_keywords,
      is_active = excluded.is_active
  `);
  stmt.run(id, track.name, JSON.stringify(track.positive_keywords), JSON.stringify(track.negative_keywords), track.is_active ?? 1);
  return id;
}

export function deleteDomainTrack(id: string) {
  db.prepare('DELETE FROM domain_tracks WHERE id = ?').run(id);
  return true;
}

export function getPortalHealthList(): PortalHealth[] {
  return db.prepare('SELECT * FROM portal_health ORDER BY portal_name ASC').all() as PortalHealth[];
}

export function updatePortalHealth(portalId: string, updates: Partial<PortalHealth>) {
  const existing = db.prepare('SELECT * FROM portal_health WHERE portal_id = ?').get(portalId);
  if (!existing) return;

  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }

  if (fields.length === 0) return;
  values.push(portalId);

  db.prepare(`UPDATE portal_health SET ${fields.join(', ')} WHERE portal_id = ?`).run(...values);
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
  db.prepare('UPDATE corrigendum_logs SET is_acknowledged = 1 WHERE id = ?').run(id);
  return true;
}

export function getKpiStats() {
  const totalTracked = (db.prepare('SELECT COUNT(*) as c FROM tenders').get() as any).c;
  
  // Closing in < 72h
  const closingSoon = (db.prepare(`
    SELECT COUNT(*) as c FROM tenders 
    WHERE closing_date IS NOT NULL 
    AND closing_date > datetime('now')
    AND closing_date <= datetime('now', '+3 days')
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

export async function backupDatabase() {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8);
  const backupPath = path.resolve(BACKUPS_DIR, `sentinel_${timestamp}.db`);
  try {
    await db.backup(backupPath);
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
  } catch (err) {
    console.error('Database backup failed:', err);
  }
}

export function clearAllTenders() {
  db.prepare('DELETE FROM corrigendum_logs').run();
  db.prepare('DELETE FROM pipeline_audit_logs').run();
  db.prepare('DELETE FROM tenders').run();
  return true;
}

