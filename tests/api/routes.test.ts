import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createApp } from '../../server.js';
import { crawlerDeps, currentScanStatus } from '../../src/server/scrapers/crawlerEngine.js';
import { scanRouteDeps } from '../../src/server/routes/scan.routes.js';
import { schedulerDeps, stopStartupScheduler } from '../../src/server/services/scheduler.js';
import {
  db,
  initDatabase,
  getAllTenders,
  getTenderById,
  getAllDomainTracks,
  DOSSIERS_DIR
} from '../../src/server/db/index.js';

describe('Server API Routes', () => {
  const app = createApp();

  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM document_ingest_jobs').run();
    db.prepare('DELETE FROM corrigendum_logs').run();
    db.prepare('DELETE FROM pipeline_audit_logs').run();
    db.prepare('DELETE FROM tenders').run();
  });

  const insertTestTender = (id: string, overrides: Record<string, any> = {}) => {
    db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, portal_id, portal_name, reference_no, title, organization,
        description, estimated_value, location, publish_date, closing_date,
        direct_url, secondary_sources, domain_tracks, matched_keywords,
        match_score, pipeline_status, is_bookmarked, status_notes, result_expected_date,
        cached_dossiers, has_corrigendum, viewed
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      id,
      overrides.canonical_id || id,
      overrides.portal_id || 'epads',
      overrides.portal_name || 'Federal PPRA',
      overrides.reference_no || 'REF-API-101',
      overrides.title || 'Enterprise High Availability Cloud Setup',
      overrides.organization || 'Ministry of IT',
      overrides.description || 'Cloud migration and managed services',
      overrides.estimated_value || 'PKR 25,000,000',
      overrides.location || 'Islamabad',
      overrides.publish_date || '2026-05-01',
      overrides.closing_date !== undefined ? overrides.closing_date : '2026-06-30T14:00:00+05:00',
      overrides.direct_url || 'https://example.com/api-tender',
      JSON.stringify(overrides.secondary_sources || []),
      JSON.stringify(overrides.domain_tracks || ['Construction & Civil Works']),
      JSON.stringify(overrides.matched_keywords || ['construction']),
      overrides.match_score || 90,
      overrides.pipeline_status || 'New Opportunity',
      overrides.is_bookmarked || 0,
      overrides.status_notes || '',
      overrides.result_expected_date || null,
      JSON.stringify(overrides.cached_dossiers || []),
      overrides.has_corrigendum || 0,
      overrides.viewed !== undefined ? overrides.viewed : 0
    );
  };

  describe('GET /api/tenders', () => {
    it('returns empty array when database has no tenders', async () => {
      const res = await request(app).get('/api/tenders');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns list of tenders with parsed JSON arrays', async () => {
      insertTestTender('t-api-1');
      const res = await request(app).get('/api/tenders');

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe('t-api-1');
      expect(res.body[0].domain_tracks).toEqual(['Construction & Civil Works']);
      expect(res.body[0].matched_keywords).toEqual(['construction']);
    });

    it('filters by status, bookmarkedOnly, unreadOnly, and search query params', async () => {
      insertTestTender('t-1', { pipeline_status: 'New Opportunity', is_bookmarked: 1, viewed: 0 });
      insertTestTender('t-2', { pipeline_status: 'Preparing Bid', is_bookmarked: 0, viewed: 1 });

      const statusRes = await request(app).get('/api/tenders?status=Preparing Bid');
      expect(statusRes.body.length).toBe(1);
      expect(statusRes.body[0].id).toBe('t-2');

      const bookmarkRes = await request(app).get('/api/tenders?bookmarkedOnly=true');
      expect(bookmarkRes.body.length).toBe(1);
      expect(bookmarkRes.body[0].id).toBe('t-1');

      const unreadRes = await request(app).get('/api/tenders?unreadOnly=true');
      expect(unreadRes.body.length).toBe(1);
      expect(unreadRes.body[0].id).toBe('t-1');

      const searchRes = await request(app).get('/api/tenders?search=Cloud Setup');
      expect(searchRes.body.length).toBe(2);
    });
  });

  describe('GET /api/tenders/:id', () => {
    it('returns 200 and tender object when tender exists', async () => {
      insertTestTender('t-found');
      const res = await request(app).get('/api/tenders/t-found');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('t-found');
      expect(res.body.title).toContain('Enterprise High Availability');
    });

    it('returns 404 when tender is not found', async () => {
      const res = await request(app).get('/api/tenders/non-existent-id');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Tender not found');
    });
  });

  describe('PATCH /api/tenders/:id/status (Bug B8)', () => {
    it('returns 400 when status is missing from request body', async () => {
      insertTestTender('t-val');
      const res = await request(app).patch('/api/tenders/t-val/status').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Status is required');
    });

    it('returns 400 when status is not in allowed TENDER_STATUSES', async () => {
      insertTestTender('t-val');
      const res = await request(app)
        .patch('/api/tenders/t-val/status')
        .send({ status: 'InvalidPipelineStatus' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid status: "InvalidPipelineStatus"');
      expect(res.body.error).toContain('New Opportunity');
      expect(res.body.error).toContain('Preparing Bid');
    });

    it('returns 404 when updating status of non-existent tender', async () => {
      const res = await request(app)
        .patch('/api/tenders/non-existent/status')
        .send({ status: 'Preparing Bid' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Tender not found');
    });

    it('updates status and records audit log for valid status transition', async () => {
      insertTestTender('t-val', { pipeline_status: 'New Opportunity' });

      const res = await request(app)
        .patch('/api/tenders/t-val/status')
        .send({ status: 'Preparing Bid', notes: 'Shortlisted for technical response' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('Preparing Bid');

      const updated = getTenderById('t-val');
      expect(updated?.pipeline_status).toBe('Preparing Bid');
      expect(updated?.status_notes).toBe('Shortlisted for technical response');
    });
  });

  describe('PATCH & POST /api/tenders/:id/notes', () => {
    it('updates notes via PATCH and POST', async () => {
      insertTestTender('t-notes');

      const resPatch = await request(app)
        .patch('/api/tenders/t-notes/notes')
        .send({ notes: 'Meeting scheduled with partner' });
      expect(resPatch.status).toBe(200);
      expect(resPatch.body.notes).toBe('Meeting scheduled with partner');

      const resPost = await request(app)
        .post('/api/tenders/t-notes/notes')
        .send({ notes: 'Partner agreed to terms' });
      expect(resPost.status).toBe(200);
      expect(resPost.body.notes).toBe('Partner agreed to terms');

      expect(getTenderById('t-notes')?.status_notes).toBe('Partner agreed to terms');
    });

    it('returns 404 when updating notes on non-existent tender', async () => {
      const res = await request(app)
        .patch('/api/tenders/non-existent/notes')
        .send({ notes: 'Some note' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Tender not found');
    });
  });

  describe('PATCH /api/tenders/:id/result-date', () => {
    it('updates expected result date', async () => {
      insertTestTender('t-res');

      const res = await request(app)
        .patch('/api/tenders/t-res/result-date')
        .send({ date: '2026-08-15' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result_expected_date).toBe('2026-08-15');

      expect(getTenderById('t-res')?.result_expected_date).toBe('2026-08-15');
    });

    it('returns 404 for missing tender', async () => {
      const res = await request(app)
        .patch('/api/tenders/missing/result-date')
        .send({ date: '2026-08-15' });
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid date', async () => {
      insertTestTender('t-res-inv');
      const res = await request(app)
        .patch('/api/tenders/t-res-inv/result-date')
        .send({ date: 'invalid-date-string' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid date');
    });
  });

  describe('POST /api/tenders/:id/bookmark', () => {
    it('toggles bookmark state', async () => {
      insertTestTender('t-bkmk', { is_bookmarked: 0 });

      const res1 = await request(app).post('/api/tenders/t-bkmk/bookmark');
      expect(res1.status).toBe(200);
      expect(res1.body.is_bookmarked).toBe(1);

      const res2 = await request(app).post('/api/tenders/t-bkmk/bookmark');
      expect(res2.status).toBe(200);
      expect(res2.body.is_bookmarked).toBe(0);
    });

    it('returns success false for missing tender', async () => {
      const res = await request(app).post('/api/tenders/missing/bookmark');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
    });
  });

  describe('PATCH & POST /api/tenders/:id/viewed', () => {
    it('marks tender as viewed', async () => {
      insertTestTender('t-view', { viewed: 0 });

      const res = await request(app)
        .patch('/api/tenders/t-view/viewed')
        .send({ viewed: true });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.viewed).toBe(1);

      expect(getTenderById('t-view')?.viewed).toBe(1);
    });

    it('returns 404 when marking missing tender as viewed', async () => {
      const res = await request(app)
        .patch('/api/tenders/missing/viewed')
        .send({ viewed: true });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Tender not found');
    });
  });

  describe('GET /api/kpis', () => {
    it('returns dashboard KPI statistics', async () => {
      insertTestTender('t-k1', { pipeline_status: 'New Opportunity' });
      insertTestTender('t-k2', { pipeline_status: 'Preparing Bid' });

      const res = await request(app).get('/api/kpis');
      expect(res.status).toBe(200);
      expect(res.body.totalTracked).toBe(2);
      expect(res.body.inPipeline).toBe(1);
      expect(typeof res.body.onlinePortals).toBe('number');
    });
  });

  describe('Corrigenda API (/api/corrigenda)', () => {
    it('retrieves unacknowledged corrigenda and allows acknowledging them', async () => {
      insertTestTender('t-corr');
      db.prepare(`
        INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
        VALUES ('corr-api-1', 't-corr', 'deadline_extension', '2026-06-01', '2026-06-15', 0)
      `).run();

      const getRes = await request(app).get('/api/corrigenda');
      expect(getRes.status).toBe(200);
      expect(getRes.body.length).toBe(1);
      expect(getRes.body[0].id).toBe('corr-api-1');

      const ackRes = await request(app).post('/api/corrigenda/corr-api-1/acknowledge');
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);

      const getResAfter = await request(app).get('/api/corrigenda');
      expect(getResAfter.body.length).toBe(0);
    });
  });

  describe('Tracks API (/api/tracks)', () => {
    it('lists, creates, and deletes domain tracks', async () => {
      const listRes = await request(app).get('/api/tracks');
      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body)).toBe(true);

      const createRes = await request(app)
        .post('/api/tracks')
        .send({
          name: 'Cybersecurity Ops',
          positive_keywords: ['penetration testing', 'soc'],
          negative_keywords: ['cctv'],
          is_active: 1
        });

      expect(createRes.status).toBe(200);
      expect(createRes.body.success).toBe(true);
      expect(createRes.body.id).toBeDefined();

      const createdId = createRes.body.id;
      const allTracks = getAllDomainTracks();
      expect(allTracks.some(t => t.id === createdId)).toBe(true);

      const deleteRes = await request(app).delete(`/api/tracks/${createdId}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);
    });

    it('returns 400 when creating track with empty name', async () => {
      const res = await request(app).post('/api/tracks').send({ name: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Track name is required');
    });
  });

  describe('Portals API (/api/portals)', () => {
    it('returns list of portals and handles credentials saving', async () => {
      const listRes = await request(app).get('/api/portals');
      expect(listRes.status).toBe(200);
      expect(listRes.body.length).toBeGreaterThan(0);

      const credRes = await request(app)
        .post('/api/portals/epms_ppra/credentials')
        .send({
          username: 'portal_officer',
          password: 'pass123Password!',
          loginUrl: 'https://epms.ppra.gov.pk/custom'
        });

      expect(credRes.status).toBe(200);
      expect(credRes.body.success).toBe(true);

      const getCredRes = await request(app).get('/api/portals/epms_ppra/credentials');
      expect(getCredRes.status).toBe(200);
      expect(getCredRes.body.username).toBe('portal_officer');
      expect(getCredRes.body.hasPassword).toBe(true);
      expect(getCredRes.body.loginUrl).toBe('https://epms.ppra.gov.pk/custom');
    });

    it('returns 404 for unknown portal credentials', async () => {
      const res = await request(app).get('/api/portals/unknown_portal/credentials');
      expect(res.status).toBe(404);
    });

    it('supports HITL launch and verification routes', async () => {
      const launchRes = await request(app).post('/api/portals/epms_ppra/hitl-launch');
      expect(launchRes.status).toBe(200);
      expect(launchRes.body.success).toBe(true);

      const verifyRes = await request(app).post('/api/portals/epms_ppra/hitl-verify');
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
    });

    it('creates a new portal and validates required inputs', async () => {
      // Missing name
      const badRes1 = await request(app).post('/api/portals').send({ tenders_url: 'https://foo.bar' });
      expect(badRes1.status).toBe(400);

      // Missing url
      const badRes2 = await request(app).post('/api/portals').send({ portal_name: 'Test Portal' });
      expect(badRes2.status).toBe(400);

      // Unsafe / non-HTTP / private SSRF URLs (SEC-5)
      const unsafePortal1 = await request(app).post('/api/portals').send({
        portal_name: 'Unsafe SSRF Portal',
        tenders_url: 'http://169.254.169.254/latest/meta-data/'
      });
      expect(unsafePortal1.status).toBe(400);

      const unsafePortal2 = await request(app).post('/api/portals').send({
        portal_name: 'Unsafe File Portal',
        tenders_url: 'file:///etc/passwd'
      });
      expect(unsafePortal2.status).toBe(400);

      // Success
      const createRes = await request(app)
        .post('/api/portals')
        .send({
          portal_name: 'Custom WAPDA Unit',
          tenders_url: 'https://wapda.custom.gov.pk/tenders',
          category: 'Federal',
          access_mode: 'public'
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.success).toBe(true);
      expect(createRes.body.portal.portal_name).toBe('Custom WAPDA Unit');
      expect(createRes.body.portal.portal_id).toBeDefined();

      // Verify portal is present in portal list
      const listRes = await request(app).get('/api/portals');
      const found = listRes.body.find((p: any) => p.portal_id === createRes.body.portal.portal_id);
      expect(found).toBeDefined();
    });

    it('deletes an existing portal and returns 404 for unknown portal', async () => {
      const createRes = await request(app)
        .post('/api/portals')
        .send({
          portal_name: 'Portal To Delete API',
          tenders_url: 'https://delete-me.gov.pk/tenders'
        });
      const portalId = createRes.body.portal.portal_id;

      const deleteRes = await request(app).delete(`/api/portals/${portalId}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // 404 on subsequent delete
      const deleteAgainRes = await request(app).delete(`/api/portals/${portalId}`);
      expect(deleteAgainRes.status).toBe(404);
    });
  });

  describe('Scan Control API (/api/scan)', () => {
    it('returns current scan status', async () => {
      const res = await request(app).get('/api/scan/status');
      expect(res.status).toBe(200);
      expect(typeof res.body.isScanning).toBe('boolean');
      expect(typeof res.body.progressPercent).toBe('number');
    });

    it('triggers crawler scan via start endpoint', async () => {
      const origStart = scanRouteDeps.startCrawlerScan;
      scanRouteDeps.startCrawlerScan = vi.fn().mockResolvedValue({ ...currentScanStatus, isScanning: true });
      try {
        const res = await request(app).post('/api/scan/start');
        expect(res.status).toBe(200);
        expect(typeof res.body.isScanning).toBe('boolean');
        expect(scanRouteDeps.startCrawlerScan).toHaveBeenCalledTimes(1);
      } finally {
        scanRouteDeps.startCrawlerScan = origStart;
      }
    });
  });

  describe('Dossiers & Storage API', () => {
    it('returns storage stats', async () => {
      const res = await request(app).get('/api/storage');
      expect(res.status).toBe(200);
      expect(typeof res.body.total_bytes).toBe('number');
      expect(typeof res.body.passed_bytes).toBe('number');
    });

    it('prunes dossiers for passed tenders', async () => {
      const res = await request(app).post('/api/dossiers/prune-passed');
      expect(res.status).toBe(200);
      expect(typeof res.body.freed_bytes).toBe('number');
      expect(typeof res.body.tenders).toBe('number');
    });

    it('serves cached dossier files when present and returns 404 when absent', async () => {
      const tenderId = 'tender-api-doc-1';
      const filename = 'bidding_doc.pdf';
      const tenderDir = path.resolve(DOSSIERS_DIR, tenderId);
      fs.mkdirSync(tenderDir, { recursive: true });
      fs.writeFileSync(path.resolve(tenderDir, filename), '%PDF-1.4 API Test Document');

      const foundRes = await request(app).get(`/api/dossiers/${tenderId}/${filename}`);
      expect(foundRes.status).toBe(200);
      expect(foundRes.headers['content-type']).toContain('application/pdf');

      const notFoundRes = await request(app).get(`/api/dossiers/${tenderId}/missing.pdf`);
      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.text).toBe('Dossier file not found on disk');
    });
  });

  describe('Backups API (/api/backups)', () => {
    it('lists backups and creates manual backup', async () => {
      const createRes = await request(app).post('/api/backups');
      expect(createRes.status).toBe(200);
      expect(createRes.body.name).toContain('tender_tracker_');
      expect(createRes.body.name).toContain('_manual.db');

      const listRes = await request(app).get('/api/backups');
      expect(listRes.status).toBe(200);
      expect(listRes.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Export CSV API (/api/export/csv)', () => {
    it('exports tenders to CSV with UTF-8 BOM and correct headers', async () => {
      insertTestTender('t-exp-1', { title: 'Solar Power System', pipeline_status: 'New Opportunity' });
      insertTestTender('t-exp-2', { title: 'Construction of School', pipeline_status: 'Preparing Bid' });

      const allRes = await request(app).get('/api/export/csv');
      expect(allRes.status).toBe(200);
      expect(allRes.headers['content-type']).toContain('text/csv');
      expect(allRes.text.startsWith('\uFEFF')).toBe(true);
      expect(allRes.text).toContain('Reference No,Title,Organization');
      expect(allRes.text).toContain('Solar Power System');
      expect(allRes.text).toContain('Construction of School');

      // Test scope filters
      const inboxRes = await request(app).get('/api/export/csv?scope=inbox');
      expect(inboxRes.text).toContain('Solar Power System');
      expect(inboxRes.text).not.toContain('Construction of School');

      const pipelineRes = await request(app).get('/api/export/csv?scope=pipeline');
      expect(pipelineRes.text).toContain('Construction of School');
      expect(pipelineRes.text).not.toContain('Solar Power System');
    });
  });

  describe('Clear Tenders API (/api/tenders/clear)', () => {
    it('clears unreviewed only when unreviewedOnly is true', async () => {
      insertTestTender('t-unreviewed', { pipeline_status: 'New Opportunity' });
      insertTestTender('t-active', { pipeline_status: 'Preparing Bid' });

      const res = await request(app)
        .post('/api/tenders/clear')
        .send({ unreviewedOnly: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Unreviewed opportunities cleared');

      expect(getTenderById('t-unreviewed')).toBeNull();
      expect(getTenderById('t-active')).not.toBeNull();
    });

    it('clears all tenders when unreviewedOnly is false', async () => {
      insertTestTender('t-1', { pipeline_status: 'New Opportunity' });
      insertTestTender('t-2', { pipeline_status: 'Preparing Bid' });

      const res = await request(app)
        .post('/api/tenders/clear')
        .send({ unreviewedOnly: false });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('All tenders wiped');

      expect(getAllTenders().length).toBe(0);
    });

    it('rejects path traversal on /api/dossiers/:tenderId/:filename with 400', async () => {
      const res1 = await request(app).get('/api/dossiers/..%2F..%2Fsecret/file.pdf');
      expect(res1.status).toBe(400);

      const res2 = await request(app).get('/api/dossiers/tender-1/..%2Fsecret.pdf');
      expect(res2.status).toBe(400);
    });
  });

  describe('AI Configuration, Manual Tenders & Attachments API', () => {
    it('saves, masks, and clears Google AI Studio API key via /api/ai/config and /api/ai/status', async () => {
      const saveRes = await request(app)
        .post('/api/ai/config')
        .send({ apiKey: 'AIzaSyTestKey1234567890' });
      expect(saveRes.status).toBe(200);
      expect(saveRes.body.configured).toBe(true);
      expect(saveRes.body.maskedKey).toBe('AIza••••7890');

      const statusRes = await request(app).get('/api/ai/status');
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.configured).toBe(true);
      expect(statusRes.body.maskedKey).toBe('AIza••••7890');

      const clearRes = await request(app)
        .post('/api/ai/config')
        .send({ apiKey: '' });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.configured).toBe(false);
    });

    it('creates a manual tender via POST /api/tenders with automatic track matching and attachment', async () => {
      const fakePdfBase64 = Buffer.from('%PDF-1.4 Manual Tender Document').toString('base64');
      const res = await request(app)
        .post('/api/tenders')
        .send({
          title: 'Procurement of Solar Photovoltaic Inverter Systems',
          organization: 'Punjab Energy Department',
          reference_no: 'PED-SOLAR-2026-09',
          closing_date: '2026-12-15',
          estimated_value: 'PKR 32,000,000',
          description: 'Supply and installation of 150kW hybrid solar inverters.',
          fileBase64: fakePdfBase64,
          filename: 'solar_notice.pdf',
          mimeType: 'application/pdf'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.tender.title).toContain('Solar Photovoltaic Inverter');
      expect(res.body.tender.closing_date_formatted).toContain('15 Dec 2026');
      expect(res.body.tender.deadline_source).toBe('manual');
      expect(res.body.tender.deadline_confidence).toBe('high');
      expect(res.body.tender.domain_tracks.length).toBeGreaterThan(0);
      expect(res.body.tender.cached_dossiers.length).toBe(1);
    });

    it('updates tender fields via PATCH /api/tenders/:id', async () => {
      insertTestTender('t-edit-1', { title: 'Initial Title', description: '' });

      const res = await request(app)
        .patch('/api/tenders/t-edit-1')
        .send({
          title: 'Updated Tender Title',
          organization: 'Updated Dept',
          reference_no: 'REF-UPD-99',
          closing_date: '2026-11-30',
          estimated_value: 'PKR 12,500,000',
          description: '• Scope: Updated scope details\n• Eligibility: PEC C4 required'
        });

      expect(res.status).toBe(200);
      expect(res.body.tender.title).toBe('Updated Tender Title');
      expect(res.body.tender.reference_no).toBe('REF-UPD-99');
      expect(res.body.tender.closing_date_formatted).toContain('30 Nov 2026');
      expect(res.body.tender.deadline_source).toBe('manual');
      expect(res.body.tender.deadline_confidence).toBe('high');
      expect(res.body.tender.description).toContain('Updated scope details');
    });

    it('uploads manual attachment to existing tender via POST /api/tenders/:id/attachments', async () => {
      insertTestTender('t-attach-1', { title: 'Tender needing notice image' });

      const fakePngBase64 = Buffer.from('fake-png-image-bytes').toString('base64');
      const res = await request(app)
        .post('/api/tenders/t-attach-1/attachments')
        .send({
          filename: 'notice_scan.png',
          mimeType: 'image/png',
          dataBase64: fakePngBase64,
          label: 'Scanned Newspaper Notice',
          runAi: false
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tender.cached_dossiers.length).toBe(1);
      expect(res.body.tender.cached_dossiers[0].label).toBe('Scanned Newspaper Notice');
    });

    it('refreshes tender information via POST /api/tenders/:id/refresh', async () => {
      const origFetch = crawlerDeps.fetchHtml;
      crawlerDeps.fetchHtml = vi.fn().mockResolvedValue(`
        <html><body>
          <h1>Solar Hospital Power System Tender</h1>
          <p>Detailed Scope: Supply, installation, and commissioning of rooftop solar PV plant.</p>
        </body></html>
      `);

      insertTestTender('t-refresh-1', {
        title: 'Initial Tender for Refresh',
        direct_url: 'https://example.com/tenders/101',
        description: ''
      });

      const res = await request(app).post('/api/tenders/t-refresh-1/refresh');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tender.id).toBe('t-refresh-1');
      expect(res.body.message).toContain('Tender information refreshed');

      crawlerDeps.fetchHtml = origFetch;
    });

    it('returns helpful 400 when AI analyze or extract-file is called without API key configured', async () => {
      await request(app).post('/api/ai/config').send({ apiKey: '' });
      insertTestTender('t-ai-no-key', { title: 'Tender for AI check' });

      const analyzeRes = await request(app).post('/api/tenders/t-ai-no-key/analyze');
      expect(analyzeRes.status).toBe(400);
      expect(analyzeRes.body.error).toContain('Google AI Studio API key is not configured');

      const extractRes = await request(app)
        .post('/api/ai/extract-file')
        .send({
          dataBase64: Buffer.from('test').toString('base64'),
          mimeType: 'image/png'
        });
      expect(extractRes.status).toBe(400);
      expect(extractRes.body.error).toContain('Google AI Studio API key is not configured');
    });
  });

  describe('Auto-expire responses & expired-tender visibility (Phase 0)', () => {
    it('fetch-documents reports expired:true (not a fake Deleted tender) when the document deadline has passed', async () => {
      const ocrSvc = await import('../../src/server/services/ocrService.js');
      const origBuf = crawlerDeps.fetchFileBuffer;
      crawlerDeps.fetchFileBuffer = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
      vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce({
        referenceNo: 'OLD-1', organization: '', title: '',
        closingDateISO: '2025-10-30T11:00:00+05:00', closingDateFormatted: '30 Oct 2025',
        summaryScope: 'Expired notice', estimatedValue: null, isCorrigendum: false
      });
      insertTestTender('t-expire-docs', {
        reference_no: 'OLD-1',
        closing_date: null,
        direct_url: 'https://example.com/download/old-notice.pdf'
      });

      const res = await request(app).post('/api/tenders/t-expire-docs/fetch-documents');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, expired: true, id: 't-expire-docs' });
      expect(res.body.tender).toBeUndefined();
      expect(getTenderById('t-expire-docs')).toBeNull();

      crawlerDeps.fetchFileBuffer = origBuf;
      vi.restoreAllMocks();
    });

    it('refresh and analyze still return 404 for a tender that never existed', async () => {
      expect((await request(app).post('/api/tenders/no-such-tender/refresh')).status).toBe(404);
      await request(app).post('/api/ai/config').send({ apiKey: 'test-key' });
      expect((await request(app).post('/api/tenders/no-such-tender/analyze')).status).toBe(404);
      await request(app).post('/api/ai/config').send({ apiKey: '' });
    });

    it('excludeExpired ages undated tenders from created_at when there is no publish date', async () => {
      insertTestTender('t-undated-fresh', { closing_date: null, reference_no: 'U-1' });
      insertTestTender('t-undated-stale', { closing_date: null, reference_no: 'U-2' });
      db.prepare(`UPDATE tenders SET publish_date = NULL WHERE id IN ('t-undated-fresh', 't-undated-stale')`).run();
      // One ageing limit (90 days) for ingest, retention and the Inbox (docs/16 A2).
      db.prepare(`UPDATE tenders SET created_at = datetime('now', '-100 days') WHERE id = 't-undated-stale'`).run();

      const res = await request(app).get('/api/tenders?status=New Opportunity&excludeExpired=true');
      const ids = res.body.map((t: any) => t.id);
      expect(ids).toContain('t-undated-fresh');
      expect(ids).not.toContain('t-undated-stale');
    });
  });

  describe('Server SSE & Startup Integration', () => {
    it('serves SSE scan progress and closes cleanly', async () => {
      const http = await import('http');

      await new Promise<void>((resolve) => {
        const srv = app.listen(0, '127.0.0.1', () => {
          const port = (srv.address() as any).port;
          const req = http.get(`http://127.0.0.1:${port}/api/scan/progress`, (res: any) => {
            expect(res.headers['content-type']).toBe('text/event-stream');
            res.on('data', (chunk: any) => {
              const str = chunk.toString();
              expect(str).toContain('data:');
              req.destroy();
              srv.close(() => resolve());
            });
          });
        });
      });
    });

    it('returns 500 when backup creation fails', async () => {
      const dbModule = await import('../../src/server/db/index.js');
      const orig = dbModule.db.backup;
      (dbModule.db as any).backup = vi.fn().mockRejectedValue(new Error('fail'));

      const res = await request(app).post('/api/backups');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Backup failed');

      (dbModule.db as any).backup = orig;
    });

    it('starts server in production mode, serves fallback SPA index, and handles clean exit', async () => {
      const { startServer } = await import('../../server.js');
      const http = await import('http');
      const fs = await import('fs');
      const path = await import('path');
      const distDir = path.resolve(__dirname, '../../dist');
      const distIndex = path.resolve(distDir, 'index.html');
      let createdDistFixture = false;
      if (!fs.existsSync(distIndex)) {
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(distIndex, '<!DOCTYPE html><html><body><h1>Tender Tracker</h1></body></html>', 'utf-8');
        createdDistFixture = true;
      }

      const prevEnv = process.env.NODE_ENV;
      const prevPort = process.env.PORT;
      const origScan = schedulerDeps.startCrawlerScan;
      const origDrain = schedulerDeps.drainDocumentQueue;
      const origReclass = schedulerDeps.reclassifyExistingDossiersFromText;
      schedulerDeps.startCrawlerScan = vi.fn().mockResolvedValue({} as any);
      schedulerDeps.reclassifyExistingDossiersFromText = vi.fn().mockResolvedValue({ filesReclassified: 0 });
      schedulerDeps.drainDocumentQueue = vi.fn().mockResolvedValue({
        processed: 0,
        succeeded: 0,
        deferred: 0,
        failed: 0,
        batches: 0,
        readyRemaining: 0
      });
      process.env.NODE_ENV = 'production';
      process.env.PORT = '0';

      let srv: any;
      try {
        srv = await startServer();
        await new Promise<void>((resolve) => srv.on('listening', resolve));
        expect(srv.listening).toBe(true);

        const port = (srv.address() as any).port;
        await new Promise<void>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/client-spa-route`, (res: any) => {
            try {
              expect(res.statusCode).toBe(200);
              expect(res.headers['content-type']).toContain('text/html');
              resolve();
            } catch (err) {
              reject(err);
            }
          });
          req.on('error', reject);
        });
      } finally {
        stopStartupScheduler();
        schedulerDeps.startCrawlerScan = origScan;
        schedulerDeps.drainDocumentQueue = origDrain;
        schedulerDeps.reclassifyExistingDossiersFromText = origReclass;
        if (srv) {
          await new Promise<void>((resolve) => srv.close(() => resolve()));
        }
        process.env.NODE_ENV = prevEnv;
        process.env.PORT = prevPort;
        if (createdDistFixture) {
          try { fs.rmSync(distIndex, { force: true }); } catch {}
        }
      }
    });

    it('starts server in development mode and integrates Vite middleware', async () => {
      const { startServer } = await import('../../server.js');
      const prevEnv = process.env.NODE_ENV;
      const prevPort = process.env.PORT;
      const origScan = schedulerDeps.startCrawlerScan;
      const origDrain = schedulerDeps.drainDocumentQueue;
      const origReclass = schedulerDeps.reclassifyExistingDossiersFromText;
      schedulerDeps.startCrawlerScan = vi.fn().mockResolvedValue({} as any);
      schedulerDeps.reclassifyExistingDossiersFromText = vi.fn().mockResolvedValue({ filesReclassified: 0 });
      schedulerDeps.drainDocumentQueue = vi.fn().mockResolvedValue({
        processed: 0,
        succeeded: 0,
        deferred: 0,
        failed: 0,
        batches: 0,
        readyRemaining: 0
      });
      process.env.NODE_ENV = 'development';
      process.env.PORT = '0';

      let srv: any;
      try {
        srv = await startServer();
        await new Promise<void>((resolve) => srv.on('listening', resolve));
        expect(srv.listening).toBe(true);
      } finally {
        stopStartupScheduler();
        schedulerDeps.startCrawlerScan = origScan;
        schedulerDeps.drainDocumentQueue = origDrain;
        schedulerDeps.reclassifyExistingDossiersFromText = origReclass;
        if (srv) {
          await new Promise<void>((resolve) => srv.close(() => resolve()));
        }
        process.env.NODE_ENV = prevEnv;
        process.env.PORT = prevPort;
      }
    });

    it('executes graceful shutdown on SIGINT', async () => {
      const { startServer } = await import('../../server.js');
      const dbModule = await import('../../src/server/db/index.js');
      const prevEnv = process.env.NODE_ENV;
      const prevPort = process.env.PORT;
      const origScan = schedulerDeps.startCrawlerScan;
      const origDrain = schedulerDeps.drainDocumentQueue;
      const origReclass = schedulerDeps.reclassifyExistingDossiersFromText;
      schedulerDeps.startCrawlerScan = vi.fn().mockResolvedValue({} as any);
      schedulerDeps.reclassifyExistingDossiersFromText = vi.fn().mockResolvedValue({ filesReclassified: 0 });
      schedulerDeps.drainDocumentQueue = vi.fn().mockResolvedValue({
        processed: 0,
        succeeded: 0,
        deferred: 0,
        failed: 0,
        batches: 0,
        readyRemaining: 0
      });
      process.env.NODE_ENV = 'production';
      process.env.PORT = '0';

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const closeSpy = vi.spyOn(dbModule.db, 'close').mockImplementation(() => dbModule.db);
      let handler: any;
      try {
        const srv = await startServer();
        await new Promise<void>((resolve) => srv.on('listening', resolve));

        const sigintListeners = process.listeners('SIGINT');
        handler = sigintListeners[sigintListeners.length - 1];
        expect(handler).toBeDefined();

        await new Promise<void>((resolve) => {
          const origSrvClose = srv.close.bind(srv);
          srv.close = ((cb: any) => {
            origSrvClose(() => {
              if (cb) cb();
              resolve();
            });
            return srv;
          }) as any;
          handler('SIGINT');
        });

        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        stopStartupScheduler();
        schedulerDeps.startCrawlerScan = origScan;
        schedulerDeps.drainDocumentQueue = origDrain;
        schedulerDeps.reclassifyExistingDossiersFromText = origReclass;
        if (handler) process.removeListener('SIGINT', handler);
        closeSpy.mockRestore();
        exitSpy.mockRestore();
        process.env.NODE_ENV = prevEnv;
        process.env.PORT = prevPort;
      }
    });
  });

  describe('Plans B & C API Endpoints (Digest & Two-Speed Scan Depth)', () => {
    it('GET /api/system/digest returns closing alerts and POST /api/system/digest/settings updates config', async () => {
      const in12Hours = new Date(Date.now() + 12 * 3600000).toISOString();
      insertTestTender('t-api-urg', {
        title: 'Closing Tomorrow Tender',
        closing_date: in12Hours,
        pipeline_status: 'New Opportunity'
      });

      const badWebhook = await request(app)
        .post('/api/system/digest/settings')
        .send({ enabled: true, webhookUrl: 'http://127.0.0.1:8080/internal', withinHours: 36 });
      expect(badWebhook.status).toBe(400);

      const updRes = await request(app)
        .post('/api/system/digest/settings')
        .send({ enabled: true, webhookUrl: 'https://example.test/webhook', withinHours: 36 });
      expect(updRes.status).toBe(200);
      expect(updRes.body.settings.enabled).toBe(true);
      expect(updRes.body.settings.withinHours).toBe(36);

      const getRes = await request(app).get('/api/system/digest?hours=48');
      expect(getRes.status).toBe(200);
      expect(getRes.body.closingSoonCount).toBeGreaterThanOrEqual(1);
      expect(getRes.body.closingSoon.some((t: any) => t.id === 't-api-urg')).toBe(true);
      expect(getRes.body.settings.enabled).toBe(true);
    });

    it('POST /api/scan/start accepts optional depth parameter', async () => {
      const { scanRouteDeps } = await import('../../src/server/routes/scan.routes.js');
      const origStart = scanRouteDeps.startCrawlerScan;
      const startSpy = vi.fn().mockResolvedValue({
        isScanning: true,
        currentPortal: null,
        activePortals: [],
        scanDepth: 'deep',
        progressPercent: 0,
        completedPortals: 0,
        totalPortals: 1,
        newTendersFound: 0,
        corrigendaFound: 0,
        lastScanTimestamp: null
      });
      scanRouteDeps.startCrawlerScan = startSpy;

      try {
        const res = await request(app)
          .post('/api/scan/start')
          .send({ portalId: 'epms_ppra', depth: 'deep' });

        expect(res.status).toBe(200);
        expect(res.body.scanDepth).toBe('deep');
        expect(startSpy).toHaveBeenCalledWith('epms_ppra', false, { depth: 'deep' });
      } finally {
        scanRouteDeps.startCrawlerScan = origStart;
      }
    });
  });

  describe('Graceful Shutdown API (POST /api/system/shutdown)', () => {
    it('returns 403 when TENDER_SHUTDOWN_TOKEN is unset', async () => {
      const prevToken = process.env.TENDER_SHUTDOWN_TOKEN;
      delete process.env.TENDER_SHUTDOWN_TOKEN;
      try {
        const res = await request(app)
          .post('/api/system/shutdown')
          .set('X-Shutdown-Token', 'any-token');
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      } finally {
        if (prevToken === undefined) delete process.env.TENDER_SHUTDOWN_TOKEN;
        else process.env.TENDER_SHUTDOWN_TOKEN = prevToken;
      }
    });

    it('returns 403 when X-Shutdown-Token is missing, mismatched, or a different length', async () => {
      const { setShutdownHandler } = await import('../../src/server/routes/system.routes.js');
      const prevToken = process.env.TENDER_SHUTDOWN_TOKEN;
      process.env.TENDER_SHUTDOWN_TOKEN = 'secret-session-token-1234';
      const spy = vi.fn();
      setShutdownHandler(spy);

      try {
        const missing = await request(app).post('/api/system/shutdown');
        expect(missing.status).toBe(403);

        const wrongLength = await request(app)
          .post('/api/system/shutdown')
          .set('X-Shutdown-Token', 'short');
        expect(wrongLength.status).toBe(403);

        const sameLengthWrong = await request(app)
          .post('/api/system/shutdown')
          .set('X-Shutdown-Token', 'secret-session-token-9999');
        expect(sameLengthWrong.status).toBe(403);

        expect(spy).not.toHaveBeenCalled();
      } finally {
        setShutdownHandler(null);
        if (prevToken === undefined) delete process.env.TENDER_SHUTDOWN_TOKEN;
        else process.env.TENDER_SHUTDOWN_TOKEN = prevToken;
      }
    });

    it('returns 503 when token matches but no shutdown handler is registered', async () => {
      const { setShutdownHandler } = await import('../../src/server/routes/system.routes.js');
      const prevToken = process.env.TENDER_SHUTDOWN_TOKEN;
      process.env.TENDER_SHUTDOWN_TOKEN = 'secret-session-token-1234';
      setShutdownHandler(null);

      try {
        const res = await request(app)
          .post('/api/system/shutdown')
          .set('X-Shutdown-Token', 'secret-session-token-1234');
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
      } finally {
        setShutdownHandler(null);
        if (prevToken === undefined) delete process.env.TENDER_SHUTDOWN_TOKEN;
        else process.env.TENDER_SHUTDOWN_TOKEN = prevToken;
      }
    });

    it('returns 200, sets Connection: close, and invokes the shutdown handler on valid token', async () => {
      const { setShutdownHandler } = await import('../../src/server/routes/system.routes.js');
      const prevToken = process.env.TENDER_SHUTDOWN_TOKEN;
      process.env.TENDER_SHUTDOWN_TOKEN = 'valid-shutdown-token-9876';
      const handlerSpy = vi.fn();
      setShutdownHandler(handlerSpy);

      try {
        const res = await request(app)
          .post('/api/system/shutdown')
          .set('X-Shutdown-Token', 'valid-shutdown-token-9876');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.headers.connection).toBe('close');

        await new Promise(resolve => setTimeout(resolve, 100));
        expect(handlerSpy).toHaveBeenCalledTimes(1);
      } finally {
        setShutdownHandler(null);
        if (prevToken === undefined) delete process.env.TENDER_SHUTDOWN_TOKEN;
        else process.env.TENDER_SHUTDOWN_TOKEN = prevToken;
      }
    });
  });

  describe('Network Health API (/api/system/network)', () => {
    it('GET /api/system/network and POST /api/system/network/check return connectivity state and deferred task counters', async () => {
      const { networkMonitorDeps, resetNetworkMonitorForTests } = await import('../../src/server/services/networkMonitor.js');
      resetNetworkMonitorForTests();
      networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: true, latencyMs: 1850 });

      try {
        const getRes = await request(app).get('/api/system/network');
        expect(getRes.status).toBe(200);
        expect(getRes.body.state).toBe('degraded');
        expect(getRes.body.heavyTasksPaused).toBe(true);
        expect(getRes.body.deferredHeavyTasks).toEqual({
          deepScanPending: false,
          pendingDocumentJobs: 0
        });

        networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: true, latencyMs: 42 });
        const checkRes = await request(app).post('/api/system/network/check');
        expect(checkRes.status).toBe(200);
        expect(checkRes.body.state).toBe('online');
        expect(checkRes.body.heavyTasksPaused).toBe(false);
        expect(checkRes.body.latencyMs).toBe(42);
      } finally {
        resetNetworkMonitorForTests();
      }
    });
  });
});
