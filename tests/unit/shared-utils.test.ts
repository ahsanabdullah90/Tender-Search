import { describe, it, expect, beforeEach } from 'vitest';
import { getPktDateKey, endOfPktDayMs } from '../../src/shared/pktDate.js';
import { isCorrigendumLabel } from '../../src/shared/documentUtils.js';
import { detectExtensionAndMime } from '../../src/server/services/fileUtils.js';
import { saveManualDossier } from '../../src/server/services/dossierManager.js';
import { inferDocType } from '../../src/server/services/dossierStore.js';
import { documentJobPriority, JOB_PRIORITY } from '../../src/server/db/repositories/ingestJobsRepo.js';
import { initDatabase } from '../../src/server/db/index.js';
import { isAuctionOrDisposalTender, shouldEarlyStopKnownPage } from '../../src/server/scrapers/scraperUtils.js';
import { maskApiKey, decodeBase64Payload } from '../../src/server/routes/routeUtils.js';

describe('Phase 3A consolidated shared utilities', () => {
  beforeEach(() => {
    initDatabase();
  });

  it('computes consistent PKT calendar day keys and end-of-day bounds', () => {
    // 2026-12-21T20:00:00Z === 2026-12-22 01:00 PKT
    expect(getPktDateKey('2026-12-21T20:00:00.000Z')).toBe('2026-12-22');
    expect(endOfPktDayMs('2026-12-21T20:00:00.000Z')).toBe(Date.parse('2026-12-22T23:59:59.999+05:00'));
    expect(Number.isNaN(endOfPktDayMs('not-a-date'))).toBe(true);
  });

  it('detects WebP magic bytes, image/webp header, and extensionless DOCX files accurately', () => {
    const webpBuf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
    ]);
    expect(detectExtensionAndMime(webpBuf)).toEqual({ ext: '.webp', mimeType: 'image/webp' });
    expect(detectExtensionAndMime(Buffer.from('opaque'), 'image/webp')).toEqual({ ext: '.webp', mimeType: 'image/webp' });

    const docxZip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('...[Content_Types].xml word/document.xml...')
    ]);
    expect(detectExtensionAndMime(docxZip)).toEqual({
      ext: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });

    const manualDoc = saveManualDossier('t-extensionless-docx', 'rfp-package', docxZip, 'Bidding Spec');
    expect(manualDoc.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(manualDoc.localPath.endsWith('.docx')).toBe(true);
  });

  it('unifies corrigendum matching across shared predicate, inferDocType, and documentJobPriority', () => {
    for (const label of ['Date_Extension.pdf', 'Addenda', 'Notice_corr.pdf']) {
      expect(isCorrigendumLabel(label)).toBe(true);
      expect(inferDocType(label)).toBe('corrigendum');
      expect(documentJobPriority(label)).toBe(JOB_PRIORITY.corrigendum);
    }
  });

  it('filters auction and disposal notices across wood, fruit, and toll tax variants', () => {
    expect(isAuctionOrDisposalTender('Sale of trees and wood at Forestry Division')).toBe(true);
    expect(isAuctionOrDisposalTender('Sale of fruit orchids in Swat')).toBe(true);
    expect(isAuctionOrDisposalTender('Auction of toll tax collection points')).toBe(true);
    expect(isAuctionOrDisposalTender('Supply of Solar Hybrid Inverters', 'Goods')).toBe(false);
  });

  it('stops pagination only on unchanged PKT-day pages without new corrigenda', () => {
    const knownMap = new Map([
      ['https://example.gov.pk/t/1', { closing_date: '2026-12-22T09:00:00.000Z', has_corrigendum: 0 }],
      ['https://example.gov.pk/t/2', { closing_date: '2026-12-23T09:00:00.000Z', has_corrigendum: 0 }]
    ]);
    expect(
      shouldEarlyStopKnownPage(
        [
          { directUrl: 'https://example.gov.pk/t/1', closingDate: '2026-12-22T14:00:00.000Z' },
          { directUrl: 'https://example.gov.pk/t/2', closingDate: '2026-12-23T11:30:00+05:00' }
        ],
        knownMap
      )
    ).toBe(true);

    // New corrigendum prevents early stop even when closing date is on the same PKT day
    expect(
      shouldEarlyStopKnownPage(
        [
          { directUrl: 'https://example.gov.pk/t/1', closingDate: '2026-12-22T09:00:00.000Z', isCorrigendum: true },
          { directUrl: 'https://example.gov.pk/t/2', closingDate: '2026-12-23T09:00:00.000Z' }
        ],
        knownMap
      )
    ).toBe(false);
  });

  it('masks API keys and decodes data-URI base64 payloads cleanly', () => {
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey('short')).toBe('••••••••');
    expect(maskApiKey('AIzaSy1234567890WXYZ')).toBe('AIza••••WXYZ');
    const decoded = decodeBase64Payload('data:text/plain;base64,SGVsbG8=').toString('utf8');
    expect(decoded).toBe('Hello');
  });
});
