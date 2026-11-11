import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  db,
  initDatabase,
  getAllTenders,
  getTenderById,
  updateTenderStatus,
  toggleTenderBookmark,
  updateTenderNotes,
  updateTenderResultDate,
  getAllDomainTracks,
  saveDomainTrack,
  deleteDomainTrack,
  reScoreTendersAgainstTracks,
  getPortalHealthList,
  getPortalById,
  createPortal,
  deletePortal,
  updatePortalHealth,
  savePortalCredentials,
  getPortalAuthCredentials,
  getUnacknowledgedCorrigenda,
  acknowledgeCorrigendum,
  getKpiStats,
  backupDatabase,
  backupNow,
  listBackups,
  getStorageStats,
  pruneDossiersForPassed,
  clearAllTenders,
  DATA_DIR,
  DOSSIERS_DIR,
  BACKUPS_DIR
} from '../../src/server/db.js';
import { findCanonicalMatch } from '../../src/server/deduplicator.js';
import {
  appendSecondarySource,
  slimPassedTenders,
  recordTenderSuppression,
  isTenderSuppressed
} from '../../src/server/db/repositories/tendersRepo.js';
import { runAuditCleanup } from '../../src/server/db/schema.js';

describe('Database and Repository Layer', () => {
  beforeEach(() => {
    initDatabase();
    // Clean data tables before each test
    db.prepare('DELETE FROM corrigendum_logs').run();
    db.prepare('DELETE FROM pipeline_audit_logs').run();
    db.prepare('DELETE FROM tenders').run();
  });

  describe('initDatabase & Schemas', () => {
    it('creates all necessary tables and columns', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);

      expect(tables).toContain('tenders');
      expect(tables).toContain('corrigendum_logs');
      expect(tables).toContain('pipeline_audit_logs');
      expect(tables).toContain('domain_tracks');
      expect(tables).toContain('portal_health');
    });

    it('seeds default domain tracks', () => {
      const tracks = getAllDomainTracks();
      expect(tracks.length).toBeGreaterThan(0);
      const trackNames = tracks.map(t => t.name);
      expect(trackNames).toContain('Construction & Civil Works');
      expect(trackNames).toContain('Solar & Clean Energy');
    });

    it('seeds portal health entries', () => {
      const portals = getPortalHealthList();
      expect(portals.length).toBeGreaterThan(0);
      const epads = portals.find(p => p.portal_id === 'epads');
      expect(epads).toBeDefined();
      expect(epads?.portal_name).toContain('Federal PPRA');
    });
  });

  describe('Tender Operations & CRUD', () => {
    const insertSampleTender = (id: string, overrides: Record<string, any> = {}) => {
      db.prepare(`
        INSERT INTO tenders (
          id, canonical_id, portal_id, portal_name, reference_no, title, organization,
          description, estimated_value, location, publish_date, closing_date,
          direct_url, secondary_sources, domain_tracks, matched_keywords,
          match_score, pipeline_status, is_bookmarked, status_notes, result_expected_date,
          cached_dossiers, has_corrigendum
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?
        )
      `).run(
        id,
        overrides.canonical_id || id,
        overrides.portal_id || 'epads',
        overrides.portal_name || 'Federal PPRA',
        overrides.reference_no || 'REF-2026-99',
        overrides.title || 'Procurement of High-Performance Laptops',
        overrides.organization || 'Higher Education Commission',
        overrides.description || 'Enterprise compute gear and accessories',
        overrides.estimated_value || 'PKR 15,000,000',
        overrides.location || 'Islamabad',
        overrides.publish_date || '2026-05-01',
        overrides.closing_date !== undefined ? overrides.closing_date : '2026-05-20T14:00:00+05:00',
        overrides.direct_url || 'https://example.com/tenders/99',
        JSON.stringify(overrides.secondary_sources || []),
        JSON.stringify(overrides.domain_tracks || ['Construction & Civil Works']),
        JSON.stringify(overrides.matched_keywords || ['construction']),
        overrides.match_score || 80,
        overrides.pipeline_status || 'New Opportunity',
        overrides.is_bookmarked || 0,
        overrides.status_notes || null,
        overrides.result_expected_date || null,
        JSON.stringify(overrides.cached_dossiers || []),
        overrides.has_corrigendum || 0
      );
    };

    it('retrieves tender by id and parses JSON fields correctly', () => {
      insertSampleTender('t-1');
      const tender = getTenderById('t-1');

      expect(tender).not.toBeNull();
      expect(tender?.id).toBe('t-1');
      expect(tender?.domain_tracks).toEqual(['Construction & Civil Works']);
      expect(tender?.matched_keywords).toEqual(['construction']);
      expect(tender?.secondary_sources).toEqual([]);
      expect(tender?.cached_dossiers).toEqual([]);
    });

    it('returns null when getting a non-existent tender id', () => {
      expect(getTenderById('non-existent')).toBeNull();
    });

    it('filters tenders by status', () => {
      insertSampleTender('t-1', { pipeline_status: 'New Opportunity' });
      insertSampleTender('t-2', { pipeline_status: 'Preparing Bid' });

      const newTenders = getAllTenders({ status: 'New Opportunity' });
      expect(newTenders.length).toBe(1);
      expect(newTenders[0].id).toBe('t-1');

      const preparingTenders = getAllTenders({ status: 'Preparing Bid' });
      expect(preparingTenders.length).toBe(1);
      expect(preparingTenders[0].id).toBe('t-2');
    });

    it('filters tenders by search term across title, reference_no, organization, and portal_name', () => {
      insertSampleTender('t-1', { title: 'Enterprise Cloud Deployment', reference_no: 'REF-CLOUD-1' });
      insertSampleTender('t-2', { organization: 'National Disaster Management', portal_name: 'Sindh SPPRA' });

      expect(getAllTenders({ search: 'Enterprise Cloud' }).length).toBe(1);
      expect(getAllTenders({ search: 'REF-CLOUD' }).length).toBe(1);
      expect(getAllTenders({ search: 'Disaster Management' }).length).toBe(1);
      expect(getAllTenders({ search: 'Sindh SPPRA' }).length).toBe(1);
      expect(getAllTenders({ search: 'NonExistentXYZ' }).length).toBe(0);
    });

    it('filters tenders by track name', () => {
      insertSampleTender('t-1', { domain_tracks: ['Solar & Clean Energy'] });
      insertSampleTender('t-2', { domain_tracks: ['Education & Learning'] });

      const solarTenders = getAllTenders({ track: 'Solar & Clean Energy' });
      expect(solarTenders.length).toBe(1);
      expect(solarTenders[0].id).toBe('t-1');
    });

    it('filters tenders by bookmarkedOnly', () => {
      insertSampleTender('t-1', { is_bookmarked: 1 });
      insertSampleTender('t-2', { is_bookmarked: 0 });

      const bookmarked = getAllTenders({ bookmarkedOnly: true });
      expect(bookmarked.length).toBe(1);
      expect(bookmarked[0].id).toBe('t-1');
    });

    it('filters tenders by corrigendumOnly', () => {
      insertSampleTender('t-1', { has_corrigendum: 1 });
      insertSampleTender('t-2', { has_corrigendum: 0 });

      const corrigenda = getAllTenders({ corrigendumOnly: true });
      expect(corrigenda.length).toBe(1);
      expect(corrigenda[0].id).toBe('t-1');
    });

    it('updates tender status and creates an audit log entry', () => {
      insertSampleTender('t-1', { pipeline_status: 'New Opportunity' });

      const success = updateTenderStatus('t-1', 'Under Review', 'Reviewing RFP terms');
      expect(success).toBe(true);

      const updated = getTenderById('t-1');
      expect(updated?.pipeline_status).toBe('Under Review');
      expect(updated?.status_notes).toBe('Reviewing RFP terms');

      const auditLogs = db.prepare('SELECT * FROM pipeline_audit_logs WHERE tender_id = ?').all('t-1') as any[];
      expect(auditLogs.length).toBe(1);
      expect(auditLogs[0].previous_status).toBe('New Opportunity');
      expect(auditLogs[0].new_status).toBe('Under Review');
      expect(auditLogs[0].notes).toBe('Reviewing RFP terms');
    });

    it('returns false when updating status of non-existent tender', () => {
      expect(updateTenderStatus('missing', 'Won')).toBe(false);
    });

    it('toggles tender bookmark state', () => {
      insertSampleTender('t-1', { is_bookmarked: 0 });

      const toggle1 = toggleTenderBookmark('t-1');
      expect(toggle1.success).toBe(true);
      expect(toggle1.is_bookmarked).toBe(1);

      const toggle2 = toggleTenderBookmark('t-1');
      expect(toggle2.success).toBe(true);
      expect(toggle2.is_bookmarked).toBe(0);

      expect(toggleTenderBookmark('missing').success).toBe(false);
    });

    it('updates tender notes and returns success boolean', () => {
      insertSampleTender('t-1');
      expect(updateTenderNotes('t-1', 'Updated bidding notes')).toBe(true);
      expect(getTenderById('t-1')?.status_notes).toBe('Updated bidding notes');
      expect(updateTenderNotes('missing', 'Note')).toBe(false);
    });

    it('updates tender result expected date', () => {
      insertSampleTender('t-1');
      expect(updateTenderResultDate('t-1', '2026-06-30')).toBe(true);
      expect(getTenderById('t-1')?.result_expected_date).toBe('2026-06-30');

      expect(updateTenderResultDate('t-1', null)).toBe(true);
      expect(getTenderById('t-1')?.result_expected_date).toBeNull();

      expect(updateTenderResultDate('missing', '2026-06-30')).toBe(false);
    });

    it('clears unreviewed tenders only when requested', () => {
      insertSampleTender('t-1', { pipeline_status: 'New Opportunity' });
      insertSampleTender('t-2', { pipeline_status: 'Preparing Bid' });

      clearAllTenders(true);

      expect(getTenderById('t-1')).toBeNull();
      expect(getTenderById('t-2')).not.toBeNull();
    });

    it('clears all tenders when unreviewedOnly is false', () => {
      insertSampleTender('t-1', { pipeline_status: 'New Opportunity' });
      insertSampleTender('t-2', { pipeline_status: 'Preparing Bid' });

      clearAllTenders(false);

      expect(getTenderById('t-1')).toBeNull();
      expect(getTenderById('t-2')).toBeNull();
    });
  });

  describe('Corrigendum & Audit Logs', () => {
    it('manages unacknowledged corrigenda logs and acknowledgments', () => {
      // Insert a parent tender
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url)
        VALUES ('t-corr', 't-corr', 'epads', 'Federal PPRA', 'REF-1', 'IT Project', 'Gov Org', 'https://example.com')
      `).run();

      db.prepare(`
        INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
        VALUES ('corr-1', 't-corr', 'closing_date', '2026-05-10', '2026-05-20', 0)
      `).run();

      const unack = getUnacknowledgedCorrigenda();
      expect(unack.length).toBe(1);
      expect(unack[0].id).toBe('corr-1');
      expect(unack[0].tender_title).toBe('IT Project');
      expect(unack[0].portal_name).toBe('Federal PPRA');

      acknowledgeCorrigendum('corr-1');
      expect(getUnacknowledgedCorrigenda().length).toBe(0);
    });

    it('handles multiple corrigenda and only clears tender flag when all are acknowledged', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, has_corrigendum)
        VALUES ('t-corr-multi', 't-corr-multi', 'epads', 'Federal PPRA', 'REF-M', 'Multi Corr', 'Gov Org', 'https://example.com', 1)
      `).run();
      db.prepare(`
        INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
        VALUES ('corr-m1', 't-corr-multi', 'closing_date', '2026-05-10', '2026-05-20', 0),
               ('corr-m2', 't-corr-multi', 'document', 'old.pdf', 'new.pdf', 0)
      `).run();

      expect(acknowledgeCorrigendum('non-existent-corr')).toBe(false);

      // Acknowledge first corrigendum
      expect(acknowledgeCorrigendum('corr-m1')).toBe(true);
      const tenderMid = getTenderById('t-corr-multi');
      expect(tenderMid?.has_corrigendum).toBe(1);

      // Acknowledge second corrigendum
      expect(acknowledgeCorrigendum('corr-m2')).toBe(true);
      const tenderAfter = getTenderById('t-corr-multi');
      expect(tenderAfter?.has_corrigendum).toBe(0);
    });
  });

  describe('Domain Tracks Management & Rescoring', () => {
    it('saves a new domain track and retrieves it', () => {
      const trackId = saveDomainTrack({
        name: 'Healthcare Equipment',
        positive_keywords: ['ventilators', 'monitors'],
        negative_keywords: ['software'],
        is_active: 1
      });

      expect(trackId).toBeDefined();

      const all = getAllDomainTracks();
      const found = all.find(t => t.id === trackId);
      expect(found).toBeDefined();
      expect(found?.name).toBe('Healthcare Equipment');
      expect(found?.positive_keywords).toEqual(['ventilators', 'monitors']);
    });

    it('updates an existing domain track', () => {
      const trackId = saveDomainTrack({
        name: 'Track To Update',
        positive_keywords: ['old'],
        negative_keywords: []
      });

      saveDomainTrack({
        id: trackId,
        name: 'Track Updated',
        positive_keywords: ['new', 'updated'],
        negative_keywords: ['ignore'],
        is_active: 0
      });

      const all = getAllDomainTracks();
      const updated = all.find(t => t.id === trackId);
      expect(updated?.name).toBe('Track Updated');
      expect(updated?.positive_keywords).toEqual(['new', 'updated']);
      expect(updated?.is_active).toBe(0);
    });

    it('deletes a domain track', () => {
      const trackId = saveDomainTrack({
        name: 'Track To Delete',
        positive_keywords: ['delete-me'],
        negative_keywords: []
      });

      deleteDomainTrack(trackId);
      const all = getAllDomainTracks();
      expect(all.find(t => t.id === trackId)).toBeUndefined();
    });

    it('re-scores all existing tenders against active domain tracks', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, domain_tracks, matched_keywords, match_score)
        VALUES ('t-rescore', 't-rescore', 'epads', 'Federal PPRA', 'REF-RESCORE', 'Procurement of Solar Panels and Inverters', 'NADRA', 'https://example.com', '[]', '[]', 0)
      `).run();

      reScoreTendersAgainstTracks();

      const rescoredTender = getTenderById('t-rescore');
      expect(rescoredTender?.domain_tracks).toContain('Solar & Clean Energy');
      expect(rescoredTender?.match_score).toBeGreaterThanOrEqual(30);
    });
  });

  describe('Portal Health & Credentials', () => {
    it('updates portal operational health safely', () => {
      updatePortalHealth('epads', {
        status: 'scanning',
        last_items_found: 12,
        consecutive_zero_yields: 0,
        last_error_message: 'Scan running'
      });

      const portals = getPortalHealthList();
      const epads = portals.find(p => p.portal_id === 'epads');
      expect(epads?.status).toBe('scanning');
      expect(epads?.last_items_found).toBe(12);
      expect(epads?.last_error_message).toBe('Scan running');
    });

    it('saves and retrieves portal credentials', () => {
      savePortalCredentials('epads', {
        username: 'bidder_alpha',
        password: 'secure_password_123',
        loginUrl: 'https://epms.ppra.gov.pk/login'
      });

      const creds = getPortalAuthCredentials('epads');
      expect(creds?.username).toBe('bidder_alpha');
      expect(creds?.password).toBe('secure_password_123');
      expect(creds?.loginUrl).toBe('https://epms.ppra.gov.pk/login');
    });

    it('returns null credentials for unknown portal', () => {
      expect(getPortalAuthCredentials('unknown_portal')).toBeNull();
    });
  });

  describe('KPIs, Backups, and Storage Operations', () => {
    it('calculates accurate KPI stats for dashboard cards', () => {
      const closingTomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date, pipeline_status)
        VALUES ('kpi-1', 'kpi-1', 'epads', 'PPRA', 'REF-K1', 'Tender 1', 'Org 1', 'http://1', ?, 'New Opportunity')
      `).run(closingTomorrow);

      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, pipeline_status)
        VALUES ('kpi-2', 'kpi-2', 'epads', 'PPRA', 'REF-K2', 'Tender 2', 'Org 2', 'http://2', 'Preparing Bid')
      `).run();

      const stats = getKpiStats();
      expect(stats.totalTracked).toBe(2);
      expect(stats.closingSoon).toBe(1);
      expect(stats.inPipeline).toBe(1);
    });

    it('creates backups and lists backup history', async () => {
      const result = await backupNow();
      expect(result).not.toBeNull();
      expect(result?.name.startsWith('tender_tracker_')).toBe(true);

      const backups = listBackups();
      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(backups.map(b => b.name)).toContain(result?.name);
    });

    it('returns storage stats including total bytes and passed tender counts', () => {
      const stats = getStorageStats();
      expect(typeof stats.total_bytes).toBe('number');
      expect(typeof stats.passed_bytes).toBe('number');
      expect(typeof stats.passed_tenders).toBe('number');
      expect(typeof stats.tenders_with_documents).toBe('number');
    });

    it('prunes dossiers for passed tenders', () => {
      // Create a test dossier directory and dummy file for a passed tender
      const passedId = 't-passed-1';
      const tenderDossierDir = path.join(DOSSIERS_DIR, passedId);
      fs.mkdirSync(tenderDossierDir, { recursive: true });
      fs.writeFileSync(path.join(tenderDossierDir, 'rfp.pdf'), 'Dummy PDF content for tender');

      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, pipeline_status)
        VALUES (?, ?, 'epads', 'PPRA', 'REF-P1', 'Passed Tender', 'Org', 'http://passed', 'Passed')
      `).run(passedId, passedId);

      const result = pruneDossiersForPassed();
      expect(result.tenders).toBeGreaterThanOrEqual(1);
      expect(result.freed_bytes).toBeGreaterThan(0);
      expect(fs.existsSync(tenderDossierDir)).toBe(false);

      // Passed tender without directory, nested directory, and path traversal attempt
      const nestedDir = path.join(DOSSIERS_DIR, 't-passed-nested', 'sub');
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(nestedDir, 'spec.pdf'), 'nested content');
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, pipeline_status)
        VALUES ('t-passed-nested', 't-passed-nested', 'epads', 'PPRA', 'REF-PN', 'Nested', 'Org', 'http://1', 'Passed'),
               ('t-passed-nodir', 't-passed-nodir', 'epads', 'PPRA', 'REF-P0', 'No Dir', 'Org', 'http://2', 'Passed'),
               ('../escape-id', '../escape-id', 'epads', 'PPRA', 'REF-PE', 'Escape', 'Org', 'http://3', 'Passed')
      `).run();

      const stats = getStorageStats();
      expect(stats.passed_bytes).toBeGreaterThan(0);

      const result2 = pruneDossiersForPassed();
      expect(result2.tenders).toBeGreaterThanOrEqual(1);
    });

    it('handles backup failures gracefully', async () => {
      const originalBackup = db.backup;
      (db as any).backup = vi.fn().mockRejectedValue(new Error('Disk full'));
      const backupResult = await backupNow();
      expect(backupResult).toBeNull();
      (db as any).backup = originalBackup;
    });

    it('prunes daily backups older than 14 days in backupDatabase', async () => {
      const oldBackupPath = path.join(BACKUPS_DIR, 'tender_tracker_backup_old.db');
      fs.writeFileSync(oldBackupPath, 'old backup');
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      fs.utimesSync(oldBackupPath, new Date(fifteenDaysAgo), new Date(fifteenDaysAgo));

      const res = await backupDatabase();
      expect(res.success).toBe(true);
      expect(fs.existsSync(oldBackupPath)).toBe(false);
    });

    it('skips daily backup if today already has a backup', async () => {
      const first = await backupDatabase();
      expect(first.success).toBe(true);
      const second = await backupDatabase();
      expect(second.success).toBe(true);
      expect(second.skipped).toBe(true);
    });

    it('sorts listBackups in descending order of created_at', async () => {
      const b1 = path.join(BACKUPS_DIR, 'tender_tracker_20261010_manual.db');
      const b2 = path.join(BACKUPS_DIR, 'tender_tracker_20261020_manual.db');
      fs.writeFileSync(b1, 'backup 1');
      fs.writeFileSync(b2, 'backup 2');
      fs.utimesSync(b1, new Date('2026-10-10T10:00:00Z'), new Date('2026-10-10T10:00:00Z'));
      fs.utimesSync(b2, new Date('2026-10-20T10:00:00Z'), new Date('2026-10-20T10:00:00Z'));

      const backups = listBackups();
      expect(backups.length).toBeGreaterThanOrEqual(2);
      expect(backups[0].created_at >= backups[1].created_at).toBe(true);
    });

    it('handles corrupted JSON safely in safeJsonParse', () => {
      db.prepare(`
        INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active)
        VALUES ('track-corrupt', 'Corrupt Track', '{invalid-json', '["bad"]', 1)
      `).run();

      const tracks = getAllDomainTracks();
      const corrupt = tracks.find(t => t.id === 'track-corrupt');
      expect(corrupt).toBeDefined();
      expect(corrupt?.positive_keywords).toEqual([]);
    });

    it('returns success: false when backupDatabase throws', async () => {
      const originalBackup = db.backup;
      (db as any).backup = vi.fn().mockRejectedValue(new Error('Database locked'));
      // Remove today's backup file if it exists so it doesn't skip
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8);
      const todayBackup = path.resolve(BACKUPS_DIR, `tender_tracker_${timestamp}.db`);
      if (fs.existsSync(todayBackup)) fs.unlinkSync(todayBackup);

      const res = await backupDatabase();
      expect(res.success).toBe(false);
      (db as any).backup = originalBackup;
    });
  });

  describe('findCanonicalMatch (Deduplicator)', () => {
    it('matches tenders with exact reference numbers regardless of case and punctuation', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url)
        VALUES ('canon-1', 'canon-1', 'epads', 'Federal PPRA', 'NUST/IT-2026/01', 'Supply of Servers', 'NUST', 'http://1')
      `).run();

      const match = findCanonicalMatch({
        referenceNo: 'nust-it-2026-01',
        title: 'Different Server Title',
        organization: 'Different Org'
      });

      expect(match.isDuplicate).toBe(true);
      expect(match.canonicalId).toBe('canon-1');
      expect(match.matchedTenderId).toBe('canon-1');
      expect(match.similarity).toBe(1.0);
    });

    it('falls back to title and organization similarity when reference numbers do not match', () => {
      const closingDate = '2026-06-15T14:00:00+05:00';
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date)
        VALUES ('canon-2', 'canon-2', 'punjab_eproc', 'Punjab PPRA', 'REF-ORIGINAL-99', 'High Performance Computing Cluster', 'Information Technology University', 'http://2', ?)
      `).run(closingDate);

      const match = findCanonicalMatch({
        referenceNo: null,
        title: 'High Performance Computing Cluster Equipment',
        organization: 'Information Technology University',
        closingDate: '2026-06-16T10:00:00+05:00' // within 1.5 days
      });

      expect(match.isDuplicate).toBe(true);
      expect(match.canonicalId).toBe('canon-2');
      expect(match.similarity).toBeGreaterThanOrEqual(0.85);
    });

    it('returns isDuplicate false when candidate does not match existing records', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url)
        VALUES ('canon-3', 'canon-3', 'punjab_eproc', 'Punjab PPRA', 'REF-33', 'Civil Engineering Road Construction', 'Highway Authority', 'http://3')
      `).run();

      const match = findCanonicalMatch({
        referenceNo: 'REF-NEW-888',
        title: 'Provision of Legal Consulting Services',
        organization: 'State Bank of Pakistan'
      });

      expect(match.isDuplicate).toBe(false);
      expect(match.similarity).toBe(0);
    });

    it('matches undated tenders with similar title when closingDate is null', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date, created_at)
        VALUES ('canon-4', 'canon-4', 'wapda', 'WAPDA', 'REF-44', 'Grid Substation Automation System', 'WAPDA', 'http://4', NULL, datetime('now', '-2 days'))
      `).run();

      const match = findCanonicalMatch({
        referenceNo: null,
        title: 'Grid Substation Automation System Procurement',
        organization: 'WAPDA',
        closingDate: null
      });

      expect(match.isDuplicate).toBe(true);
      expect(match.canonicalId).toBe('canon-4');
    });

    it('matches tenders inserted via direct SQL without reference_norm via on-the-fly normalization fallback (G6)', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date, reference_norm)
        VALUES ('legacy-sql-1', 'legacy-sql-1', 'ppra_federal', 'PPRA Federal', 'TS-554433-E', 'Hardware Delivery for Data Center', 'Ministry of IT', 'http://test', '2026-12-01T10:00:00.000Z', NULL)
      `).run();

      const match = findCanonicalMatch({
        referenceNo: 'TS 554433 E',
        title: 'Hardware Delivery for Data Center IT',
        organization: 'Ministry of IT',
        portalId: 'other_portal'
      });

      expect(match.isDuplicate).toBe(true);
      expect(match.canonicalId).toBe('legacy-sql-1');
      expect(match.tier).toBe('reference');
    });

    it('heals legacy offline_broken portals with TLS errors to public during initDatabase', () => {
      db.prepare(`
        UPDATE portal_health
        SET access_mode = 'offline_broken',
            verified_status = 'Broken — Expired TLS certificate on host',
            status = 'error'
        WHERE portal_id = 'peef'
      `).run();

      initDatabase();

      const healed = db.prepare("SELECT access_mode, verified_status, status FROM portal_health WHERE portal_id = 'peef'").get() as any;
      expect(healed.access_mode).toBe('public');
      expect(healed.status).toBe('online');
      expect(healed.verified_status).toContain('SSL-tolerant');
    });
  });

  describe('Portal CRUD and Persistent Deletion', () => {
    it('creates a new portal and retrieves it by id', () => {
      const created = createPortal({
        portal_name: 'Custom Test Portal',
        tenders_url: 'https://test.custom-portal.gov.pk/tenders',
        base_url: 'https://test.custom-portal.gov.pk',
        category: 'Provincial',
        access_mode: 'public'
      });

      expect(created.portal_id).toBeDefined();
      expect(created.portal_name).toBe('Custom Test Portal');
      expect(created.tenders_url).toBe('https://test.custom-portal.gov.pk/tenders');
      expect(created.status).toBe('online');

      const found = getPortalById(created.portal_id);
      expect(found).not.toBeNull();
      expect(found?.portal_name).toBe('Custom Test Portal');
    });

    it('deletes a portal and records it in deleted_portals to prevent re-seeding', () => {
      const created = createPortal({
        portal_id: 'portal_to_delete',
        portal_name: 'Ephemeral Portal',
        tenders_url: 'https://ephemeral.gov.pk/tenders',
        category: 'Regulatory'
      });

      expect(getPortalById('portal_to_delete')).not.toBeNull();

      const success = deletePortal('portal_to_delete');
      expect(success).toBe(true);
      expect(getPortalById('portal_to_delete')).toBeNull();

      // Verify recorded in deleted_portals
      const record = db.prepare('SELECT portal_id FROM deleted_portals WHERE portal_id = ?').get('portal_to_delete') as any;
      expect(record).toBeDefined();
      expect(record.portal_id).toBe('portal_to_delete');

      // Re-run initDatabase to simulate server restart; ensure it does not revive deleted portal
      initDatabase();
      expect(getPortalById('portal_to_delete')).toBeNull();
    });
  });

  describe('Audit Fixes: B1, B2, Suppressions, Reference Normalization & Migration', () => {
    it('B1: own portal is never recorded as a secondary source, and entries are unique by link', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date)
        VALUES ('tender-b1', 'tender-b1', 'pseb', 'Pakistan Software Export Board', 'REF-B1', 'Cloud Infrastructure Services', 'PSEB', 'https://pseb.org.pk/t1', '2026-12-30T10:00:00.000Z')
      `).run();

      // 1. Same portal should be ignored
      const resSame = appendSecondarySource('tender-b1', {
        portalName: 'Pakistan Software Export Board',
        directUrl: 'https://pseb.org.pk/t1-duplicate',
        discoveredAt: new Date().toISOString()
      });
      expect(resSame).toBe(false);

      // 2. Different portal should be added
      const resDiff = appendSecondarySource('tender-b1', {
        portalName: 'PPRA Federal',
        directUrl: 'https://ppra.org.pk/t1',
        discoveredAt: new Date().toISOString()
      });
      expect(resDiff).toBe(true);

      // 3. Duplicate link from different portal should not duplicate
      const resDup = appendSecondarySource('tender-b1', {
        portalName: 'PPRA Federal',
        directUrl: 'https://ppra.org.pk/t1',
        discoveredAt: new Date().toISOString()
      });
      expect(resDup).toBe(false);

      const t = getTenderById('tender-b1')!;
      expect(t.secondary_sources).toHaveLength(1);
      expect(t.secondary_sources[0].portalName).toBe('PPRA Federal');
    });

    it('B2: slimming a Passed tender preserves status_notes, and keeps description if ever in Pipeline', () => {
      // 1. Inbox tender passed straight: keeps status_notes, slims description
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, pipeline_status, status_notes, description, passed_at)
        VALUES ('tender-b2-inbox', 'tender-b2-inbox', 'pseb', 'PSEB', 'REF-B2-A', 'Hardware Supply', 'PSEB', 'http://t2a', 'Passed', 'Inbox review note', 'Original Inbox Description', datetime('now', '-5 days'))
      `).run();

      slimPassedTenders(['tender-b2-inbox']);
      const afterInbox = getTenderById('tender-b2-inbox')!;
      expect(afterInbox.status_notes).toBe('Inbox review note');
      expect(afterInbox.description).toBe('');
      expect(afterInbox.slimmed_at).not.toBeNull();

      // 2. Tender that was in Pipeline (recorded in pipeline_audit_logs): keeps both notes and description
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, pipeline_status, status_notes, description, passed_at)
        VALUES ('tender-b2-pipe', 'tender-b2-pipe', 'pseb', 'PSEB', 'REF-B2-B', 'Cloud Migration', 'PSEB', 'http://t2b', 'Passed', 'Pipeline evaluation note', 'Full Engineering Description', datetime('now', '-5 days'))
      `).run();
      db.prepare(`
        INSERT INTO pipeline_audit_logs (id, tender_id, previous_status, new_status, notes, created_at)
        VALUES ('audit-log-b2', 'tender-b2-pipe', 'New Opportunity', 'Under Review', 'Moved to review', datetime('now', '-6 days'))
      `).run();

      slimPassedTenders(['tender-b2-pipe']);
      const afterPipe = getTenderById('tender-b2-pipe')!;
      expect(afterPipe.status_notes).toBe('Pipeline evaluation note');
      expect(afterPipe.description).toBe('Full Engineering Description');
      expect(afterPipe.slimmed_at).not.toBeNull();
    });

    it('suppression reasons and 120-day expiry for undated suppressions', () => {
      // Record suppression with reason
      recordTenderSuppression('suppress-test-1', 'suppress-test-1', null, 'stale');
      const rec = db.prepare('SELECT * FROM deleted_tenders WHERE id = ?').get('suppress-test-1') as any;
      expect(rec).toBeDefined();
      expect(rec.reason).toBe('stale');

      // Still suppressed within 120 days
      expect(isTenderSuppressed('suppress-test-1', 'suppress-test-1', null)).toBe(true);

      // Backdate deleted_at to 125 days ago
      db.prepare(`UPDATE deleted_tenders SET deleted_at = datetime('now', '-125 days') WHERE id = ?`).run('suppress-test-1');

      // 120-day expiry: should no longer be suppressed!
      expect(isTenderSuppressed('suppress-test-1', 'suppress-test-1', null)).toBe(false);
    });

    it('runAuditCleanup normalizes references, cleans self secondary sources, and writes migration log', () => {
      // 1. Insert row with unnormalized reference
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, reference_norm, title, organization, direct_url, secondary_sources)
        VALUES (
          'audit-clean-1', 'audit-clean-1', 'pseb', 'Pakistan Software Export Board',
          'PSDF / PROC / 2026-99', NULL,
          'Test Tender Clean', 'PSEB', 'http://clean',
          '[{"portalName":"Pakistan Software Export Board","directUrl":"http://self"}]'
        )
      `).run();

      const report = runAuditCleanup();
      expect(report.referencesNormalized).toBeGreaterThanOrEqual(1);
      expect(report.selfSecondarySourcesRemoved).toBeGreaterThanOrEqual(1);

      const cleaned = getTenderById('audit-clean-1')!;
      expect(cleaned.reference_norm).toBe('psdfproc202699');
      expect(cleaned.secondary_sources).toHaveLength(0);

      // Migration log recorded in app_settings
      const log = db.prepare(`SELECT value FROM app_settings WHERE key = 'migration_audit_fixes_2026_11'`).get() as any;
      expect(log).toBeDefined();
    });
  });
});
