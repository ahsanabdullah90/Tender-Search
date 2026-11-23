import type Database from 'better-sqlite3';
import { db } from './connection.js';
import {
  type Migration,
  type MigrationRunResult,
  addColumnIfMissing,
  runMigrations
} from './migrations.js';
import { sanitizeOriginUrl } from '../../shared/documentUtils.js';
import { PORTAL_DEFINITIONS } from '../domain/portalList.js';
import { backfillExistingTenderDocumentJobs } from './repositories/ingestJobsRepo.js';
import { backfillReferenceNorms, removeSelfSecondarySources } from './repositories/tendersRepo.js';

export const SCHEMA_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline_core_tables',
    up: (database) => {
      database.exec(`
        -- 1. Tenders Table
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

        -- 10. Deleted Portals (tracks intentionally deleted portals so restarts do not re-seed them)
        CREATE TABLE IF NOT EXISTS deleted_portals (
          portal_id TEXT PRIMARY KEY,
          deleted_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }
  },
  {
    version: 2,
    name: 'tenders_embeddings_bid_brief_and_portal_error_code',
    up: (database) => {
      addColumnIfMissing(database, 'tenders', 'result_expected_date', 'TEXT');
      addColumnIfMissing(database, 'tenders', 'embedding', 'BLOB');
      addColumnIfMissing(database, 'tenders', 'semantic_score', 'REAL DEFAULT 0');
      addColumnIfMissing(database, 'tenders', 'extracted_text', "TEXT DEFAULT ''");
      addColumnIfMissing(database, 'tenders', 'bid_brief', 'TEXT');
      addColumnIfMissing(database, 'domain_tracks', 'embedding', 'BLOB');
      addColumnIfMissing(database, 'portal_health', 'last_error_code', 'TEXT');
    }
  },
  {
    version: 3,
    name: 'ingestion_provenance_columns_and_backfills',
    up: (database) => {
      /**
       * Ingestion-pipeline provenance columns (docs/13-ingestion-pipeline-plan.md, Phase 1):
       *   ingestion_status    'staging' | 'ready' | 'failed_verification'  (staging rows are hidden from every read path)
       *   deadline_source     'corrigendum_doc' | 'primary_doc' | 'html_detail' | 'html_row' | 'manual' | NULL
       *   deadline_confidence 'high' | 'medium' | 'low' | NULL
       *   doc_fetch_status    'none' | 'pending' | 'partial' | 'complete' | 'failed'
       *   needs_review        1 when the operator must confirm something (e.g. a corrigendum moved the deadline earlier)
       *   review_reason       human-readable reason for needs_review
       *
       * Existing rows are backfilled only when the migration actually adds the column, so pre-versioned
       * production databases (where the pipeline already populated these columns) are never overwritten.
       */
      addColumnIfMissing(database, 'tenders', 'ingestion_status', "TEXT DEFAULT 'ready'");
      if (addColumnIfMissing(database, 'tenders', 'deadline_source', 'TEXT')) {
        database.prepare(`
          UPDATE tenders
          SET deadline_source = CASE WHEN portal_id = 'manual' THEN 'manual' ELSE 'html_row' END
          WHERE closing_date IS NOT NULL
        `).run();
      }
      addColumnIfMissing(database, 'tenders', 'deadline_confidence', 'TEXT');
      if (addColumnIfMissing(database, 'tenders', 'doc_fetch_status', "TEXT DEFAULT 'none'")) {
        database.prepare(`
          UPDATE tenders SET doc_fetch_status = 'complete'
          WHERE cached_dossiers IS NOT NULL AND cached_dossiers != '[]'
        `).run();
      }
      addColumnIfMissing(database, 'tenders', 'needs_review', 'INTEGER DEFAULT 0');
      addColumnIfMissing(database, 'tenders', 'review_reason', 'TEXT');
      addColumnIfMissing(database, 'tenders', 'attachment_urls', "TEXT DEFAULT '[]'");

      database.prepare('CREATE INDEX IF NOT EXISTS idx_tenders_ingestion ON tenders(ingestion_status)').run();
      backfillExistingTenderDocumentJobs(database);
    }
  },
  {
    version: 4,
    name: 'audit_fix_columns_and_reference_index',
    up: (database) => {
      /**
       * Columns added by the docs/16 audit fixes:
       *   tenders.reference_norm         one normalisation of reference_no for exact matching (C1)
       *   tenders.publish_date_source    'listing' | 'upload_folder' (an upload-folder date is never used for ageing, A2)
       *   deleted_tenders.reason         'user' | 'auto-expired' | 'stale' | 'no-track-match' | 'legacy' (F4)
       *   portal_health.last_success_at  last scan that completed without a connection error (B6)
       *   portal_health.pages_scanned    listing pages read in the last scan (F1)
       */
      addColumnIfMissing(database, 'tenders', 'reference_norm', 'TEXT');
      addColumnIfMissing(database, 'tenders', 'publish_date_source', 'TEXT');
      addColumnIfMissing(database, 'deleted_tenders', 'reason', "TEXT DEFAULT 'legacy'");
      addColumnIfMissing(database, 'portal_health', 'last_success_at', 'TEXT');
      addColumnIfMissing(database, 'portal_health', 'pages_scanned', 'INTEGER DEFAULT 0');
      database.prepare('CREATE INDEX IF NOT EXISTS idx_tenders_reference_norm ON tenders(reference_norm)').run();
    }
  },
  {
    version: 5,
    name: 'tenders_fts5_index_and_triggers',
    up: (database) => {
      /**
       * External-content SQLite FTS5 index over tenders + extracted PDF/DOCX text (`tenders_fts`).
       * Triggers keep inserts, updates, and deletes synchronized automatically regardless of write path.
       */
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tenders_fts USING fts5(
          title,
          organization,
          reference_no,
          portal_name,
          description,
          extracted_text,
          content='tenders',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS tenders_fts_ai AFTER INSERT ON tenders BEGIN
          INSERT INTO tenders_fts(rowid, title, organization, reference_no, portal_name, description, extracted_text)
          VALUES (new.rowid, new.title, new.organization, new.reference_no, new.portal_name, new.description, new.extracted_text);
        END;

        CREATE TRIGGER IF NOT EXISTS tenders_fts_ad AFTER DELETE ON tenders BEGIN
          INSERT INTO tenders_fts(tenders_fts, rowid, title, organization, reference_no, portal_name, description, extracted_text)
          VALUES ('delete', old.rowid, old.title, old.organization, old.reference_no, old.portal_name, old.description, old.extracted_text);
        END;

        CREATE TRIGGER IF NOT EXISTS tenders_fts_au
        AFTER UPDATE OF title, organization, reference_no, portal_name, description, extracted_text ON tenders BEGIN
          INSERT INTO tenders_fts(tenders_fts, rowid, title, organization, reference_no, portal_name, description, extracted_text)
          VALUES ('delete', old.rowid, old.title, old.organization, old.reference_no, old.portal_name, old.description, old.extracted_text);
          INSERT INTO tenders_fts(rowid, title, organization, reference_no, portal_name, description, extracted_text)
          VALUES (new.rowid, new.title, new.organization, new.reference_no, new.portal_name, new.description, new.extracted_text);
        END;
      `);

      const KEY = 'migration_tenders_fts_v1_2026_11';
      const done = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
      if (!done) {
        database.exec(`INSERT INTO tenders_fts(tenders_fts) VALUES('rebuild');`);
        database.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(KEY, new Date().toISOString());
      }
    }
  },
  {
    version: 6,
    name: 'retire_epads_and_audit_data_cleanup',
    up: (database) => {
      // One-time migration: retire legacy Federal EPADS source in favor of open Federal PPRA (EPMS)
      // while preserving historical saved tenders in the tenders table.
      const EPMS_MIGRATION_KEY = 'migration_epms_ppra_2026_11';
      const migrated = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(EPMS_MIGRATION_KEY) as { value: string } | undefined;
      if (!migrated) {
        database.prepare("DELETE FROM portal_health WHERE portal_id = 'epads'").run();
        database.prepare("INSERT OR IGNORE INTO deleted_portals (portal_id) VALUES ('epads')").run();
        database.prepare("DELETE FROM deleted_portals WHERE portal_id = 'epms_ppra'").run();
        database.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(EPMS_MIGRATION_KEY, new Date().toISOString());
      }

      runAuditCleanupOnce(database);
    }
  },
  {
    version: 7,
    name: 'sync_tender_portal_names_and_retire_epads_tenders',
    up: (database) => {
      database.prepare(`
        UPDATE tenders
        SET portal_id = 'epms_ppra',
            portal_name = COALESCE(
              (SELECT portal_name FROM portal_health WHERE portal_id = 'epms_ppra'),
              'Federal PPRA (EPMS)'
            )
        WHERE portal_id = 'epads'
      `).run();

      database.prepare(`
        UPDATE tenders
        SET portal_name = (
          SELECT ph.portal_name FROM portal_health ph WHERE ph.portal_id = tenders.portal_id
        )
        WHERE EXISTS (
          SELECT 1 FROM portal_health ph
          WHERE ph.portal_id = tenders.portal_id
            AND ph.portal_name IS NOT NULL
            AND ph.portal_name != ''
            AND ph.portal_name != tenders.portal_name
        )
      `).run();
    }
  }
];

export const LATEST_SCHEMA_VERSION = SCHEMA_MIGRATIONS.length;

export function initDatabase(database: Database.Database = db): MigrationRunResult {
  const result = runMigrations(database, SCHEMA_MIGRATIONS);
  seedDefaultDomainTracks(database);
  seedPortalHealth(database);
  return result;
}

/**
 * One-time data cleanup for the docs/16 audit (runs once per database, recorded in app_settings):
 *  - references that fail the stricter validation are cleared, the rest normalised (F3, C1);
 *  - "Also listed on" entries naming the tender's own portal are removed (B1);
 *  - site images (stamps, logos under /img/) are removed as tender links and queued documents (B5);
 *  - navigation rows ingested as tenders ("All Newspapers ...") are removed (C2);
 *  - item counts of portals whose last scan failed are reset to 0 (B6).
 */
export function runAuditCleanupOnce(database: Database.Database = db): void {
  const KEY = 'migration_audit_fixes_2026_11';
  const done = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (done) return;
  const report = runAuditCleanup(database);
  database.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify({ ...report, at: new Date().toISOString() }));
  if (Object.values(report).some(v => v > 0)) console.log('[Migration] docs/16 audit cleanup:', JSON.stringify(report));
}

export function runAuditCleanup(database: Database.Database = db): Record<string, number> {
  const refs = backfillReferenceNorms(database);
  const selfSources = removeSelfSecondarySources(database);

  // Site-chrome images used as a tender's link: fall back to the first real document link, or the portal listing.
  const SITE_IMAGE = (u: string) => /\/(?:img|images|assets|static|theme|themes)\/[^?]*\.(?:png|jpe?g|gif|webp|svg)(?:\?|$)/i.test(u) || /stamp|seal|badge|watermark|logo/i.test(u.split('/').pop() || '');
  const rows = database.prepare(`SELECT t.id, t.direct_url, t.attachment_urls, p.tenders_url FROM tenders t LEFT JOIN portal_health p ON p.portal_id = t.portal_id`).all() as { id: string; direct_url: string; attachment_urls: string | null; tenders_url: string | null }[];
  let imageLinksFixed = 0;
  for (const r of rows) {
    if (!r.direct_url || !SITE_IMAGE(r.direct_url)) continue;
    let attachments: string[] = [];
    try { attachments = JSON.parse(r.attachment_urls || '[]'); } catch {}
    const replacement = attachments.find(u => !SITE_IMAGE(u)) || r.tenders_url || r.direct_url;
    database.prepare('UPDATE tenders SET direct_url = ?, attachment_urls = ? WHERE id = ?').run(replacement, JSON.stringify(attachments.filter(u => !SITE_IMAGE(u))), r.id);
    imageLinksFixed++;
  }
  const jobs = database.prepare(`SELECT id, url FROM document_ingest_jobs WHERE status IN ('pending', 'failed')`).all() as { id: string; url: string }[];
  let imageJobsRemoved = 0;
  for (const j of jobs) {
    if (SITE_IMAGE(j.url)) {
      database.prepare('DELETE FROM document_ingest_jobs WHERE id = ?').run(j.id);
      imageJobsRemoved++;
    }
  }

  // Navigation rows: link is the portal's own home/listing page, and no date, reference or document.
  const navRows = database.prepare(`
    SELECT t.id FROM tenders t JOIN portal_health p ON p.portal_id = t.portal_id
    WHERE t.pipeline_status = 'New Opportunity'
      AND RTRIM(t.direct_url, '/') IN (RTRIM(p.base_url, '/'), RTRIM(p.tenders_url, '/'))
      AND t.closing_date IS NULL AND t.reference_no IS NULL
      AND (t.cached_dossiers IS NULL OR t.cached_dossiers = '[]')
      AND (t.attachment_urls IS NULL OR t.attachment_urls = '[]')
      AND (t.title LIKE 'All Newspapers%' OR t.title LIKE 'All Categories%' OR t.title LIKE 'Newspapers%')
  `).all() as { id: string }[];
  for (const n of navRows) {
    database.prepare('DELETE FROM document_ingest_jobs WHERE tender_id = ?').run(n.id);
    database.prepare('DELETE FROM tenders WHERE id = ?').run(n.id);
  }

  const staleCounts = database.prepare(`UPDATE portal_health SET last_items_found = 0 WHERE status = 'error' AND last_items_found > 0`).run().changes;

  return {
    referencesCleared: refs.cleared,
    referencesNormalized: refs.normalized,
    selfSecondarySourcesRemoved: selfSources,
    imageLinksFixed,
    imageJobsRemoved,
    navigationRowsRemoved: navRows.length,
    staleItemCountsReset: staleCounts
  };
}

export function seedDefaultDomainTracks(database: Database.Database = db): void {
  const count = (database.prepare('SELECT COUNT(*) as count FROM domain_tracks').get() as { count: number }).count;
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

  const insertStmt = database.prepare(`
    INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active)
    VALUES (?, ?, ?, ?, 1)
  `);

  const insertMany = database.transaction((tracks: typeof defaultTracks) => {
    for (const t of tracks) {
      insertStmt.run(t.id, t.name, JSON.stringify(t.positive), JSON.stringify(t.negative));
    }
  });

  insertMany(defaultTracks);
}

export function seedPortalHealth(database: Database.Database = db): void {
  const deletedRows = (database.prepare('SELECT portal_id FROM deleted_portals').all() || []) as { portal_id: string }[];
  const deletedSet = new Set(deletedRows.map(r => r.portal_id));
  const activeDefinitions = PORTAL_DEFINITIONS.filter(p => !deletedSet.has(p.id));

  // INSERT OR IGNORE so user edits to URLs, access modes, tiers, and statuses are NEVER overwritten on reboot
  const insertStmt = database.prepare(`
    INSERT OR IGNORE INTO portal_health (
      portal_id, portal_name, category, tier, base_url, tenders_url, login_url,
      status, last_items_found, consecutive_zero_yields, access_mode, verified_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);

  const insertMany = database.transaction((portals: typeof PORTAL_DEFINITIONS) => {
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
          database.prepare(`
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
          database.prepare('UPDATE portal_health SET login_url = ? WHERE portal_id = ? AND (login_url IS NULL OR login_url = "")').run(p.loginUrl, p.id);
        } catch {}
      }

      // Repair any corrupted base_url (e.g. containing a file path) or root-downgraded auto-healed tenders_url
      try {
        const dbRow = database.prepare('SELECT base_url, tenders_url, verified_status FROM portal_health WHERE portal_id = ?').get(p.id) as any;
        if (dbRow) {
          const cleanBase = sanitizeOriginUrl(dbRow.base_url, p.baseUrl);
          if (cleanBase && cleanBase !== dbRow.base_url) {
            database.prepare('UPDATE portal_health SET base_url = ? WHERE portal_id = ?').run(cleanBase, p.id);
          }

          // If a previous auto-heal downgraded a specific path (like /ActiveTenders.aspx) to a bare root "/", restore canonical tendersUrl
          const defPath = new URL(p.tendersUrl).pathname;
          const dbPath = new URL(dbRow.tenders_url).pathname;
          if (defPath && defPath !== '/' && (dbPath === '/' || dbPath === '') && String(dbRow.verified_status || '').startsWith('Auto-healed')) {
            database.prepare('UPDATE portal_health SET base_url = ?, tenders_url = ?, verified_status = ? WHERE portal_id = ?')
              .run(p.baseUrl, p.tendersUrl, p.verifiedStatus, p.id);
          }

          // Rule 7 sync: upgrade known dead legacy domains to canonical definitions from PORTAL_DEFINITIONS
          if (p.id === 'sppra' && String(dbRow.tenders_url).includes('e.pprasindh.gov.pk')) {
            database.prepare('UPDATE portal_health SET base_url = ?, tenders_url = ?, verified_status = ? WHERE portal_id = ?')
              .run(p.baseUrl, p.tendersUrl, p.verifiedStatus, p.id);
          }
          if (
            p.id === 'kppra' &&
            (String(dbRow.tenders_url).includes('kp.eprocure.gov.pk') ||
              dbRow.tenders_url !== p.tendersUrl ||
              dbRow.access_mode === 'offline_broken' ||
              dbRow.tier !== p.tier)
          ) {
            database.prepare(
              "UPDATE portal_health SET portal_name = ?, tier = ?, base_url = ?, tenders_url = ?, access_mode = ?, status = 'online', verified_status = ?, last_error_message = NULL, last_error_code = NULL WHERE portal_id = ?"
            ).run(p.name, p.tier, p.baseUrl, p.tendersUrl, p.accessMode, p.verifiedStatus, p.id);
          }
          if (
            p.id === 'punjab_eproc' &&
            (String(dbRow.base_url).startsWith('http://') ||
              String(dbRow.base_url).includes('ppra.punjab.gov.pk') ||
              String(dbRow.tenders_url).startsWith('http://'))
          ) {
            database.prepare('UPDATE portal_health SET base_url = ?, tenders_url = ? WHERE portal_id = ?')
              .run(p.baseUrl, p.tendersUrl, p.id);
          }
          if (
            p.id === 'gilgit' &&
            (String(dbRow.tenders_url).includes('gilgitbaltistan.gov.pk') ||
              dbRow.tenders_url !== p.tendersUrl ||
              dbRow.access_mode !== p.accessMode ||
              dbRow.category !== p.category)
          ) {
            database.prepare(
              "UPDATE portal_health SET portal_name = ?, category = ?, base_url = ?, tenders_url = ?, access_mode = ?, status = 'online', verified_status = ?, last_error_message = NULL, last_error_code = NULL WHERE portal_id = ?"
            ).run(p.name, p.category, p.baseUrl, p.tendersUrl, p.accessMode, p.verifiedStatus, p.id);
          }
        }
      } catch {}
    }
  });

  insertMany(activeDefinitions);
}
