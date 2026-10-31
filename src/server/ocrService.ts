import { GoogleGenAI } from '@google/genai';

export interface OcrExtractedData {
  referenceNo: string | null;
  organization: string;
  title: string;
  closingDateISO: string | null;
  closingDateFormatted: string;
  estimatedValue: string | null;
  summaryScope: string;
  isCorrigendum: boolean;
}

/**
 * Extracts structured tender information from a scanned newspaper clipping or notice image buffer
 */
export async function extractTenderFromImage(imageBuffer: Buffer, mimeType: string = 'image/jpeg'): Promise<OcrExtractedData | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || !apiKey.trim()) {
    return null;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const base64Data = imageBuffer.toString('base64');

    const prompt = `You are a procurement data extraction specialist for Pakistan government tender notices.
Analyze this scanned newspaper clipping or gazette announcement image.
Extract the official tender details into strict JSON matching the schema.

Important guidelines for Pakistan tenders:
- Organizations are often federal/provincial departments (e.g., FDE, PPRA, C&W, WAPDA, NHA, Education Dept).
- Look carefully for submission/closing deadlines (e.g., "bids must reach by 15-11-2026 at 11:00 AM" or "within 15 days of publication").
- If the deadline date is not explicitly mentioned, return "Not Available" for closingDateFormatted and null for closingDateISO.
- Check if this is an "Extension Notice", "Corrigendum", "Addendum", or "Amendment". Set isCorrigendum: true if so.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: base64Data,
                mimeType
              }
            }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            referenceNo: { type: 'string', nullable: true },
            organization: { type: 'string' },
            title: { type: 'string' },
            closingDateISO: { type: 'string', nullable: true },
            closingDateFormatted: { type: 'string' },
            estimatedValue: { type: 'string', nullable: true },
            summaryScope: { type: 'string' },
            isCorrigendum: { type: 'boolean' }
          },
          required: ['organization', 'title', 'closingDateFormatted', 'summaryScope', 'isCorrigendum']
        }
      }
    });

    if (!response.text) return null;
    return JSON.parse(response.text) as OcrExtractedData;
  } catch (err) {
    console.warn('Gemini Vision OCR extraction encountered an error:', err);
    return null;
  }
}
