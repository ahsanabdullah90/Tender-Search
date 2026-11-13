import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  extractTenderFromImage,
  summarizeTenderTextWithAI,
  extractTenderListFromHtmlWithAI,
  discoverTenderLinkWithAI,
  parseAndRepairTenderJson,
  CANDIDATE_MODELS,
  getAiClient
} from '../../src/server/services/ocrService.js';

const { mockGenerateContent, expectedOcr } = vi.hoisted(() => {
  const expected = {
    referenceNo: 'TND-2026-OCR',
    organization: 'Frontier Works Organization',
    title: 'Construction of Mountain Highway Bridges',
    closingDateISO: '2026-08-30T14:00:00+05:00',
    closingDateFormatted: '30-08-2026',
    estimatedValue: 'PKR 85,000,000',
    summaryScope: 'Engineering civil works',
    isCorrigendum: false
  };
  return {
    expectedOcr: expected,
    mockGenerateContent: vi.fn()
  };
});

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = {
        generateContent: mockGenerateContent
      };
    }
  };
});

describe('ocrService', () => {
  const originalEnv = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    mockGenerateContent.mockReset();
  });

  afterEach(() => {
    process.env.GEMINI_API_KEY = originalEnv;
    vi.restoreAllMocks();
  });

  describe('CANDIDATE_MODELS & Client Pooling', () => {
    it('defines a resilient multi-model failover chain with at least 3 models', () => {
      expect(CANDIDATE_MODELS.length).toBeGreaterThanOrEqual(3);
      expect(CANDIDATE_MODELS).toContain('gemini-flash-lite-latest');
      expect(CANDIDATE_MODELS).toContain('gemini-3.5-flash');
    });

    it('reuses cached GoogleGenAI client for the same API key', () => {
      const client1 = getAiClient('test-key-abc');
      const client2 = getAiClient('test-key-abc');
      expect(client1).toBe(client2);
    });
  });

  describe('parseAndRepairTenderJson', () => {
    it('returns null for null, empty or invalid strings', () => {
      expect(parseAndRepairTenderJson(null)).toBeNull();
      expect(parseAndRepairTenderJson('')).toBeNull();
      expect(parseAndRepairTenderJson('Not json at all')).toBeNull();
    });

    it('parses pure JSON correctly', () => {
      const jsonStr = JSON.stringify(expectedOcr);
      expect(parseAndRepairTenderJson(jsonStr)).toEqual(expectedOcr);
    });

    it('strips markdown code blocks: ```json ... ```', () => {
      const wrapped = '```json\n' + JSON.stringify(expectedOcr) + '\n```';
      expect(parseAndRepairTenderJson(wrapped)).toEqual(expectedOcr);
    });

    it('extracts JSON object when surrounded by conversational text', () => {
      const conversational = 'Here is the extracted tender:\n' + JSON.stringify(expectedOcr) + '\nHope this helps!';
      expect(parseAndRepairTenderJson(conversational)).toEqual(expectedOcr);
    });

    it('repairs trailing commas in JSON object', () => {
      const invalidWithTrailingComma = `{
        "referenceNo": "TND-2026-OCR",
        "organization": "Frontier Works Organization",
        "title": "Construction of Mountain Highway Bridges",
        "closingDateISO": "2026-08-30T14:00:00+05:00",
        "closingDateFormatted": "30-08-2026",
        "estimatedValue": "PKR 85,000,000",
        "summaryScope": "Engineering civil works",
        "isCorrigendum": false,
      }`;
      expect(parseAndRepairTenderJson(invalidWithTrailingComma)).toEqual(expectedOcr);
    });

    it('backfills missing fields with safe defaults', () => {
      const partial = `{"referenceNo": "REF-99"}`;
      const result = parseAndRepairTenderJson(partial, {
        title: 'Fallback Tender',
        organization: 'Fallback Dept'
      });
      expect(result).toEqual({
        referenceNo: 'REF-99',
        organization: 'Fallback Dept',
        title: 'Fallback Tender',
        closingDateISO: null,
        closingDateFormatted: 'Not Available',
        estimatedValue: null,
        summaryScope: '• Detailed scope is not stated in the notice.',
        isCorrigendum: false
      });
    });
  });

  describe('extractTenderFromImage', () => {
    it('returns null when GEMINI_API_KEY is not configured', async () => {
      const dummyBuffer = Buffer.from('fake image data');
      const result = await extractTenderFromImage(dummyBuffer);
      expect(result).toBeNull();
    });

    it('returns null when GEMINI_API_KEY is placeholder MY_GEMINI_API_KEY', async () => {
      process.env.GEMINI_API_KEY = 'MY_GEMINI_API_KEY';
      const dummyBuffer = Buffer.from('fake image data');
      const result = await extractTenderFromImage(dummyBuffer);
      expect(result).toBeNull();
    });

    it('returns null on empty buffer or buffer exceeding 20MB', async () => {
      process.env.GEMINI_API_KEY = 'valid-test-key';
      expect(await extractTenderFromImage(Buffer.alloc(0))).toBeNull();

      const oversized = { length: 25 * 1024 * 1024 } as unknown as Buffer;
      expect(await extractTenderFromImage(oversized)).toBeNull();
    });

    it('handles GoogleGenAI client execution and parses valid JSON response', async () => {
      process.env.GEMINI_API_KEY = 'valid-test-key';
      const dummyBuffer = Buffer.from('fake image data');

      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(expectedOcr)
      });

      const result = await extractTenderFromImage(dummyBuffer);
      expect(result).toEqual(expectedOcr);
    });

    it('falls back to secondary model when first model fails', async () => {
      process.env.GEMINI_API_KEY = 'valid-test-key';
      const dummyBuffer = Buffer.from('fake image data');

      mockGenerateContent
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({
          text: JSON.stringify(expectedOcr)
        });

      const result = await extractTenderFromImage(dummyBuffer);
      expect(result).toEqual(expectedOcr);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('returns null when GoogleGenAI returns empty or all models throw', async () => {
      process.env.GEMINI_API_KEY = 'valid-test-key';
      const dummyBuffer = Buffer.from('fake image data');

      mockGenerateContent.mockResolvedValue({ text: '' });
      expect(await extractTenderFromImage(dummyBuffer)).toBeNull();

      mockGenerateContent.mockReset();
      mockGenerateContent.mockRejectedValue(new Error('Quota exceeded'));
      expect(await extractTenderFromImage(dummyBuffer)).toBeNull();
    });
  });

  describe('summarizeTenderTextWithAI', () => {
    it('returns null if API key is not configured or text is empty', async () => {
      expect(await summarizeTenderTextWithAI({ title: 'Test', organization: 'Org', rawText: '' })).toBeNull();

      process.env.GEMINI_API_KEY = 'valid-test-key';
      expect(await summarizeTenderTextWithAI({ title: 'Test', organization: 'Org', rawText: '   ' })).toBeNull();
    });

    it('summarizes text and returns structured data', async () => {
      process.env.GEMINI_API_KEY = 'valid-test-key';

      mockGenerateContent.mockResolvedValueOnce({
        text: '```json\n' + JSON.stringify(expectedOcr) + '\n```'
      });

      const res = await summarizeTenderTextWithAI({
        title: 'Bridges',
        organization: 'FWO',
        rawText: 'Procurement of highway bridge construction.\x00\x08'
      });

      expect(res).toEqual(expectedOcr);
    });
  });

  describe('extractTenderListFromHtmlWithAI & discoverTenderLinkWithAI (Self-Healing AI)', () => {
    it('extracts structured tender array and resolves relative URLs', async () => {
      process.env.GEMINI_API_KEY = 'valid-test-key';

      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          items: [
            {
              referenceNo: 'TSE-2026-881',
              title: 'Supply and Installation of Solar Street Lights in Quetta',
              organization: 'BPPRA Urban Planning',
              directUrl: '/Tenders/Detail/881',
              publishDate: '2026-11-01',
              closingDate: '2026-11-25',
              estimatedValue: 'Rs. 45,000,000',
              description: 'Solar street lighting works',
              attachmentUrls: ['/Reports/NIT_881.pdf']
            },
            {
              title: 'Download' // Should be filtered out as generic short label
            }
          ]
        })
      });

      const items = await extractTenderListFromHtmlWithAI({
        compactedHtml: 'Balochistan Public Procurement Notice: Supply and Installation of Solar Street Lights in Quetta [NIT](/Reports/NIT_881.pdf)',
        portalName: 'Balochistan BPPRA',
        baseUrl: 'https://bpptwo.vdc.services:5451',
        tendersUrl: 'https://bpptwo.vdc.services:5451/Tenders'
      });

      expect(items.length).toBe(1);
      expect(items[0].referenceNo).toBe('TSE-2026-881');
      expect(items[0].title).toBe('Supply and Installation of Solar Street Lights in Quetta');
      expect(items[0].directUrl).toBe('https://bpptwo.vdc.services:5451/Tenders/Detail/881');
      expect(items[0].attachmentUrls).toEqual(['https://bpptwo.vdc.services:5451/Reports/NIT_881.pdf']);
    });

    it('discovers candidate tender URLs from navigation links via AI', async () => {
      process.env.GEMINI_API_KEY = 'valid-test-key';

      mockGenerateContent.mockResolvedValueOnce({
        text: '```json\n{"candidateUrls": ["https://bpptwo.vdc.services:5451/Tenders",]}\n```'
      });

      const urls = await discoverTenderLinkWithAI({
        links: [
          { text: 'About Us', href: 'https://bpptwo.vdc.services:5451/about' },
          { text: 'e-Procurement Portal Notices', href: 'https://bpptwo.vdc.services:5451/Tenders' }
        ],
        portalName: 'Balochistan BPPRA',
        baseUrl: 'https://bpptwo.vdc.services:5451'
      });

      expect(urls).toEqual(['https://bpptwo.vdc.services:5451/Tenders']);
    });
  });

  describe('Plan A: Structured BidBrief extraction', () => {
    it('parses and normalizes optional bidBrief while omitting empty bidBriefs', () => {
      const withBrief = parseAndRepairTenderJson(JSON.stringify({
        ...expectedOcr,
        bidBrief: {
          bidSecurityAmount: '2% CDR of estimated cost',
          tenderFee: 'PKR 5,000',
          requiredRegistrations: ['PEC C5', 'NTN/GST', ''],
          requiredExperience: '3 years school solarization projects',
          deliverablesSummary: ['10kW hybrid solar plant', '2-year O&M'],
          bidMethod: 'Single Stage - Two Envelope'
        }
      }));

      expect(withBrief?.bidBrief).toEqual({
        bidSecurityAmount: '2% CDR of estimated cost',
        tenderFee: 'PKR 5,000',
        requiredRegistrations: ['PEC C5', 'NTN/GST'],
        requiredExperience: '3 years school solarization projects',
        deliverablesSummary: ['10kW hybrid solar plant', '2-year O&M'],
        bidMethod: 'Single Stage - Two Envelope'
      });

      const withEmptyBrief = parseAndRepairTenderJson(JSON.stringify({
        ...expectedOcr,
        bidBrief: {
          bidSecurityAmount: null,
          tenderFee: '',
          requiredRegistrations: [],
          requiredExperience: null,
          deliverablesSummary: [],
          bidMethod: null
        }
      }));

      expect(withEmptyBrief).toEqual(expectedOcr);
      expect('bidBrief' in (withEmptyBrief || {})).toBe(false);
    });
  });
});
