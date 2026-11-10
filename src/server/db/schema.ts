import { db } from './connection.js';
import { PORTAL_DEFINITIONS } from '../scrapers/portalList.js';

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
      passed_at TEXT,
      slimmed_at TEXT,
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
    -- 6. App Settings (Google AI Studio API Key & Preferences)
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- 7. Pending File Purges (Resilient lock-retry queue for Windows / GDrive)
    CREATE TABLE IF NOT EXISTS pending_file_purges (
      id TEXT PRIMARY KEY,
      folder_path TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 8. Deleted Tenders (Suppression list preventing scraper re-importing open manual deletes)
    CREATE TABLE IF NOT EXISTS deleted_tenders (
      id TEXT PRIMARY KEY,
      canonical_id TEXT NOT NULL,
      closing_date TEXT,
      deleted_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_deleted_tenders_canonical ON deleted_tenders(canonical_id);

    -- 9. Document Ingest Jobs (durable retry queue for tender document downloads + extraction)
    CREATE TABLE IF NOT EXISTS document_ingest_jobs (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      label TEXT,
      priority INTEGER NOT NULL DEFAULT 50,      -- lower runs first: corrigendum=10, rfp/notice=20, other=50
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'pending',    -- pending | processing | done | failed
      lease_until TEXT,                          -- crash recovery for 'processing'
      last_error TEXT,
      next_retry_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tender_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_ingest_jobs_due ON document_ingest_jobs(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_ingest_jobs_tender ON document_ingest_jobs(tender_id);
  `);

  // Migrations for columns added over time
  try { db.prepare('ALTER TABLE tenders ADD COLUMN result_expected_date TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE tenders ADD COLUMN passed_at TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE tenders ADD COLUMN slimmed_at TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE tenders ADD COLUMN embedding BLOB').run(); } catch {}
  try { db.prepare('ALTER TABLE tenders ADD COLUMN semantic_score REAL DEFAULT 0').run(); } catch {}
  try { db.prepare('ALTER TABLE domain_tracks ADD COLUMN embedding BLOB').run(); } catch {}

  migrateIngestionProvenanceColumns();

  seedDefaultDomainTracks();
  seedPortalHealth();
}

/**
 * Ingestion-pipeline provenance columns (docs/13-ingestion-pipeline-plan.md, Phase 1):
 *   ingestion_status    'staging' | 'ready' | 'failed_verification'  (staging rows are hidden from every read path)
 *   deadline_source     'corrigendum_doc' | 'primary_doc' | 'html_detail' | 'html_row' | 'manual' | NULL
 *   deadline_confidence 'high' | 'medium' | 'low' | NULL
 *   doc_fetch_status    'none' | 'pending' | 'partial' | 'complete' | 'failed'
 *   needs_review        1 when the operator must confirm something (e.g. a corrigendum moved the deadline earlier)
 *   review_reason       human-readable reason for needs_review
 *
 * Existing rows are backfilled only on the run that adds each column, so later rows written by the
 * pipeline (which sets these explicitly) are never relabelled.
 */
function migrateIngestionProvenanceColumns() {
  const addColumn = (ddl: string): boolean => {
    try {
      db.prepare(`ALTER TABLE tenders ADD COLUMN ${ddl}`).run();
      return true;
    } catch {
      return false; // column already exists
    }
  };

  addColumn(`ingestion_status TEXT DEFAULT 'ready'`);
  if (addColumn('deadline_source TEXT')) {
    db.prepare(`
      UPDATE tenders
      SET deadline_source = CASE WHEN portal_id = 'manual' THEN 'manual' ELSE 'html_row' END
      WHERE closing_date IS NOT NULL
    `).run();
  }
  addColumn('deadline_confidence TEXT');
  if (addColumn(`doc_fetch_status TEXT DEFAULT 'none'`)) {
    db.prepare(`
      UPDATE tenders SET doc_fetch_status = 'complete'
      WHERE cached_dossiers IS NOT NULL AND cached_dossiers != '[]'
    `).run();
  }
  addColumn('needs_review INTEGER DEFAULT 0');
  addColumn('review_reason TEXT');

  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_tenders_ingestion ON tenders(ingestion_status)').run(); } catch {}
}

export function seedDefaultDomainTracks() {
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

export function seedPortalHealth() {
  // Ensure deleted_portals tracking table exists so user deletions persist across reboots
  db.exec(`
    CREATE TABLE IF NOT EXISTS deleted_portals (
      portal_id TEXT PRIMARY KEY,
      deleted_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Check if columns exist; if not, add them (schema migration)
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN access_mode TEXT DEFAULT "public"').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN verified_status TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN login_url TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN auth_username TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN auth_password TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE portal_health ADD COLUMN session_cookies TEXT').run(); } catch {}

  const deletedRows = (db.prepare('SELECT portal_id FROM deleted_portals').all() || []) as { portal_id: string }[];
  const deletedSet = new Set(deletedRows.map(r => r.portal_id));
  const activeDefinitions = PORTAL_DEFINITIONS.filter(p => !deletedSet.has(p.id));

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
      
      // Heal legacy DB records where a portal was previously flagged as offline_broken due to host TLS errors,
      // but our SSL-tolerant agent now supports it as public:
      if (p.accessMode === 'public') {
        try {
          db.prepare(`
            UPDATE portal_health 
            SET access_mode = 'public',
                verified_status = ?,
                status = 'online',
                last_error_message = NULL
            WHERE portal_id = ? AND access_mode = 'offline_broken' AND (verified_status LIKE '%TLS%' OR verified_status LIKE '%certificate%')
          `).run(p.verifiedStatus, p.id);
        } catch {}
      }

      // If loginUrl is defined in PORTAL_DEFINITIONS and not set in DB, populate it
      if (p.loginUrl) {
        try {
          db.prepare('UPDATE portal_health SET login_url = ? WHERE portal_id = ? AND (login_url IS NULL OR login_url = "")').run(p.loginUrl, p.id);
        } catch {}
      }

      // Repair any corrupted base_url (e.g. containing a file path) or root-downgraded auto-healed tenders_url
      try {
        const dbRow = db.prepare('SELECT base_url, tenders_url, verified_status FROM portal_health WHERE portal_id = ?').get(p.id) as any;
        if (dbRow) {
          let cleanBase = dbRow.base_url;
          try {
            cleanBase = new URL(dbRow.base_url).origin;
          } catch {
            cleanBase = p.baseUrl;
          }
          if (cleanBase !== dbRow.base_url) {
            db.prepare('UPDATE portal_health SET base_url = ? WHERE portal_id = ?').run(cleanBase, p.id);
          }

          // If a previous auto-heal downgraded a specific path (like /ActiveTenders.aspx) to a bare root "/", restore canonical tendersUrl
          const defPath = new URL(p.tendersUrl).pathname;
          const dbPath = new URL(dbRow.tenders_url).pathname;
          if (defPath && defPath !== '/' && (dbPath === '/' || dbPath === '') && String(dbRow.verified_status || '').startsWith('Auto-healed')) {
            db.prepare('UPDATE portal_health SET base_url = ?, tenders_url = ?, verified_status = ? WHERE portal_id = ?')
              .run(p.baseUrl, p.tendersUrl, p.verifiedStatus, p.id);
          }
        }
      } catch {}
    }
  });

  insertMany(activeDefinitions);
}
