import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as ocrSvc from '../../src/server/ocrService.js';
import { initDatabase, setAppSetting } from '../../src/server/db.js';
import {
  extractDocumentText,
  extractFromDocument,
  findSubmissionDeadlines,
  findReferenceNumber,
  findEstimatedValue,
  findScopeText
} from '../../src/server/documentExtractor.js';
import { makePdf, makeMultiPagePdf, makeDocx, FILLER } from '../fixtures/documents/buildFixtures.js';

const pkt = (iso: string) => new Date(iso).toISOString();

describe('documentExtractor (Phase 2)', () => {
  beforeEach(() => {
    initDatabase();
    setAppSetting('gemini_api_key', '');
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setAppSetting('gemini_api_key', '');
  });

  describe('anchored deadline patterns', () => {
    it('picks the submission date, not issue, pre-bid, opening or validity dates', () => {
      const text = [
        'Date of issue of bidding documents: 01-11-2026',
        'Pre-bid meeting will be held on 10-11-2026 at 11:00 AM',
        'Last date for submission of bids is 25-11-2026 at 11:00 AM',
        'Bids will be opened on 25-11-2026 at 11:30 AM in the presence of bidders',
        'Bids shall remain valid for 90 days from 26-11-2026'
      ].join('\n');
      expect(findSubmissionDeadlines(text)).toEqual([pkt('2026-11-25T11:00:00+05:00')]);
    });

    it('handles common Pakistani phrasings and time formats', () => {
      expect(findSubmissionDeadlines('Bids should reach this office on or before 15.12.2026 by 2:30 PM')).toEqual([pkt('2026-12-15T14:30:00+05:00')]);
      expect(findSubmissionDeadlines('Last date for submission of documents shall be 20-11-2026 (11:00 a.m)')).toEqual([pkt('2026-11-20T11:00:00+05:00')]);
      expect(findSubmissionDeadlines('Closing Date: 3rd December, 2026')).toEqual([pkt('2026-12-03T14:00:00+05:00')]);
      expect(findSubmissionDeadlines('Sale of bidding documents on or before 05-11-2026')).toEqual([]);

      // A8: military time formats
      expect(findSubmissionDeadlines('on or before 15-12-2026 at 1100 hrs')).toEqual([pkt('2026-12-15T11:00:00+05:00')]);
      expect(findSubmissionDeadlines('submission deadline: 15-12-2026 at 1430 hrs')).toEqual([pkt('2026-12-15T14:30:00+05:00')]);
      expect(findSubmissionDeadlines('closing date: 15-12-2026 at 1430 hours')).toEqual([pkt('2026-12-15T14:30:00+05:00')]);
      expect(findSubmissionDeadlines('last date for submission: 15-12-2026 at 11:00 AM')).toEqual([pkt('2026-12-15T11:00:00+05:00')]);

      // Tabular pre-anchor dates: "<Date> by or before <Time>"
      expect(findSubmissionDeadlines('Provision of Trainers October 28, 2026 by or before 03:00 PM')).toEqual([pkt('2026-10-28T15:00:00+05:00')]);
      expect(findSubmissionDeadlines('Last Date of Submission of Association Form March 10 , 2026 at 11:00 AM')).toEqual([pkt('2026-03-10T11:00:00+05:00')]);
    });

    it('returns several distinct deadlines when a document is ambiguous', () => {
      const text = 'Last date for submission: 20-11-2026.\nCorrected: the deadline for submission is 27-11-2026.';
      expect(findSubmissionDeadlines(text)).toHaveLength(2);
    });

    it('finds reference numbers, estimated values and scope', () => {
      expect(findReferenceNumber('Tender No. FDE/IT/2026-77 dated 1st Nov')).toBe('FDE/IT/2026-77');
      expect(findReferenceNumber('Tender Notice for supply')).toBeNull();
      expect(findEstimatedValue('Estimated Cost: Rs. 9,901,242/-')).toBe('PKR 9,901,242');
      expect(findEstimatedValue('Estimated cost 25 million')).toBe('PKR 25 million');
      expect(findScopeText('Header text. Scope of Work: supply of 40 laptops and 2 servers.')).toMatch(/^Scope of Work: supply of 40 laptops/);
    });
  });

  describe('local text extraction', () => {
    it('reads the text layer of a digital PDF', async () => {
      const pdf = makePdf([...FILLER, 'Last date for submission of bids: 25-11-2026 at 11:00 AM']);
      const doc = await extractDocumentText(pdf, 'application/pdf');
      expect(doc.kind).toBe('pdf');
      expect(doc.text).toContain('Last date for submission of bids: 25-11-2026');
    });

    it('reads all pages of a multi-page PDF without truncating at page 5', async () => {
      const pages = [
        [...FILLER, 'Page 1 Scope of Work'],
        ['Page 2 Terms and conditions'],
        ['Page 3 Technical evaluation criteria'],
        ['Page 4 Financial criteria'],
        ['Page 5 Submission instructions'],
        ['Page 6 Annexures and declarations'],
        ['Page 7: Last date for submission of bids is 30-12-2026 at 11:00 AM']
      ];
      const pdf = makeMultiPagePdf(pages);
      const doc = await extractDocumentText(pdf, 'application/pdf');
      expect(doc.pages).toBe(7);
      expect(doc.text).toContain('Last date for submission of bids is 30-12-2026');

      const extracted = await extractFromDocument(pdf, 'application/pdf', 'Multi-Page RFP');
      expect(extracted.closingDateISO).toBe(pkt('2026-12-30T11:00:00+05:00'));
      expect(extracted.confidence).toBe('high');
      expect(extracted.canAutoExpire).toBe(true);
    });

    it('reads a .docx file', async () => {
      const docx = await makeDocx(['Tender No. PSEB-CLOUD-2026-01', 'Closing date: 30-12-2026']);
      const doc = await extractDocumentText(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(doc.kind).toBe('docx');
      expect(doc.text).toContain('PSEB-CLOUD-2026-01');
    });
  });

  describe('extractFromDocument routing and confidence', () => {
    it('digital PDF with one anchored deadline → local, high confidence, can auto-expire, no Gemini call', async () => {
      const vision = vi.spyOn(ocrSvc, 'extractTenderFromImage');
      const text = vi.spyOn(ocrSvc, 'summarizeTenderTextWithAI');
      const pdf = makePdf([...FILLER, 'Tender No. FDE/IT/2026-77', 'Estimated Cost: Rs. 4,500,000', 'Last date for submission of bids: 25-11-2026 at 11:00 AM']);

      const r = await extractFromDocument(pdf, 'application/pdf', 'RFP Laptops');
      expect(r.extractionMethod).toBe('local_text_regex');
      expect(r.confidence).toBe('high');
      expect(r.closingDateISO).toBe(pkt('2026-11-25T11:00:00+05:00'));
      expect(r.canAutoExpire).toBe(true);
      expect(r.referenceNo).toBe('FDE/IT/2026-77');
      expect(r.estimatedValue).toBe('PKR 4,500,000');
      expect(vision).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    });

    it('ambiguous deadlines → latest date, medium confidence, may not auto-expire', async () => {
      const pdf = makePdf([...FILLER, 'Last date for submission: 20-11-2026', 'Deadline for submission: 27-11-2026']);
      const r = await extractFromDocument(pdf, 'application/pdf', 'Notice');
      expect(r.confidence).toBe('medium');
      expect(r.closingDateISO).toBe(pkt('2026-11-27T14:00:00+05:00'));
      expect(r.canAutoExpire).toBe(false);
    });

    it('AI cross-check that agrees raises confidence to high', async () => {
      setAppSetting('gemini_api_key', 'test-key');
      vi.spyOn(ocrSvc, 'summarizeTenderTextWithAI').mockResolvedValueOnce({
        referenceNo: null, organization: '', title: '', closingDateISO: '2026-11-27T14:00:00+05:00',
        closingDateFormatted: '27 Nov 2026', estimatedValue: null, summaryScope: 'AI scope', isCorrigendum: false
      });
      const pdf = makePdf([...FILLER, 'Last date for submission: 20-11-2026', 'Deadline for submission: 27-11-2026']);
      const r = await extractFromDocument(pdf, 'application/pdf', 'Notice');
      expect(r.extractionMethod).toBe('local_text_ai');
      expect(r.confidence).toBe('high');
      expect(r.summaryScope).toBe('AI scope');
    });

    it('scanned PDF (no text layer) goes to Gemini Vision when a key is set', async () => {
      setAppSetting('gemini_api_key', 'test-key');
      const vision = vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce({
        referenceNo: 'SCAN-1', organization: '', title: '', closingDateISO: '2026-12-01T11:00:00+05:00',
        closingDateFormatted: '01 Dec 2026, 11:00 AM PKT', estimatedValue: null, summaryScope: 'Scanned notice', isCorrigendum: false
      });
      const r = await extractFromDocument(makePdf([]), 'application/pdf', 'Notice scan');
      expect(vision).toHaveBeenCalledTimes(1);
      expect(r.extractionMethod).toBe('gemini_vision');
      expect(r.confidence).toBe('medium');
      expect(r.closingDateISO).toBe(pkt('2026-12-01T11:00:00+05:00'));
      expect(r.canAutoExpire).toBe(true);
    });

    it('scanned document without a key, or over the Vision budget, is marked needsVision', async () => {
      const vision = vi.spyOn(ocrSvc, 'extractTenderFromImage');
      const noKey = await extractFromDocument(makePdf([]), 'application/pdf', 'scan');
      expect(noKey.needsVision).toBe(true);
      expect(noKey.closingDateISO).toBeNull();

      setAppSetting('gemini_api_key', 'test-key');
      vision.mockClear();
      const overBudget = await extractFromDocument(Buffer.from('jpeg-bytes'), 'image/jpeg', 'clipping', { allowVisionCall: () => false });
      expect(overBudget.needsVision).toBe(true);
      expect(vision).not.toHaveBeenCalled();
    });

    it('never stores an unparseable Vision date', async () => {
      setAppSetting('gemini_api_key', 'test-key');
      vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce({
        referenceNo: null, organization: '', title: '', closingDateISO: 'next Friday',
        closingDateFormatted: 'next Friday', estimatedValue: null, summaryScope: '', isCorrigendum: false
      });
      const r = await extractFromDocument(Buffer.from('jpeg-bytes'), 'image/jpeg', 'clipping');
      expect(r.closingDateISO).toBeNull();
      expect(r.canAutoExpire).toBe(false);
    });

    it('detects corrigenda and cancellations from the document text', async () => {
      const ext = await extractFromDocument(
        makePdf(['CORRIGENDUM', ...FILLER, 'The last date for submission of bids is extended to 10-12-2026 at 11:00 AM']),
        'application/pdf',
        'document-2.pdf'
      );
      expect(ext.docType).toBe('corrigendum');
      expect(ext.isCancellation).toBe(false);

      const cancel = await extractFromDocument(
        makePdf(['CORRIGENDUM', ...FILLER, 'The above tender has been cancelled due to administrative reasons.']),
        'application/pdf',
        'notice.pdf'
      );
      expect(cancel.docType).toBe('corrigendum');
      expect(cancel.isCancellation).toBe(true);
    });

    it('DL-10 / A9: Standard Bidding Document Table of Contents is NOT detected as corrigendum or cancellation', async () => {
      const sbdText = [
        'STANDARD BIDDING DOCUMENT',
        'Table of Contents',
        '1. Instructions to Bidders',
        '8. Amendment of Bidding Documents',
        '23. Bid Security: forfeited if the bid is withdrawn',
        ...FILLER,
        'Last date for submission of bids: 25-12-2026 at 11:00 AM'
      ];
      const sbd = await extractFromDocument(
        makePdf(sbdText),
        'application/pdf',
        'Bidding-Document-SBD.pdf'
      );
      expect(sbd.docType).not.toBe('corrigendum');
      expect(sbd.isCancellation).toBe(false);
      expect(sbd.closingDateISO).toBe(pkt('2026-12-25T11:00:00+05:00'));
    });

    it('a document with text but no deadline returns no date and low confidence', async () => {
      const r = await extractFromDocument(makePdf([...FILLER, 'Bill of quantities: item 1 cement 500 bags']), 'application/pdf', 'BOQ');
      expect(r.closingDateISO).toBeNull();
      expect(r.confidence).toBe('low');
      expect(r.canAutoExpire).toBe(false);
    });
  });
});
