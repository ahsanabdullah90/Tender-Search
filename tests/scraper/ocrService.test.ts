import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractTenderFromImage, summarizeTenderTextWithAI } from '../../src/server/ocrService.js';

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
        text: JSON.stringify(expectedOcr)
      });

      const res = await summarizeTenderTextWithAI({
        title: 'Bridges',
        organization: 'FWO',
        rawText: 'Procurement of highway bridge construction.'
      });

      expect(res).toEqual(expectedOcr);
    });
  });
});
