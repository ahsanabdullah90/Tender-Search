import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db, initDatabase, DOSSIERS_DIR } from '../../src/server/db.js';
import { runRetentionCycle, getRetentionStatus } from '../../src/server/retention.js';
import { setAppSetting } from '../../src/server/db/repositories/systemRepo.js';
import { saveTenderDocument } from '../../src/server/dossierStore.js';
import { getTenderById } from '../../src/server/db/repositories/tendersRepo.js';

describe('Retention Lifecycle Daemon', () => {
  const tenderPassedOld = 'tender-retention-passed-old';
  const tenderPassedFresh = 'tender-retention-passed-fresh';
  const tenderExpiredUnreviewed = 'tender-retention-expired-unreviewed';
  const tenderExpiredBookmarked = 'tender-retention-expired-bookmarked';
  const tenderTrackedActive = 'tender-retention-tracked-active';
  const tenderPassedAgedOut = 'tender-retention-passed-aged-out';

  const cleanupTenders = () => {
    const ids = [
      tenderPassedOld,
      tenderPassedFresh,
      tenderExpiredUnreviewed,
      tenderExpiredBookmarked,
      tenderTrackedActive,
      tenderPassedAgedOut
    ];
    for (const id of ids) {
      db.prepare('DELETE FROM tenders WHERE id = ?').run(id);
      db.prepare('DELETE FROM deleted_tenders WHERE id = ?').run(id);
      const dir = path.resolve(DOSSIERS_DIR, id);
      if (fs.existsSync(dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  };

  beforeEach(() => {
    initDatabase();
    cleanupTenders();
    setAppSetting('retention_auto_clean', 'true');
    setAppSetting('retention_grace_days', '2');
    setAppSetting('retention_passed_days', '10');
  });

  afterEach(() => {
    cleanupTenders();
  });

  it('slims Passed tenders older than 2 minutes and preserves tenders within the undo window', () => {
    // 1. Create Passed tender older than 2 minutes (e.g. 5 minutes ago)
    db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date,
        description, status_notes, pipeline_status, passed_at
      ) VALUES (?, ?, 'Passed Old Tender', 'Org 1', 'epads', 'Federal PPRA', 'https://example.com/1',
        '[]', '["keyword1"]', 85, '2026-10-01', '2026-12-01',
        'Detailed tender description', 'Interesting notes', 'Passed', datetime('now', '-5 minutes'))
    `).run(tenderPassedOld, tenderPassedOld);

    // Create file for old passed tender
    saveTenderDocument(tenderPassedOld, Buffer.from('file 1'), {
      portalCode: 'FPPRA',
      referenceNo: 'OLD-1',
      title: 'Passed Old'
    });
    expect(fs.existsSync(path.resolve(DOSSIERS_DIR, tenderPassedOld))).toBe(true);

    // 2. Create Passed tender passed 30 seconds ago (inside undo window)
    db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date,
        description, status_notes, pipeline_status, passed_at
      ) VALUES (?, ?, 'Passed Fresh Tender', 'Org 2', 'epads', 'Federal PPRA', 'https://example.com/2',
        '[]', '["keyword2"]', 85, '2026-10-01', '2026-12-01',
        'Fresh tender description', 'Fresh notes', 'Passed', datetime('now', '-30 seconds'))
    `).run(tenderPassedFresh, tenderPassedFresh);

    // Run retention cycle
    const report = runRetentionCycle({ dryRun: false });
    expect(report.slimmedCount).toBeGreaterThanOrEqual(1);

    // Old passed tender should now be slimmed
    const oldTender = getTenderById(tenderPassedOld);
    expect(oldTender).toBeDefined();
    expect(oldTender?.description).toBe('');
    expect(oldTender?.status_notes).toBe('');
    expect(oldTender?.matched_keywords).toEqual([]);
    expect(oldTender?.slimmed_at).not.toBeNull();
    // Physical folder should be purged
    expect(fs.existsSync(path.resolve(DOSSIERS_DIR, tenderPassedOld))).toBe(false);

    // Fresh passed tender should still retain its full details
    const freshTender = getTenderById(tenderPassedFresh);
    expect(freshTender).toBeDefined();
    expect(freshTender?.description).toBe('Fresh tender description');
    expect(freshTender?.slimmed_at).toBeNull();
  });

  it('deletes expired unreviewed New Opportunities (closing date + 2 days past)', () => {
    // Closing date was 5 days ago
    db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date,
        pipeline_status, is_bookmarked
      ) VALUES (?, ?, 'Expired Unreviewed Tender', 'Org 3', 'epads', 'Federal PPRA', 'https://example.com/3',
        '[]', '[]', 80, '2026-10-01', date('now', '-5 days'),
        'New Opportunity', 0)
    `).run(tenderExpiredUnreviewed, tenderExpiredUnreviewed);

    const report = runRetentionCycle({ dryRun: false });
    expect(report.expiredDeletedCount).toBeGreaterThanOrEqual(1);

    const check = getTenderById(tenderExpiredUnreviewed);
    expect(check).toBeNull();
  });

  it('NEVER auto-deletes bookmarked tenders even when closed long ago', () => {
    // Bookmarked tender closed 30 days ago
    db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date,
        pipeline_status, is_bookmarked
      ) VALUES (?, ?, 'Expired Bookmarked Tender', 'Org 4', 'epads', 'Federal PPRA', 'https://example.com/4',
        '[]', '[]', 90, '2026-09-01', date('now', '-30 days'),
        'New Opportunity', 1)
    `).run(tenderExpiredBookmarked, tenderExpiredBookmarked);

    runRetentionCycle({ dryRun: false });

    const check = getTenderById(tenderExpiredBookmarked);
    expect(check).not.toBeNull();
    expect(check?.is_bookmarked).toBe(1);
  });

  it('NEVER auto-deletes tracked bid pursuits in active pipeline stages', () => {
    // Tracked in Preparing Bid, closed 10 days ago
    db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date,
        pipeline_status, is_bookmarked
      ) VALUES (?, ?, 'Active Bid Tracked', 'Org 5', 'epads', 'Federal PPRA', 'https://example.com/5',
        '[]', '[]', 95, '2026-09-01', date('now', '-10 days'),
        'Preparing Bid', 0)
    `).run(tenderTrackedActive, tenderTrackedActive);

    runRetentionCycle({ dryRun: false });

    const check = getTenderById(tenderTrackedActive);
    expect(check).not.toBeNull();
    expect(check?.pipeline_status).toBe('Preparing Bid');
  });

  it('retires slim Passed tenders older than 10 days post-closing', () => {
    // Passed and slimmed tender closed 15 days ago
    db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date,
        pipeline_status, passed_at, slimmed_at
      ) VALUES (?, ?, 'Passed Aged Out', 'Org 6', 'epads', 'Federal PPRA', 'https://example.com/6',
        '[]', '[]', 50, '2026-08-01', date('now', '-15 days'),
        'Passed', datetime('now', '-15 days'), datetime('now', '-15 days'))
    `).run(tenderPassedAgedOut, tenderPassedAgedOut);

    const report = runRetentionCycle({ dryRun: false });
    expect(report.passedRetiredCount).toBeGreaterThanOrEqual(1);

    const check = getTenderById(tenderPassedAgedOut);
    expect(check).toBeNull();
  });

  it('accurately reports counts in dryRun mode without modifying data', () => {
    db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date,
        pipeline_status, passed_at
      ) VALUES (?, ?, 'Dry Run Test Passed', 'Org Dry', 'epads', 'Federal PPRA', 'https://example.com/dry',
        '[]', '[]', 50, '2026-08-01', date('now', '-10 days'),
        'Passed', datetime('now', '-10 minutes'))
    `).run(tenderPassedOld, tenderPassedOld);

    const report = runRetentionCycle({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.slimmedCount).toBeGreaterThanOrEqual(1);

    // Database should NOT have updated slimmed_at
    const check = getTenderById(tenderPassedOld);
    expect(check?.slimmed_at).toBeNull();
  });

  it('provides comprehensive system status via getRetentionStatus', () => {
    const status = getRetentionStatus();
    expect(status.enabled).toBe(true);
    expect(status.graceDays).toBe(2);
    expect(status.passedRetentionDays).toBe(10);
    expect(typeof status.pendingSlimCount).toBe('number');
    expect(typeof status.expiredUnreviewedCount).toBe('number');
  });

  it('expires undated tenders with no publish date 90 days after they were first seen (Phase 0.3)', async () => {
    const { getExpiredUnreviewedTenderIds } = await import('../../src/server/db/repositories/tendersRepo.js');
    const insert = db.prepare(`
      INSERT INTO tenders (id, canonical_id, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date, pipeline_status, created_at)
      VALUES (?, ?, ?, 'Org', 'epads', 'Federal PPRA', ?, '[]', '[]', 80, NULL, NULL, 'New Opportunity', datetime('now', ?))
    `);
    insert.run(tenderExpiredUnreviewed, tenderExpiredUnreviewed, 'Undated seen 100 days ago', 'https://example.com/u1', '-100 days');
    insert.run(tenderTrackedActive, tenderTrackedActive, 'Undated seen 10 days ago', 'https://example.com/u2', '-10 days');

    const ids = getExpiredUnreviewedTenderIds(2, 500);
    expect(ids).toContain(tenderExpiredUnreviewed);
    expect(ids).not.toContain(tenderTrackedActive);
  });
});
