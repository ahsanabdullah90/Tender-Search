import { GoogleGenAI } from '@google/genai';
import { getGeminiApiKey } from './db.js';

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

const TENDER_JSON_SCHEMA = {
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
};

/**
 * Validated production models ordered by latency, availability, and capability.
 * Live benchmark verified:
 * 1. gemini-flash-lite-latest (fastest response ~2.0s)
 * 2. gemini-3.1-flash-lite (fast secondary lite ~2.6s)
 * 3. gemini-3.5-flash (high quality multimodal ~3.9s)
 * 4. gemini-3.8-flash (comprehensive reasoning fallback)
 */
export const CANDIDATE_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash'
];

let cachedClient: { key: string; client: GoogleGenAI } | null = null;

export function getAiClient(apiKey: string): GoogleGenAI {
  if (cachedClient && cachedClient.key === apiKey) {
    return cachedClient.client;
  }
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 45000,
      retryOptions: {
        attempts: 1
      }
    }
  });
  cachedClient = { key: apiKey, client };
  return client;
}

/**
 * Resilient JSON parsing and self-healing for model responses:
 * - Strips markdown code blocks (```json ... ```)
 * - Extracts outermost { ... } objects from conversational responses
 * - Repairs trailing commas before closing braces
 * - Enforces typed fallback guarantees for all fields
 */
export function parseAndRepairTenderJson(
  raw: string | null | undefined,
  defaults?: { title?: string; organization?: string }
): OcrExtractedData | null {
  if (!raw || typeof raw !== 'string') return null;

  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    try {
      const repaired = cleaned.replace(/,\s*([}\]])/g, '$1');
      parsed = JSON.parse(repaired);
    } catch (err) {
      console.warn('[Gemini] JSON parsing failed after repair attempt:', err);
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  return {
    referenceNo: parsed.referenceNo ? String(parsed.referenceNo).trim() : null,
    organization: parsed.organization ? String(parsed.organization).trim() : (defaults?.organization || 'Not Specified'),
    title: parsed.title ? String(parsed.title).trim() : (defaults?.title || 'Tender Notice'),
    closingDateISO: parsed.closingDateISO ? String(parsed.closingDateISO).trim() : null,
    closingDateFormatted: parsed.closingDateFormatted ? String(parsed.closingDateFormatted).trim() : 'Not Available',
    estimatedValue: parsed.estimatedValue ? String(parsed.estimatedValue).trim() : null,
    summaryScope: parsed.summaryScope ? String(parsed.summaryScope).trim() : '• Detailed scope is not stated in the notice.',
    isCorrigendum: Boolean(parsed.isCorrigendum)
  };
}

async function generateWithFallback(
  ai: GoogleGenAI,
  params: Omit<Parameters<GoogleGenAI['models']['generateContent']>[0], 'model'>
): Promise<string | null> {
  let lastErr: unknown = null;
  for (const model of CANDIDATE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        ...params,
        model
      });
      if (response?.text && response.text.trim()) {
        return response.text;
      }
    } catch (err: any) {
      lastErr = err;
      console.warn(`[Gemini] Model ${model} generation attempt failed:`, err?.message || err);
      // Brief pause before trying fallback model if rate-limited or experiencing high demand
      if (model !== CANDIDATE_MODELS[CANDIDATE_MODELS.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  }
  if (lastErr) {
    console.warn('[Gemini] All candidate models exhausted:', lastErr);
  }
  return null;
}

/**
 * Extracts structured tender information from a scanned newspaper clipping, notice image, or PDF buffer
 */
export async function extractTenderFromImage(imageBuffer: Buffer, mimeType: string = 'image/jpeg'): Promise<OcrExtractedData | null> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return null;
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    return null;
  }

  // Pre-flight payload size safety (20MB limit)
  if (imageBuffer.length > 20 * 1024 * 1024) {
    console.warn('[Gemini] Document buffer exceeds 20MB limit for OCR parsing');
    return null;
  }

  try {
    const ai = getAiClient(apiKey);
    const base64Data = imageBuffer.toString('base64');

    const prompt = `You are a procurement data extraction specialist for Pakistan government and multilateral tender notices.
Analyze this tender notice image or PDF document and extract the official tender details into strict JSON matching the schema.

Important guidelines:
- Organizations are often federal/provincial departments (e.g., FDE, PPRA, NDMA, PSDF, PEEF, Ignite, PSEB, UNGM, GIZ).
- Look carefully for submission/closing deadlines (e.g., "bids must reach by 15-11-2026 at 11:00 AM") and convert to ISO 8601 with +05:00 PKT offset when possible.
- If the deadline date is not explicitly mentioned, return "Not Available" for closingDateFormatted and null for closingDateISO.
- For summaryScope, write a clean, scannable "First Look" brief (2 to 4 bullet points using "• ") covering:
  • Scope of work / items or services being procured
  • Eligibility criteria (PEC category, experience, tax/NTN, turnover) if stated
  • Bid security / earnest money / tender fee and submission method if stated
  If any of these details are not present in the document, explicitly mention that they are not stated in the notice.
- Check if this is an "Extension Notice", "Corrigendum", "Addendum", or "Amendment". Set isCorrigendum: true if so.`;

    const rawText = await generateWithFallback(ai, {
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
        responseSchema: TENDER_JSON_SCHEMA
      }
    });

    if (!rawText) return null;
    return parseAndRepairTenderJson(rawText);
  } catch (err) {
    console.warn('Gemini Vision/Document extraction encountered an error:', err);
    return null;
  }
}

/**
 * Summarizes raw portal detail-page text or pasted tender text into a structured First-Look brief using Gemini
 */
export async function summarizeTenderTextWithAI(params: {
  title: string;
  organization: string;
  rawText: string;
}): Promise<OcrExtractedData | null> {
  const apiKey = getGeminiApiKey();
  if (!apiKey || !params.rawText || !params.rawText.trim()) {
    return null;
  }

  // Pre-process and sanitize raw portal text: strip unprintable control characters and limit length
  const cleanText = params.rawText
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
    .slice(0, 15000);

  if (!cleanText) {
    return null;
  }

  try {
    const ai = getAiClient(apiKey);
    const prompt = `You are a procurement specialist analyzing a tender listing from Pakistan.
Title: ${params.title}
Organization: ${params.organization}
Raw Page / Notice Text:
${cleanText}

Extract the official tender details into strict JSON matching the schema:
- For summaryScope, write a clean, high-signal "First Look" summary (2 to 4 bullet points using "• ") explaining:
  • What is being procured (core scope, quantities, or objectives)
  • Eligibility / qualification requirements (if mentioned)
  • Bid security / earnest money / submission instructions (if mentioned)
  Do NOT repeat raw table headers or navigation menu text. If the raw text only contains a title and dates with no detailed scope, state: "• Detailed scope and eligibility criteria are not stated in the portal listing text; please refer to the attached bidding document or portal page."`;

    const rawText = await generateWithFallback(ai, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: TENDER_JSON_SCHEMA
      }
    });

    if (!rawText) return null;
    return parseAndRepairTenderJson(rawText, {
      title: params.title,
      organization: params.organization
    });
  } catch (err) {
    console.warn('Gemini text summarization encountered an error:', err);
    return null;
  }
}

export interface AiScrapedTenderItem {
  referenceNo?: string;
  title: string;
  organization: string;
  directUrl: string;
  publishDate?: string;
  closingDate?: string | null;
  estimatedValue?: string;
  description?: string;
  attachmentUrls?: string[];
}

const TENDER_LIST_JSON_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          referenceNo: { type: 'string', nullable: true },
          title: { type: 'string' },
          organization: { type: 'string' },
          directUrl: { type: 'string', nullable: true },
          publishDate: { type: 'string', nullable: true },
          closingDate: { type: 'string', nullable: true },
          estimatedValue: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
          attachmentUrls: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['title']
      }
    }
  },
  required: ['items']
};

/**
 * Self-Healing Phase 2: Adaptive AI HTML Layout Extractor.
 * When a portal redesigns its HTML or uses custom components that bypass standard CSS selectors,
 * extracts structured tender listings from link-annotated compacted text.
 */
export async function extractTenderListFromHtmlWithAI(params: {
  compactedHtml: string;
  portalName: string;
  baseUrl: string;
  tendersUrl: string;
}): Promise<AiScrapedTenderItem[]> {
  const apiKey = getGeminiApiKey();
  if (!apiKey || !params.compactedHtml || params.compactedHtml.trim().length < 40) {
    return [];
  }

  const cleanDigest = params.compactedHtml
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
    .slice(0, 25000);

  try {
    const ai = getAiClient(apiKey);
    const prompt = `You are a self-healing procurement web scraper for ${params.portalName} (${params.baseUrl}).
Analyze the following compacted webpage content from ${params.tendersUrl} (where links appear as [Label](URL)) and extract all genuine tender, RFP, RFQ, NIT, or procurement notices into strict JSON matching the schema.

Rules:
- Only extract actual procurement/tender notices. Do NOT extract navigation menus, footer links, dropdown options, search form values, "About Us", "Rules & Regulations", or general news.
- If the page contains no active tender listings, return {"items": []}.
- For each tender:
  - title: The clean descriptive title of the tender (must be > 5 chars, not a generic label like "Download" or "Click Here").
  - referenceNo: Tender number / TSE / PID / RFP code if present, else null.
  - organization: Procuring agency or department if stated, else "${params.portalName}".
  - directUrl: Best URL for the tender detail or primary document. If no dedicated detail page exists, use the document/attachment URL.
  - publishDate / closingDate: Normalize to YYYY-MM-DD if possible, else null.
  - attachmentUrls: Array of any PDF/DOC/image URLs associated with that tender.

Page Content:
${cleanDigest}`;

    const rawText = await generateWithFallback(ai, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: TENDER_LIST_JSON_SCHEMA
      }
    });

    if (!rawText) return [];

    let cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      try {
        parsed = JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        return [];
      }
    }

    if (!parsed || !Array.isArray(parsed.items)) return [];

    const validItems: AiScrapedTenderItem[] = [];
    for (const rawItem of parsed.items) {
      if (!rawItem || typeof rawItem.title !== 'string') continue;
      const title = rawItem.title.replace(/\s+/g, ' ').trim();
      if (title.length <= 5 || /^(download|view|details|tenders?|home|contact|login|click here)$/i.test(title)) {
        continue;
      }

      const resolveUrl = (u: unknown, fallback: string): string => {
        if (!u || typeof u !== 'string') return fallback;
        try {
          return u.startsWith('http') ? u : new URL(u, params.baseUrl).toString();
        } catch {
          return fallback;
        }
      };

      let directUrl = resolveUrl(rawItem.directUrl, params.tendersUrl);
      const attachmentUrls = Array.isArray(rawItem.attachmentUrls)
        ? rawItem.attachmentUrls
            .filter((u: unknown) => typeof u === 'string' && u.trim().length > 0)
            .map((u: string) => resolveUrl(u, ''))
            .filter(Boolean)
        : [];

      // If directUrl is generic portal root/tendersUrl, promote the first attachmentUrl to directUrl
      const normDirect = directUrl.replace(/\/+$/, '');
      const normTenders = params.tendersUrl.replace(/\/+$/, '');
      const normBase = params.baseUrl.replace(/\/+$/, '');
      if ((normDirect === normTenders || normDirect === normBase) && attachmentUrls.length > 0) {
        directUrl = attachmentUrls[0];
      }

      // Reject false-positive category routes, search results, or newspaper aggregators
      if (
        /\/(category|tag|searchresults?|search|login)(\/|$)/i.test(directUrl) ||
        /^(all newspapers|newspapers?|canteen|all categories)$/i.test(title)
      ) {
        continue;
      }

      // An item without a specific URL and without dates is likely a form dropdown or nav label
      const hasSpecificLink = normDirect !== normTenders && normDirect !== normBase;
      const hasValidDate = Boolean(rawItem.publishDate || rawItem.closingDate);
      if (!hasSpecificLink && !hasValidDate) {
        continue;
      }

      validItems.push({
        referenceNo: rawItem.referenceNo ? String(rawItem.referenceNo).trim() : undefined,
        title,
        organization: rawItem.organization ? String(rawItem.organization).trim() : params.portalName,
        directUrl,
        publishDate: rawItem.publishDate ? String(rawItem.publishDate).trim() : undefined,
        closingDate: rawItem.closingDate ? String(rawItem.closingDate).trim() : null,
        estimatedValue: rawItem.estimatedValue ? String(rawItem.estimatedValue).trim() : undefined,
        description: rawItem.description ? String(rawItem.description).trim() : '',
        attachmentUrls
      });
    }

    return validItems;
  } catch (err) {
    console.warn('[Gemini] Adaptive HTML tender list extraction failed:', err);
    return [];
  }
}

/**
 * Self-Healing Phase 3 (Step 3B): AI Navigation Link Discovery Fallback.
 * Given candidate links from an organization's homepage, selects up to 2 most likely tender portal URLs.
 */
export async function discoverTenderLinkWithAI(params: {
  links: Array<{ text: string; href: string }>;
  portalName: string;
  baseUrl: string;
}): Promise<string[]> {
  const apiKey = getGeminiApiKey();
  if (!apiKey || !params.links || params.links.length === 0) {
    return [];
  }

  try {
    const ai = getAiClient(apiKey);
    const linkListText = params.links
      .slice(0, 80)
      .map((l, idx) => `${idx + 1}. "${l.text}" -> ${l.href}`)
      .join('\n');

    const prompt = `You are a web navigation agent locating the official Tenders / Procurement / RFPs listing page for "${params.portalName}" (${params.baseUrl}).
Review the following navigation links extracted from the organization's homepage and return up to 2 URLs most likely to contain active tender notices or procurement listings.
Do NOT select login pages, rules/regulations, archive/awarded pages, or social media links.

Links:
${linkListText}`;

    const rawText = await generateWithFallback(ai, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            candidateUrls: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['candidateUrls']
        }
      }
    });

    if (!rawText) return [];
    let cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1'));
    if (!parsed || !Array.isArray(parsed.candidateUrls)) return [];

    return parsed.candidateUrls
      .filter((u: unknown) => typeof u === 'string' && u.trim().length > 0)
      .slice(0, 2);
  } catch {
    return [];
  }
}
