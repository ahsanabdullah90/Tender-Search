import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db, initDatabase, DOSSIERS_DIR } from '../../src/server/db.js';
import {
  inferDocType,
  deriveRefSlug,
  generateCanonicalFilename,
  getPortalFileCode,
  saveTenderDocument,
  purgeTenderFiles,
  retryPendingFilePurges,
  reconcileDossiers,
  TRASH_DIR
} from '../../src/server/dossierStore.js';

describe('dossierStore', () => {
  const testTenderId = 'tender-dossier-store-test-1';
  const testDir = path.resolve(DOSSIERS_DIR, testTenderId);

  beforeEach(() => {
    initDatabase();
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
    it('infers docType accurately from file labels and names', () => {
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
    });

    it('derives clean ref slugs and falls back to title slug with id suffix', () => {
      expect(deriveRefSlug('CDA-PROC/2026/114', 'Solarization Project', 't-1234')).toBe('CDA-PROC-2026-114');
      expect(deriveRefSlug('', 'Installation of Grid Tied Solar Systems for Schools', 'tender-89ab')).toBe('Installation-of-Grid-Tied-Sola-89ab');
      expect(deriveRefSlug('N/A', 'Supply of IT Equipment and Consumables', 'tender-xyz1')).toBe('Supply-of-IT-Equipment-and-Con-xyz1');
    });

    it('maps portal IDs to standard uppercase file codes', () => {
      expect(getPortalFileCode('epads')).toBe('FPPRA');
      expect(getPortalFileCode('punjab_eproc')).toBe('PPPRA');
      expect(getPortalFileCode('sppra')).toBe('SPPRA');
      expect(getPortalFileCode('kppra')).toBe('KPPRA');
      expect(getPortalFileCode('bppra')).toBe('BPPRA');
      expect(getPortalFileCode('ndma')).toBe('NDMA');
      expect(getPortalFileCode('ungm')).toBe('UNGM');
      expect(getPortalFileCode('giz')).toBe('GIZ');
      expect(getPortalFileCode('custom_portal')).toBe('CUSTOM');
      expect(getPortalFileCode(null)).toBe('GEN');
    });
  });

  describe('Canonical Filename Formatting', () => {
    it('formats canonical filename complying with {PORTAL}__{REF}__{type}-{n}__{hash8}.{ext}', () => {
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

      expect(filename).toBe(`FPPRA__CDA-PROC-2026-114__bidding-document-1__${hash8}.pdf`);
      expect(filename.length).toBeLessThanOrEqual(100);
      expect(hash8.length).toBe(8);
    });

    it('caps total filename length at 100 characters max', () => {
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
      expect(filename.endsWith('.pdf')).toBe(true);
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
});
