import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  LATEST_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  addColumnIfMissing,
  getSchemaVersion,
  hasColumn,
  hasTable,
  initDatabase,
  runMigrations,
  setSchemaVersion,
  type Migration
} from '../../src/server/db/index.js';

const openDatabases: Database.Database[] = [];

function createMemoryDb(): Database.Database {
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  openDatabases.push(memDb);
  return memDb;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (openDatabases.length > 0) {
    const conn = openDatabases.pop();
    try {
      conn?.close();
    } catch {}
  }
});

describe('Versioned SQLite Migrations (PRAGMA user_version)', () => {
  it('migrates a fresh user_version=0 DB cleanly through v1..v7, creates tables/FTS5/indexes, and stamps sentinels', () => {
    const memDb = createMemoryDb();
    expect(getSchemaVersion(memDb)).toBe(0);

    const result = initDatabase(memDb);

    expect(LATEST_SCHEMA_VERSION).toBe(7);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.skipped).toBe(false);
    expect(result.applied.map(a => a.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(getSchemaVersion(memDb)).toBe(LATEST_SCHEMA_VERSION);

    const expectedTables = [
      'tenders',
      'corrigendum_logs',
      'pipeline_audit_logs',
      'domain_tracks',
      'portal_health',
      'app_settings',
      'pending_file_purges',
      'deleted_tenders',
      'document_ingest_jobs',
      'deleted_portals',
      'tenders_fts'
    ];
    for (const table of expectedTables) {
      expect(hasTable(memDb, table), table).toBe(true);
    }

    const indexes = (
      memDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map(r => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_tenders_canonical',
        'idx_tenders_status',
        'idx_tenders_closing',
        'idx_deleted_tenders_canonical',
        'idx_ingest_jobs_due',
        'idx_ingest_jobs_tender',
        'idx_tenders_ingestion',
        'idx_tenders_reference_norm'
      ])
    );

    const triggers = (
      memDb.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]
    ).map(r => r.name);
    expect(triggers).toEqual(
      expect.arrayContaining(['tenders_fts_ai', 'tenders_fts_ad', 'tenders_fts_au'])
    );

    const sentinels = (
      memDb.prepare('SELECT key FROM app_settings').all() as { key: string }[]
    ).map(r => r.key);
    expect(sentinels).toEqual(
      expect.arrayContaining([
        'migration_tenders_fts_v1_2026_11',
        'migration_epms_ppra_2026_11',
        'migration_audit_fixes_2026_11'
      ])
    );

    const trackCount = (memDb.prepare('SELECT COUNT(*) AS c FROM domain_tracks').get() as { c: number }).c;
    const portalCount = (memDb.prepare('SELECT COUNT(*) AS c FROM portal_health').get() as { c: number }).c;
    expect(trackCount).toBe(6);
    expect(portalCount).toBe(19);
    expect(memDb.prepare("SELECT portal_id FROM deleted_portals WHERE portal_id = 'epads'").get()).toBeDefined();
  });

  it('skips all migrations on steady-state second initDatabase(memDb) while running idempotent portal self-healing', () => {
    const memDb = createMemoryDb();
    initDatabase(memDb);

    // Mutate peef to simulate an older TLS error state that seedPortalHealth heals on startup
    memDb
      .prepare(`
        UPDATE portal_health
        SET access_mode = 'offline_broken',
            verified_status = 'Broken — Expired TLS certificate on host',
            status = 'error'
        WHERE portal_id = 'peef'
      `)
      .run();

    const execSpy = vi.spyOn(memDb, 'exec');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const second = initDatabase(memDb);

    expect(second).toEqual({
      fromVersion: LATEST_SCHEMA_VERSION,
      toVersion: LATEST_SCHEMA_VERSION,
      applied: [],
      skipped: true
    });
    expect(execSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('[DB] Applied migration'));

    const healed = memDb
      .prepare("SELECT access_mode, verified_status, status FROM portal_health WHERE portal_id = 'peef'")
      .get() as { access_mode: string; verified_status: string; status: string };
    expect(healed.access_mode).toBe('public');
    expect(healed.status).toBe('online');
    expect(healed.verified_status).toContain('SSL-tolerant');

    // Also prove runMigrations fast-path invokes zero migration handlers
    const upSpy = vi.fn();
    const customMemDb = createMemoryDb();
    setSchemaVersion(customMemDb, 1);
    const customRes = runMigrations(customMemDb, [{ version: 1, name: 'noop', up: upSpy }]);
    expect(customRes).toEqual({ fromVersion: 1, toVersion: 1, applied: [], skipped: true });
    expect(upSpy).not.toHaveBeenCalled();
  });

  it('upgrades a simulated pre-versioned production DB (user_version=0) without overwriting live tender provenance', () => {
    const memDb = createMemoryDb();

    // Build full pre-versioned schema manually, leaving user_version at 0
    for (const m of SCHEMA_MIGRATIONS) {
      if (m.version <= 5) {
        m.up(memDb);
      }
    }
    memDb.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('migration_epms_ppra_2026_11', '2026-11-01T00:00:00.000Z');
    memDb.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('migration_audit_fixes_2026_11', '{"at":"2026-11-01"}');
    expect(getSchemaVersion(memDb)).toBe(0);

    // Insert live production rows with specific provenance that must NOT be overwritten
    memDb.prepare(`
      INSERT INTO tenders (
        id, canonical_id, portal_id, portal_name, reference_no, reference_norm, title, organization,
        direct_url, closing_date, deadline_source, deadline_confidence, doc_fetch_status, cached_dossiers
      ) VALUES
        ('prod-1', 'prod-1', 'epms_ppra', 'Federal PPRA (EPMS)', 'PPRA-01', 'ppra01', 'Solar Mini Grid', 'AEDB', 'https://epms.ppra.gov.pk/t/1', '2026-12-20T10:00:00Z', 'primary_doc', 'high', 'partial', '[{"localPath":"a.pdf"}]'),
        ('prod-2', 'prod-2', 'sppra', 'Sindh SPPRA', 'SPPRA-02', 'sppra02', 'School Rehab', 'SEF', 'https://ppms.pprasindh.gov.pk/t/2', '2026-12-25T10:00:00Z', 'corrigendum_doc', 'high', 'failed', '[]'),
        ('prod-3', 'prod-3', 'pseb', 'PSEB', 'PSEB-03', 'pseb03', 'Cloud Hosting', 'PSEB', 'https://pseb.org.pk/t/3', '2026-12-30T10:00:00Z', NULL, NULL, 'none', '[{"localPath":"cached.pdf"}]')
    `).run();

    const result = initDatabase(memDb);

    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(getSchemaVersion(memDb)).toBe(LATEST_SCHEMA_VERSION);

    const row1 = memDb.prepare('SELECT deadline_source, doc_fetch_status FROM tenders WHERE id = ?').get('prod-1') as any;
    const row2 = memDb.prepare('SELECT deadline_source, doc_fetch_status FROM tenders WHERE id = ?').get('prod-2') as any;
    const row3 = memDb.prepare('SELECT deadline_source, doc_fetch_status FROM tenders WHERE id = ?').get('prod-3') as any;

    expect(row1).toEqual({ deadline_source: 'primary_doc', doc_fetch_status: 'partial' });
    expect(row2).toEqual({ deadline_source: 'corrigendum_doc', doc_fetch_status: 'failed' });
    expect(row3).toEqual({ deadline_source: null, doc_fetch_status: 'none' });
  });

  it('upgrades a partially migrated legacy backup (user_version=0 with v1 tables only) and runs missing backfills/FTS5', () => {
    const memDb = createMemoryDb();

    // Only apply v1 core tables
    SCHEMA_MIGRATIONS[0].up(memDb);
    expect(getSchemaVersion(memDb)).toBe(0);
    expect(hasColumn(memDb, 'tenders', 'ingestion_status')).toBe(false);
    expect(hasTable(memDb, 'tenders_fts')).toBe(false);

    // Seed legacy rows before migration
    memDb.prepare(`
      INSERT INTO portal_health (portal_id, portal_name, category, tier, base_url, tenders_url)
      VALUES ('epads', 'Federal PPRA (EPADS)', 'Federal', 'Tier 1', 'https://eprocure.gov.pk', 'https://eprocure.gov.pk/tenders')
    `).run();

    memDb.prepare(`
      INSERT INTO tenders (
        id, canonical_id, portal_id, portal_name, reference_no, title, organization,
        direct_url, closing_date, cached_dossiers, secondary_sources
      ) VALUES (
        'leg-1', 'leg-1', 'epms_ppra', 'Federal PPRA (EPMS)', 'PSDF / 2026-01',
        'Legacy Solar Hybrid Grid Tender', 'AEDB', 'https://epms.ppra.gov.pk/public/tenders/tender-details/TS100',
        '2026-12-15T10:00:00Z', '[{"localPath":"/api/dossiers/leg-1/doc.pdf"}]',
        '[{"portalName":"Federal PPRA (EPMS)","directUrl":"https://epms.ppra.gov.pk/dup"}]'
      ), (
        'leg-2', 'leg-2', 'epms_ppra', 'Federal PPRA (EPMS)', 'TS-2026-200',
        'Legacy Detail Page Tender', 'PPRA', 'https://epms.ppra.gov.pk/public/tenders/tender-details/TS200',
        '2026-12-20T10:00:00Z', '[]', '[]'
      )
    `).run();

    const result = initDatabase(memDb);

    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(getSchemaVersion(memDb)).toBe(LATEST_SCHEMA_VERSION);

    // Missing v2/v3/v4 columns & FTS5 created
    for (const col of ['result_expected_date', 'embedding', 'extracted_text', 'bid_brief', 'ingestion_status', 'deadline_source', 'doc_fetch_status', 'attachment_urls', 'reference_norm', 'publish_date_source']) {
      expect(hasColumn(memDb, 'tenders', col), col).toBe(true);
    }
    expect(hasColumn(memDb, 'domain_tracks', 'embedding')).toBe(true);
    expect(hasColumn(memDb, 'portal_health', 'last_error_code')).toBe(true);
    expect(hasColumn(memDb, 'portal_health', 'last_success_at')).toBe(true);
    expect(hasColumn(memDb, 'portal_health', 'pages_scanned')).toBe(true);
    expect(hasColumn(memDb, 'deleted_tenders', 'reason')).toBe(true);
    expect(hasTable(memDb, 'tenders_fts')).toBe(true);

    // Conditional v3 backfills + v4/v6 cleanups
    const leg1 = memDb
      .prepare('SELECT deadline_source, doc_fetch_status, reference_norm, secondary_sources FROM tenders WHERE id = ?')
      .get('leg-1') as any;
    expect(leg1.deadline_source).toBe('html_row');
    expect(leg1.doc_fetch_status).toBe('complete');
    expect(leg1.reference_norm).toBe('psdf202601');
    expect(JSON.parse(leg1.secondary_sources)).toEqual([]);

    const leg2 = memDb
      .prepare('SELECT doc_fetch_status FROM tenders WHERE id = ?')
      .get('leg-2') as { doc_fetch_status: string };
    expect(leg2.doc_fetch_status).toBe('pending');
    const jobs = memDb.prepare('SELECT label, url FROM document_ingest_jobs WHERE tender_id = ?').all('leg-2') as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].label).toBe('__detail_discover__');

    // FTS5 rebuilt for pre-existing rows
    const ftsHits = memDb.prepare(`SELECT rowid FROM tenders_fts WHERE tenders_fts MATCH '"Solar"*'`).all();
    expect(ftsHits).toHaveLength(1);

    // Legacy epads retired
    expect(memDb.prepare("SELECT portal_id FROM portal_health WHERE portal_id = 'epads'").get()).toBeUndefined();
    expect(memDb.prepare("SELECT portal_id FROM deleted_portals WHERE portal_id = 'epads'").get()).toBeDefined();
  });

  it('rolls back DDL/DML changes and PRAGMA user_version atomically when a migration fails', () => {
    const memDb = createMemoryDb();

    const migrations: Migration[] = [
      {
        version: 1,
        name: 'create_items',
        up: (database) => {
          database.exec('CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
          database.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run('i1', 'Initial');
        }
      },
      {
        version: 2,
        name: 'failing_alter_and_table',
        up: (database) => {
          addColumnIfMissing(database, 'items', 'extra', 'TEXT');
          database.exec('CREATE TABLE should_rollback (id TEXT PRIMARY KEY)');
          database.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run('i2', 'ShouldRollback');
          throw new Error('Simulated migration failure');
        }
      }
    ];

    expect(() => runMigrations(memDb, migrations)).toThrow('Simulated migration failure');

    // v1 succeeded and committed, v2 rolled back completely
    expect(getSchemaVersion(memDb)).toBe(1);
    expect(hasTable(memDb, 'items')).toBe(true);
    expect(hasColumn(memDb, 'items', 'extra')).toBe(false);
    expect(hasTable(memDb, 'should_rollback')).toBe(false);
    const rows = memDb.prepare('SELECT id FROM items').all() as { id: string }[];
    expect(rows.map(r => r.id)).toEqual(['i1']);
  });

  it('throws on forward-version databases where PRAGMA user_version > LATEST_SCHEMA_VERSION', () => {
    const memDb = createMemoryDb();
    setSchemaVersion(memDb, LATEST_SCHEMA_VERSION + 3);

    expect(() => initDatabase(memDb)).toThrow(/newer than supported version/i);
    expect(() => runMigrations(memDb, SCHEMA_MIGRATIONS)).toThrow(/newer than supported version/i);
    expect(getSchemaVersion(memDb)).toBe(LATEST_SCHEMA_VERSION + 3);
  });

  it('rejects non-sequential, duplicate, or invalid migration definitions and versions', () => {
    const memDb = createMemoryDb();
    const noop = () => {};

    expect(() =>
      runMigrations(memDb, [
        { version: 1, name: 'v1', up: noop },
        { version: 3, name: 'v3_gap', up: noop }
      ])
    ).toThrow(/Non-sequential/i);

    expect(() =>
      runMigrations(memDb, [
        { version: 1, name: 'v1', up: noop },
        { version: 1, name: 'v1_dup', up: noop }
      ])
    ).toThrow(/Duplicate/i);

    expect(() =>
      runMigrations(memDb, [{ version: 2, name: 'starts_at_2', up: noop }])
    ).toThrow(/Non-sequential/i);

    expect(() =>
      runMigrations(memDb, [{ version: 0, name: 'zero_version', up: noop }])
    ).toThrow(/Invalid migration version/i);

    expect(() => setSchemaVersion(memDb, -1)).toThrow(/Invalid SQLite user_version/i);
    expect(() => setSchemaVersion(memDb, 1.5)).toThrow(/Invalid SQLite user_version/i);
  });

  it('addColumnIfMissing adds missing columns, returns false when present, and propagates SQL errors without silent catch', () => {
    const memDb = createMemoryDb();
    memDb.exec('CREATE TABLE sample (id TEXT PRIMARY KEY)');

    expect(addColumnIfMissing(memDb, 'sample', 'note', 'TEXT')).toBe(true);
    expect(addColumnIfMissing(memDb, 'sample', 'note', 'TEXT')).toBe(false);
    expect(hasColumn(memDb, 'sample', 'note')).toBe(true);
    expect(() => addColumnIfMissing(memDb, 'missing_table', 'col', 'TEXT')).toThrow();
  });

  it('v7 normalizes stale tenders.portal_name against portal_health.portal_name and migrates legacy epads tenders to epms_ppra', () => {
    const memDb = createMemoryDb();

    // Run migrations v1..v6 only
    runMigrations(memDb, SCHEMA_MIGRATIONS.slice(0, 6));
    expect(getSchemaVersion(memDb)).toBe(6);

    // Seed portal_health rows including a renamed portal
    memDb.prepare(`
      INSERT INTO portal_health (portal_id, portal_name, category, tier, base_url, tenders_url)
      VALUES
        ('epms_ppra', 'Federal PPRA (EPMS)', 'Regulatory', 'http', 'https://epms.ppra.gov.pk', 'https://epms.ppra.gov.pk/public/tenders'),
        ('sppra', 'Sindh SPPRA (Renamed)', 'Regulatory', 'http', 'https://ppms.pprasindh.gov.pk', 'https://ppms.pprasindh.gov.pk/PPMS')
    `).run();

    // Insert a legacy epads tender and a tender with a stale portal_name
    memDb.prepare(`
      INSERT INTO tenders (
        id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url
      ) VALUES
        ('t-epads-old', 't-epads-old', 'epads', 'Federal PPRA (EPADS)', 'EP-01', 'Legacy EPADS Tender', 'PPRA', 'https://eprocure.gov.pk/t/1'),
        ('t-sppra-stale', 't-sppra-stale', 'sppra', 'Sindh SPPRA Old Name', 'SP-02', 'Sindh Roads Tender', 'Works Dept', 'https://ppms.pprasindh.gov.pk/t/2')
    `).run();

    const result = initDatabase(memDb);
    expect(result.fromVersion).toBe(6);
    expect(result.toVersion).toBe(7);
    expect(result.applied.map(a => a.version)).toEqual([7]);

    const epadsRow = memDb.prepare('SELECT portal_id, portal_name FROM tenders WHERE id = ?').get('t-epads-old') as {
      portal_id: string;
      portal_name: string;
    };
    expect(epadsRow).toEqual({
      portal_id: 'epms_ppra',
      portal_name: 'Federal PPRA (EPMS)'
    });

    const sppraRow = memDb.prepare('SELECT portal_id, portal_name FROM tenders WHERE id = ?').get('t-sppra-stale') as {
      portal_id: string;
      portal_name: string;
    };
    expect(sppraRow).toEqual({
      portal_id: 'sppra',
      portal_name: 'Sindh SPPRA (Renamed)'
    });
  });
});
