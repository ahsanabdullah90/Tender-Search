import { RawScrapedItem, ScrapeResult, isNonBidEvaluationOrPlanTitle } from './portalParsers.js';
import { PortalDefinition } from './portalList.js';
import { parseDateString, formatClosingDate } from './dateParser.js';
import { isValidReferenceNo } from '../services/referenceNo.js';
import { reportNetworkOutcome, PASSIVE_SLOW_HTML_MS } from '../services/networkMonitor.js';

export const KP_API_BASE = 'https://mgn1.kp.gov.pk';
export const KP_TENDERS_API_URL = `${KP_API_BASE}/api/tenders`;
export const KP_PORTAL_ORIGIN = 'https://kp.gov.pk';
export const KP_DEFAULT_PAGE_SIZE = 12;

export const KP_API_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  origin: KP_PORTAL_ORIGIN,
  referer: `${KP_PORTAL_ORIGIN}/tenders`
};

export interface KpMediaFile {
  file_path?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  extension?: string | null;
  kind?: string | null;
}

export interface KpCorrigendumRecord {
  corrigendum_description?: string | null;
  corrigendum_close_date?: string | null;
  corrigendum_created?: string | null;
  corrigendum_document?: string | null;
}

export interface KpCompanyInfo {
  web_site?: string | null;
  domain?: string | null;
  domain_prefix?: string | null;
  external_url?: string | null;
  url?: string | null;
  title?: string | null;
}

export interface KpTenderRecord {
  uuid?: string | null;
  tender_number?: string | null;
  title?: string | null;
  description?: string | null;
  reference?: string | null;
  status?: string | null;
  tender_type?: string | null;
  date_of_advertisement_formatted?: string | null;
  closing_date_formatted?: string | null;
  date_of_advertisement?: string | null;
  closing_date?: string | null;
  created_at?: string | null;
  department_name?: string | null;
  company?: KpCompanyInfo | null;
  media?: KpMediaFile | null;
  bidding_document?: KpMediaFile | null;
  corrigendum?: string | boolean | null;
  corrigenda?: KpCorrigendumRecord[] | null;
}

const CLOSED_STATUS_RE = /\b(closed|cancelled|canceled|completed|awarded|archived|expired|dropped)\b/i;

const KP_LOCATION_PATTERNS: Array<[RegExp, string]> = [
  // Multi-word and abbreviated districts/towns first
  [/\b(?:d\.?\s*i\.?\s*khan|dera\s+ismail\s+khan)\b/i, 'Dera Ismail Khan'],
  [/\b(?:lower\s+dir|dir\s+lower)\b/i, 'Lower Dir'],
  [/\b(?:upper\s+dir|dir\s+upper)\b/i, 'Upper Dir'],
  [/\b(?:lower\s+chitral|chitral\s+lower)\b/i, 'Lower Chitral'],
  [/\b(?:upper\s+chitral|chitral\s+upper)\b/i, 'Upper Chitral'],
  [/\b(?:lower\s+kohistan|kohistan\s+lower)\b/i, 'Lower Kohistan'],
  [/\b(?:upper\s+kohistan|kohistan\s+upper)\b/i, 'Upper Kohistan'],
  [/\bkolai[\s-]+pallas\b/i, 'Kolai-Pallas'],
  [/\bnorth\s+waziristan\b/i, 'North Waziristan'],
  [/\bsouth\s+waziristan\b/i, 'South Waziristan'],
  [/\blakki\s+marwat\b/i, 'Lakki Marwat'],
  [/\blandi\s+kotal\b/i, 'Landi Kotal'],
  [/\btakht\s+bhai\b/i, 'Takht Bhai'],
  [/\btor\s*ghar\b/i, 'Torghar'],
  [/\bbatta?gram\b/i, 'Battagram'],
  [/\bnowsheh?ra\b/i, 'Nowshera'],
  // Single-word KP districts & major cities
  [/\bpeshawar\b/i, 'Peshawar'],
  [/\bmardan\b/i, 'Mardan'],
  [/\babbottabad\b/i, 'Abbottabad'],
  [/\bswat\b/i, 'Swat'],
  [/\bmingora\b/i, 'Mingora'],
  [/\bkohat\b/i, 'Kohat'],
  [/\bbannu\b/i, 'Bannu'],
  [/\bcharsadda\b/i, 'Charsadda'],
  [/\bswabi\b/i, 'Swabi'],
  [/\bmansehra\b/i, 'Mansehra'],
  [/\bharipur\b/i, 'Haripur'],
  [/\bmalakand\b/i, 'Malakand'],
  [/\bbuner\b/i, 'Buner'],
  [/\bshangla\b/i, 'Shangla'],
  [/\bchitral\b/i, 'Chitral'],
  [/\bdir\b/i, 'Dir'],
  [/\bhangu\b/i, 'Hangu'],
  [/\bkarak\b/i, 'Karak'],
  [/(?<!water\s|storage\s|septic\s|fuel\s|oil\s|overhead\s|underground\s|rcc\s|steel\s)\btank\b/i, 'Tank'],
  [/\bkhyber\b(?!\s+pakhtunkhwa)/i, 'Khyber'],
  [/\bmohmand\b/i, 'Mohmand'],
  [/\bbajaur\b/i, 'Bajaur'],
  [/\bkurram\b/i, 'Kurram'],
  [/\borakzai\b/i, 'Orakzai'],
  [/\bkohistan\b/i, 'Kohistan'],
  [/\btimergara\b/i, 'Timergara'],
  [/\bparachinar\b/i, 'Parachinar'],
  [/\bmiranshah\b/i, 'Miranshah'],
  [/\bwana\b/i, 'Wana'],
  [/\brisalpur\b/i, 'Risalpur'],
  [/\btopi\b/i, 'Topi'],
  [/\bhavelian\b/i, 'Havelian'],
  [/\bbalakot\b/i, 'Balakot'],
  [/\bbara\b/i, 'Bara'],
  [/\bjamrud\b/i, 'Jamrud'],
  [/\btangi\b/i, 'Tangi'],
  [/\bshabqadar\b/i, 'Shabqadar'],
  [/\bpabbi\b/i, 'Pabbi'],
  [/\bghalanai\b/i, 'Ghalanai'],
  [/\bkhar\b/i, 'Khar']
];

/**
 * Extracts a canonical Khyber Pakhtunkhwa district/city location from department text (or title fallback).
 */
export function extractKpLocation(deptText: string, title?: string): string {
  const candidates = title ? [deptText, title] : [deptText];
  for (const source of candidates) {
    if (!source) continue;
    for (const [pattern, city] of KP_LOCATION_PATTERNS) {
      if (pattern.test(source)) {
        return `${city}, Khyber Pakhtunkhwa`;
      }
    }
  }
  return 'Khyber Pakhtunkhwa, Pakistan';
}

function resolveKpFileUrl(raw?: string | null): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  try {
    const resolved = /^https?:\/\//i.test(trimmed)
      ? new URL(trimmed)
      : new URL(trimmed.startsWith('/') ? trimmed : `/${trimmed}`, KP_API_BASE);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Maps a single raw KP Tenders API record into a normalized `RawScrapedItem`.
 * Returns `null` for closed/cancelled, auction/disposal, or non-bid records.
 */
export function mapKpRecordToScrapedTender(record: KpTenderRecord): RawScrapedItem | null {
  const title = (record.title || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length < 4) return null;

  const status = (record.status || '').trim();
  if (status && CLOSED_STATUS_RE.test(status)) {
    return null;
  }

  if (isNonBidEvaluationOrPlanTitle(title)) {
    return null;
  }

  const tenderType = (record.tender_type || '').replace(/\s+/g, ' ').trim();
  const isAuctionOrDisposal =
    /\b(?:auction|disposal|sales?)\b/i.test(tenderType) ||
    /^(?:auction|disposal|sale)\b|\b(?:open\s+auction|public\s+auction|auction\s+(?:notice|of\b)|auction\s+of\s+toll\s+tax|toll\s+tax\s+auction|sale\s+of\s+(?:scrap|condemned|unserviceable|obsolete|vehicles|trees|fruit)|disposal\s+of\s+(?:scrap|condemned|unserviceable|obsolete|old|surplus|assets))\b/i.test(title);
  if (isAuctionOrDisposal) {
    return null;
  }

  const uuid = (record.uuid || '').trim();
  const directUrl = uuid
    ? `${KP_PORTAL_ORIGIN}/tender/detail/${encodeURIComponent(uuid)}`
    : `${KP_PORTAL_ORIGIN}/tenders`;

  const rawRef = (record.tender_number || '').replace(/\s+/g, ' ').trim();
  const rawRefSource = (record.reference || '').replace(/\s+/g, ' ').trim();
  let referenceNo: string | undefined;
  if (rawRef) {
    if (isValidReferenceNo(rawRef)) {
      referenceNo = rawRef;
    } else if (/^\d+$/.test(rawRef) && rawRefSource.toLowerCase() === 'kppra') {
      referenceNo = `KPPRA-${rawRef}`;
    }
  }

  const rawDept = (record.department_name || '').replace(/\s+/g, ' ').trim();
  const rawCompanyTitle = (record.company?.title || '').replace(/\s+/g, ' ').trim();
  const isGenericDept = !rawDept || /^khyber\s+pakhtunkhwa(?:\s+portal)?$/i.test(rawDept);
  const isGenericCompany = !rawCompanyTitle || /^khyber\s+pakhtunkhwa(?:\s+portal)?$/i.test(rawCompanyTitle);
  const organization = !isGenericDept
    ? rawDept
    : (!isGenericCompany ? rawCompanyTitle : 'Khyber Pakhtunkhwa Procurement (KPPRA)');

  const publishDate = parseDateString((record.date_of_advertisement_formatted || record.date_of_advertisement || '').trim()) || undefined;
  let closingDate: string | null = parseDateString((record.closing_date_formatted || record.closing_date || '').trim());

  const attachmentUrls: string[] = [];
  const addAttachment = (candidate?: string | null) => {
    const resolved = resolveKpFileUrl(candidate);
    if (resolved && !attachmentUrls.includes(resolved)) {
      attachmentUrls.push(resolved);
    }
  };

  addAttachment(record.media?.file_path);
  addAttachment(record.bidding_document?.file_path);

  const corrigenda = Array.isArray(record.corrigenda) ? record.corrigenda : [];
  const isCorrigendum =
    record.corrigendum === true ||
    /^(?:yes|true|1)$/i.test(String(record.corrigendum || '').trim()) ||
    corrigenda.length > 0;

  const corrNotes: string[] = [];
  for (const corr of corrigenda) {
    if (!corr) continue;
    addAttachment(corr.corrigendum_document);
    if (corr.corrigendum_description && corr.corrigendum_description.trim()) {
      corrNotes.push(corr.corrigendum_description.replace(/\s+/g, ' ').trim());
    }
    if (corr.corrigendum_close_date && corr.corrigendum_close_date.trim()) {
      const parsedCorrClose = parseDateString(corr.corrigendum_close_date.trim());
      if (parsedCorrClose) {
        if (!closingDate || new Date(parsedCorrClose).getTime() > new Date(closingDate).getTime()) {
          closingDate = parsedCorrClose;
        }
      }
    }
  }

  const location = extractKpLocation(organization, title);
  const sourceLabel = rawRefSource.toLowerCase() === 'kppra' ? 'KPPRA' : 'KP Portal';
  const baseDesc = record.description && record.description.trim()
    ? record.description.replace(/\s+/g, ' ').trim()
    : title;

  const metaParts: string[] = [`Source: ${sourceLabel}`];
  if (referenceNo) metaParts.push(`Ref: ${referenceNo}`);
  if (tenderType) metaParts.push(`Type: ${tenderType}`);
  if (organization) metaParts.push(`Department: ${organization}`);
  if (location) metaParts.push(`Location: ${location}`);
  if (closingDate) metaParts.push(`Closing: ${formatClosingDate(closingDate) || closingDate}`);
  if (corrNotes.length > 0) metaParts.push(`Corrigendum: ${corrNotes.join('; ')}`);

  const description = `${baseDesc} | ${metaParts.join(' • ')}`;

  return {
    referenceNo,
    title,
    organization,
    location,
    directUrl,
    publishDate,
    closingDate,
    description,
    isCorrigendum: isCorrigendum || undefined,
    attachmentUrls: attachmentUrls.length > 0 ? attachmentUrls : undefined
  };
}

/**
 * Fetches one page of active tenders from the official KP Government / KPPRA public REST API.
 */
export async function fetchKpTendersPage(
  pageNumber: number = 1,
  timeoutMs: number = 20000
): Promise<{
  records: KpTenderRecord[];
  currentPage: number;
  lastPage: number;
  total: number;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const url = `${KP_TENDERS_API_URL}?domain=&page=${encodeURIComponent(String(pageNumber))}&search=`;
    const res = await fetch(url, {
      method: 'GET',
      headers: KP_API_HEADERS,
      signal: controller.signal
    });

    if (!res.ok) {
      const err: any = new Error(`KP API HTTP ${res.status} on page ${pageNumber}`);
      err.statusCode = res.status;
      throw err;
    }

    reportNetworkOutcome('mgn1.kp.gov.pk', true, {
      durationMs: Date.now() - startedAt,
      slowThresholdMs: PASSIVE_SLOW_HTML_MS
    });

    const json: any = await res.json();
    const records: KpTenderRecord[] = Array.isArray(json?.data)
      ? json.data
      : (Array.isArray(json?.data?.data) ? json.data.data : []);
    const meta = json?.meta || {};
    const currentPage = Number(meta.current_page ?? pageNumber) || pageNumber;
    const lastPage = Number(meta.last_page ?? currentPage) || currentPage;
    const total = Number(meta.total ?? records.length) || records.length;
    return { records, currentPage, lastPage, total };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrapes Khyber Pakhtunkhwa KPPRA & KP Portal via its official public REST API with
 * quick/deep pagination and DB early-stop when page >= 2 repeats unchanged notices.
 */
export async function scrapeKpPortal(
  portal: PortalDefinition,
  options?: {
    depth?: 'quick' | 'deep';
    knownMap?: Map<string, { closing_date?: string | null; has_corrigendum?: number; title?: string | null }> | null;
    timeoutMs?: number;
  }
): Promise<ScrapeResult> {
  const depth = options?.depth === 'deep' ? 'deep' : 'quick';
  const maxPages = portal.pagination
    ? (depth === 'deep'
        ? (portal.pagination.deepMaxPages ?? 15)
        : (portal.pagination.quickMaxPages ?? 8))
    : 8;

  const allItems: RawScrapedItem[] = [];
  const seenKeys = new Set<string>();
  let pagesScanned = 0;

  for (let page = 1; page <= maxPages; page++) {
    const { records, lastPage } = await fetchKpTendersPage(page, options?.timeoutMs ?? 20000);
    pagesScanned++;
    if (records.length === 0) break;

    let addedOnPage = 0;
    let knownUnchanged = 0;

    for (const rec of records) {
      const mapped = mapKpRecordToScrapedTender(rec);
      if (!mapped) continue;
      const key = (mapped.directUrl || mapped.referenceNo || mapped.title).toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      if (page >= 2 && options?.knownMap && mapped.directUrl) {
        const existing = options.knownMap.get(mapped.directUrl.toLowerCase());
        const normalizeDay = (val?: string | null) => {
          if (!val) return '';
          const trimmed = val.trim();
          if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
          const parsed = parseDateString(trimmed);
          return parsed ? parsed.slice(0, 10) : trimmed.toLowerCase();
        };
        const mappedClosingDay = normalizeDay(mapped.closingDate);
        const existingClosingDay = normalizeDay(existing?.closing_date);
        const hasNewCorrigendum = Boolean(mapped.isCorrigendum && !existing?.has_corrigendum);
        if (existing && !hasNewCorrigendum && existingClosingDay === mappedClosingDay) {
          knownUnchanged++;
        }
      }

      allItems.push(mapped);
      addedOnPage++;
    }

    if (page >= 2 && options?.knownMap && addedOnPage > 0 && knownUnchanged / addedOnPage >= 0.85) {
      break;
    }
    if (page >= lastPage) break;
  }

  return {
    items: allItems,
    hitlRequired: false,
    pagesScanned
  };
}
