import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db, initDatabase, DOSSIERS_DIR, setAppSetting } from '../../src/server/db/index.js';
import {
  inferDocType,
  deriveRefSlug,
  generateCanonicalFilename,
  getPortalFileCode,
  saveTenderDocument,
  renameDossierToCanonical,
  migrateDossierFilenames,
  reclassifyExistingDossiersFromText,
  purgeTenderFiles,
  retryPendingFilePurges,
  reconcileDossiers,
  TRASH_DIR
} from '../../src/server/services/dossierStore.js';
import { makePdf, FILLER } from '../fixtures/documents/buildFixtures.js';

describe('dossierStore', () => {
  const testTenderId = 'tender-dossier-store-test-1';
  const testDir = path.resolve(DOSSIERS_DIR, testTenderId);

  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM tenders WHERE id = ?').run(testTenderId);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('Document Type and Slug Inference', () => {
    it('infers docType accurately from file labels, names, and remote URL paths', () => {
      expect(inferDocType('Corrigendum Notice 1.pdf')).toBe('corrigendum');
      expect(inferDocType('Amendment 2 to RFP.pdf')).toBe('corrigendum');
      expect(inferDocType('BOQ_Civil_Works.xlsx')).toBe('boq');
      expect(inferDocType('Bill of Quantities.xlsx')).toBe('boq');
      expect(inferDocType('RFP Document Solar.pdf')).toBe('rfp');
      expect(inferDocType('Terms of Reference TOR.docx')).toBe('tor');
      expect(inferDocType('Architectural Drawings Sheet 1.pdf')).toBe('drawings');
      expect(inferDocType('Clarification Minutes of Pre-Bid.pdf')).toBe('clarification');
      expect(inferDocType('Tender Notice Advertisement.jpg')).toBe('notice');
      expect(inferDocType('General Miscellaneous Attachment.bin')).toBe('other');

      expect(inferDocType('Doc', 'https://eproc.punjab.gov.pk/BiddingDocuments/50485054/111.pdf')).toBe('bidding-document');
      expect(inferDocType('Doc', 'https://eproc.punjab.gov.pk/Tenders/50485054/222.pdf')).toBe('notice');
      expect(inferDocType('Doc', 'https://bpptwo.vdc.services:9446/Images/BOQManual/solar-boq.pdf')).toBe('boq');
    });

    it('derives clean ref slugs and clean word-boundary title slugs (appending id only for generic titles)', () => {
      expect(deriveRefSlug('CDA-PROC/2026/114', 'Solarization Project', 't-1234')).toBe('CDA-PROC-2026-114');
      expect(deriveRefSlug('', 'Installation of Grid Tied Solar Systems for Schools', 'tender-89ab')).toBe(
        'Installation-of-Grid-Tied-Solar-Systems-for-Schools'
      );
      expect(deriveRefSlug('', 'Installation of Grid Tied Solar Systems for Schools', 'tender-89ab', 40)).toBe(
        'Installation-of-Grid-Tied-Solar-Systems'
      );
      expect(deriveRefSlug('N/A', 'Tender Notice', 'tender-xyz1')).toBe('Tender-Notice-xyz1');
    });

    it('maps portal IDs to standard uppercase file codes', () => {
      expect(getPortalFileCode('epms_ppra')).toBe('FPPRA');
      expect(getPortalFileCode('punjab_eproc')).toBe('PPPRA');
      expect(getPortalFileCode('sppra')).toBe('SPPRA');
      expect(getPortalFileCode('kppra')).toBe('KPPRA');
      expect(getPortalFileCode('bppra')).toBe('BPPRA');
      expect(getPortalFileCode('gilgit')).toBe('GBPPRA');
      expect(getPortalFileCode('ndma')).toBe('NDMA');
      expect(getPortalFileCode('ungm')).toBe('UNGM');
      expect(getPortalFileCode('giz')).toBe('GIZ');
      expect(getPortalFileCode('custom_portal')).toBe('CUSTOM');
      expect(getPortalFileCode(null)).toBe('GEN');
    });
  });

  describe('Canonical Filename Formatting', () => {
    it('formats canonical filename complying with {PORTAL}_{Ref_or_Title}_{DocType}-{N}.{ext} (hash-free)', () => {
      const buffer = Buffer.from('test dummy file buffer content 123');
      const { filename, hash8 } = generateCanonicalFilename({
        portalCode: 'FPPRA',
        referenceNo: 'CDA-PROC-2026-114',
        title: 'Solar System',
        tenderId: 't-1',
        docType: 'bidding-document',
        index: 1,
        buffer,
        extension: '.pdf'
      });

      expect(filename).toBe('FPPRA_CDA-PROC-2026-114_Bidding-Document-1.pdf');
      expect(filename.length).toBeLessThanOrEqual(100);
      expect(hash8.length).toBe(8);
    });

    it('caps total filename length at 100 characters max while preserving docType suffix and extension', () => {
      const buffer = Buffer.from('large filename test content');
      const veryLongRef = 'VERY-LONG-REFERENCE-NUMBER-EXCEEDING-STANDARD-LIMITS-1234567890-ABCDEFGHIJKLM';
      const { filename } = generateCanonicalFilename({
        portalCode: 'VERYLONGPORTALCODE',
        referenceNo: veryLongRef,
        title: 'Extremely Long Tender Title That Should Be Capped Cleanly',
        tenderId: 't-very-long-id-123456789',
        docType: 'bidding-document',
        index: 1,
        buffer,
        extension: '.pdf'
      });

      expect(filename.length).toBeLessThanOrEqual(100);
      expect(filename.endsWith('_Bidding-Document-1.pdf')).toBe(true);
    });

    it('increments index for distinct URLs and versions -v2 for updated bytes from the same URL', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url)
        VALUES (?, ?, 'punjab_eproc', 'Punjab PPRA', NULL, 'PEIMA School Rehabilitation', 'SED', 'https://eproc.punjab.gov.pk/1')
      `).run(testTenderId, testTenderId);

      const doc1 = saveTenderDocument(testTenderId, Buffer.from('%PDF-1.4 doc A'), {
        portalCode: 'PPPRA',
        title: 'PEIMA School Rehabilitation',
        originalUrl: 'https://eproc.punjab.gov.pk/BiddingDocuments/a.pdf',
        source: 'portal_scrape'
      });
      expect(path.basename(doc1.localPath)).toBe('PPPRA_PEIMA-School-Rehabilitation_Bidding-Document-1.pdf');

      const doc2 = saveTenderDocument(testTenderId, Buffer.from('%PDF-1.4 doc B different'), {
        portalCode: 'PPPRA',
        title: 'PEIMA School Rehabilitation',
        originalUrl: 'https://eproc.punjab.gov.pk/BiddingDocuments/b.pdf',
        existingDossiers: [doc1],
        source: 'portal_scrape'
      });
      expect(path.basename(doc2.localPath)).toBe('PPPRA_PEIMA-School-Rehabilitation_Bidding-Document-2.pdf');

      const doc1Updated = saveTenderDocument(testTenderId, Buffer.from('%PDF-1.4 doc A v2 bytes'), {
        portalCode: 'PPPRA',
        title: 'PEIMA School Rehabilitation',
        originalUrl: 'https://eproc.punjab.gov.pk/BiddingDocuments/a.pdf',
        existingDossiers: [doc1, doc2],
        source: 'portal_scrape'
      });
      expect(path.basename(doc1Updated.localPath)).toBe('PPPRA_PEIMA-School-Rehabilitation_Bidding-Document-1-v2.pdf');
      expect(doc1Updated.label).toContain('(Updated)');
    });
  });

  describe('File Operations & Atomic Saving', () => {
    it('saves tender documents atomically with full metadata', () => {
      const buffer = Buffer.from('%PDF-1.4 Dummy Atomic PDF');
      const doc = saveTenderDocument(testTenderId, buffer, {
        portalCode: 'FPPRA',
        referenceNo: 'REF-999',
        title: 'School Upgrades',
        label: 'Main RFP Specs',
        originalUrl: 'https://example.com/rfp.pdf',
        originalName: 'rfp.pdf',
        docType: 'rfp',
        index: 1,
        source: 'portal_scrape'
      });

      expect(doc.docType).toBe('rfp');
      expect(doc.source).toBe('portal_scrape');
      expect(doc.originalName).toBe('rfp.pdf');
      expect(doc.localPath).toContain('/api/dossiers/');
      expect(doc.sizeBytes).toBe(buffer.length);

      const filePath = path.resolve(DOSSIERS_DIR, testTenderId, path.basename(decodeURIComponent(doc.localPath)));
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath)).toEqual(buffer);
    });

    it('purges tender dossier directory moving to .trash', () => {
      const buffer = Buffer.from('temporary dossier content');
      saveTenderDocument(testTenderId, buffer, {
        portalCode: 'PPPRA',
        referenceNo: 'PURGE-1',
        title: 'To Purge',
        docType: 'notice'
      });

      expect(fs.existsSync(testDir)).toBe(true);

      const { purged } = purgeTenderFiles([testTenderId]);
      expect(purged).toContain(testTenderId);
      expect(fs.existsSync(testDir)).toBe(false);
    });
  });

  describe('Reconcile & Pending Purges', () => {
    it('reconciles orphan dossier directories not associated with any database tender', () => {
      const orphanId = 'orphan-test-directory-99';
      const orphanDir = path.resolve(DOSSIERS_DIR, orphanId);
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(path.resolve(orphanDir, 'test.pdf'), 'orphan file');

      // Ensure it is not in the database
      db.prepare('DELETE FROM tenders WHERE id = ?').run(orphanId);

      // Reconcile with graceMinutes = 0 so it detects it immediately
      const result = reconcileDossiers({ dryRun: false, graceMinutes: 0 });
      expect(result.orphanFoldersCount).toBeGreaterThanOrEqual(1);
      expect(result.orphanFolders.some(f => f.id === orphanId)).toBe(true);
      expect(fs.existsSync(orphanDir)).toBe(false);
    });

    it('retries pending file purges from queue table', () => {
      const testLockPath = path.resolve(TRASH_DIR, `test-locked-${Date.now()}`);
      fs.mkdirSync(testLockPath, { recursive: true });
      fs.writeFileSync(path.resolve(testLockPath, 'locked.tmp'), 'locked content');

      db.prepare(`
        INSERT INTO pending_file_purges (id, folder_path, attempts, last_error)
        VALUES (?, ?, 0, 'Initial lock')
      `).run('test-lock-id', testLockPath);

      const cleared = retryPendingFilePurges();
      expect(cleared).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(testLockPath)).toBe(false);

      const check = db.prepare('SELECT id FROM pending_file_purges WHERE id = ?').get('test-lock-id');
      expect(check).toBeUndefined();
    });
  });

  describe('Startup Filename Migration and Text Reclassification', () => {
    it('migrates legacy *_Doc files idempotently and reclassifies Amendment PDFs from local text', async () => {
      fs.mkdirSync(testDir, { recursive: true });
      const biddBuf = makePdf(['STANDARD BIDDING DOCUMENT', ...FILLER]);
      const amendBuf = makePdf(['AMENDMENT NO-02', 'The closing date is extended.', ...FILLER]);
      fs.writeFileSync(path.resolve(testDir, 'Rehabilitation_Of_Dangerous_PS_Doc.pdf'), biddBuf);
      fs.writeFileSync(path.resolve(testDir, 'Rehabilitation_Of_Dangerous_PS_Doc_2.pdf'), amendBuf);

      const legacyDossiers = [
        {
          label: 'Rehabilitation Of Dangerous PS_Doc',
          localPath: `/api/dossiers/${testTenderId}/Rehabilitation_Of_Dangerous_PS_Doc.pdf`,
          originalUrl: 'https://eproc.punjab.gov.pk/BiddingDocuments/123.pdf',
          mimeType: 'application/pdf',
          sizeBytes: biddBuf.length
        },
        {
          label: 'Rehabilitation Of Dangerous PS_Doc 2',
          localPath: `/api/dossiers/${testTenderId}/Rehabilitation_Of_Dangerous_PS_Doc_2.pdf`,
          originalUrl: 'https://eproc.punjab.gov.pk/Tenders/456.pdf',
          mimeType: 'application/pdf',
          sizeBytes: amendBuf.length
        }
      ];

      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, cached_dossiers)
        VALUES (?, ?, 'punjab_eproc', 'Punjab PPRA', NULL, 'Rehabilitation Of Dangerous PEIMA North Zone', 'SED', 'https://eproc.punjab.gov.pk/detail/1', ?)
      `).run(testTenderId, testTenderId, JSON.stringify(legacyDossiers));

      const first = migrateDossierFilenames();
      expect(first.tendersUpdated).toBe(1);
      expect(first.filesRenamed).toBe(2);

      // Idempotent on second run
      const second = migrateDossierFilenames();
      expect(second.tendersUpdated).toBe(0);
      expect(second.filesRenamed).toBe(0);

      setAppSetting('dossier_text_classify_v1', '');
      const reclass = await reclassifyExistingDossiersFromText();
      expect(reclass.filesReclassified).toBe(1);

      const row = db.prepare('SELECT cached_dossiers FROM tenders WHERE id = ?').get(testTenderId) as { cached_dossiers: string };
      const parsed = JSON.parse(row.cached_dossiers);
      expect(parsed[0].docType).toBe('bidding-document');
      expect(parsed[0].localPath).toContain('PPPRA_Rehabilitation-Of-Dangerous-PEIMA-North-Zone_Bidding-Document-1.pdf');
      expect(parsed[1].docType).toBe('corrigendum');
      expect(parsed[1].localPath).toContain('PPPRA_Rehabilitation-Of-Dangerous-PEIMA-North-Zone_Corrigendum-1.pdf');
      expect(fs.existsSync(path.resolve(testDir, 'PPPRA_Rehabilitation-Of-Dangerous-PEIMA-North-Zone_Corrigendum-1.pdf'))).toBe(true);

      // renameDossierToCanonical direct check
      const renamedDirect = renameDossierToCanonical(
        { id: testTenderId, portal_id: 'punjab_eproc', reference_no: null, title: 'Rehabilitation Of Dangerous PEIMA North Zone' },
        parsed[0],
        'rfp',
        parsed
      );
      expect(renamedDirect.renamed).toBe(true);
      expect(renamedDirect.dossier.localPath).toContain('_RFP-1.pdf');
    });
  });
});
