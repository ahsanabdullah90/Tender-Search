import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractTenderFromImage } from '../../src/server/ocrService.js';

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

  it('returns null when GoogleGenAI returns empty or throws error', async () => {
    process.env.GEMINI_API_KEY = 'valid-test-key';
    const dummyBuffer = Buffer.from('fake image data');

    mockGenerateContent.mockResolvedValueOnce({ text: '' });
    expect(await extractTenderFromImage(dummyBuffer)).toBeNull();

    mockGenerateContent.mockRejectedValueOnce(new Error('Quota exceeded'));
    expect(await extractTenderFromImage(dummyBuffer)).toBeNull();
  });
});
