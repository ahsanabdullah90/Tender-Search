import { RawScrapedItem, ScrapeResult } from './parserHelpers.js';
import { PortalDefinition } from '../domain/portalList.js';
import { parseDateString, formatClosingDate } from '../domain/dateParser.js';
import {
  SPPRA_LIST_URL,
  SPPRA_PORTAL_ORIGIN,
  SPPRA_OFFICE_ID,
  type SppraRetryOptions,
  fetchSppraJson,
  buildSppraDownloadUrl
} from '../services/sppraClient.js';
import {
  CLOSED_STATUS_RE,
  resolvePaginationMaxPages,
  shouldEarlyStopKnownPage,
  KnownTenderStopEntry
} from './scraperUtils.js';

export {
  SPPRA_API_BASE,
  SPPRA_LIST_URL,
  SPPRA_DOCS_URL,
  SPPRA_DOWNLOAD_URL,
  SPPRA_PORTAL_ORIGIN,
  SPPRA_OFFICE_ID,
  SPPRA_MAX_ATTEMPTS,
  SPPRA_RETRY_DELAYS_MS,
  SPPRA_PUBLIC_HEADERS,
  getSppraDispatcher,
  buildSppraDownloadUrl,
  parseSppraDownloadUrl,
  isSppraDownloadUrl,
  extractSppraPublishedDocId,
  fetchSppraPublishedDocuments,
  downloadSppraFileBuffer
} from '../services/sppraClient.js';
export type {
  SppraRetryOptions,
  SppraPublishedDocRecord,
  SppraDownloadFileParams
} from '../services/sppraClient.js';

export const SPPRA_DEFAULT_PAGE_SIZE = 50;

export interface SppraTenderRecord {
  publishedDocumentID?: number;
  tR_DocumentTemplateID?: number;
  procurementPlansDetailID?: number;
  name?: string | null;
  description?: string | null;
  documentId?: number | null;
  documentGUID?: string | null;
  ppraTenderNumber?: string | null;
  tenderNumber?: string | null;
  tenderNumbers?: string | null;
  publishDate?: string | null;
  lastSubmissionDate?: string | null;
  bidOpeningDate?: string | null;
  bidValidityDate?: string | null;
  departmentName?: string | null;
  statusName?: string | null;
  location?: string | null;
  procurementCategory?: string | null;
  estimatedCost?: string | number | null;
  procurementMethod?: string | null;
  procurementProcedure?: string | null;
}

function parseSppraIsoDate(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (!s || s.startsWith('0001-01-01')) return undefined;
  // SPPRA returns local Pakistan Standard Time (UTC+05:00) timestamps without timezone suffix
  return parseDateString(s) ?? undefined;
}

function formatEstimatedCostPkr(raw?: string | number | null): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const num = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(num) || num <= 0) return undefined;
  if (num >= 1_000_000) {
    const m = (num / 1_000_000).toFixed(2).replace(/\.00$/, '');
    return `PKR ${m}M (${num.toLocaleString('en-US')})`;
  }
  return `PKR ${num.toLocaleString('en-US')}`;
}

/**
 * Maps a single raw SPPRA EPADS JSON record into a normalized `ScrapedTender`.
 * Returns `null` for non-open (closed/cancelled/completed) or malformed records.
 */
export function mapSppraRecordToScrapedTender(record: SppraTenderRecord): RawScrapedItem | null {
  const title = (record.name || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length < 4) return null;

  const statusName = (record.statusName || '').trim();
  if (statusName && CLOSED_STATUS_RE.test(statusName)) {
    return null;
  }

  const referenceNo = (record.tenderNumbers || record.tenderNumber || record.ppraTenderNumber || '').trim() || undefined;
  const organization = (record.departmentName || '').replace(/\s+/g, ' ').trim() || 'Sindh Public Procurement Regulatory Authority';

  const rawLocation = (record.location || '').replace(/\s+/g, ' ').trim();
  const location = rawLocation
    ? (/sindh/i.test(rawLocation) ? rawLocation : `${rawLocation}, Sindh`)
    : 'Sindh, Pakistan';

  const publishDate = parseSppraIsoDate(record.publishDate);
  const closingDate = parseSppraIsoDate(record.lastSubmissionDate);

  const pdid = Number(record.publishedDocumentID);
  const queryParts: string[] = [];
  if (referenceNo) queryParts.push(`tender=${encodeURIComponent(referenceNo)}`);
  if (Number.isFinite(pdid) && pdid > 0) queryParts.push(`pdid=${pdid}`);
  const directUrl = queryParts.length > 0
    ? `${SPPRA_PORTAL_ORIGIN}/#/?${queryParts.join('&')}`
    : `${SPPRA_PORTAL_ORIGIN}/#/`;

  const attachmentUrls: string[] = [];
  if (record.documentId && Number(record.documentId) > 0 && record.documentGUID && String(record.documentGUID).trim()) {
    attachmentUrls.push(
      buildSppraDownloadUrl(Number(record.documentId), String(record.documentGUID).trim(), 'Tender Notice')
    );
  }

  const descParts: string[] = [];
  if (record.description && record.description.trim()) {
    descParts.push(record.description.trim());
  } else {
    descParts.push(title);
  }
  const metaParts: string[] = [];
  if (referenceNo) metaParts.push(`Ref: ${referenceNo}`);
  if (organization) metaParts.push(`Department: ${organization}`);
  if (rawLocation) metaParts.push(`Location: ${location}`);
  const costLabel = formatEstimatedCostPkr(record.estimatedCost);
  if (costLabel) metaParts.push(`Estimated Cost: ${costLabel}`);
  if (closingDate) metaParts.push(`Closing: ${formatClosingDate(closingDate) || closingDate}`);
  if (record.procurementMethod) metaParts.push(`Method: ${record.procurementMethod}`);
  if (record.procurementProcedure) metaParts.push(`Procedure: ${record.procurementProcedure}`);

  const description = metaParts.length > 0
    ? `${descParts.join(' — ')} | ${metaParts.join(' • ')}`
    : descParts.join(' — ');

  return {
    title,
    organization,
    referenceNo,
    publishDate,
    closingDate,
    location,
    directUrl,
    description,
    attachmentUrls: attachmentUrls.length > 0 ? attachmentUrls : undefined
  };
}

/**
 * Fetches one page of active public tenders from the Sindh SPPRA EPADS JSON API.
 */
export async function fetchSppraTendersPage(
  pageNumber: number = 1,
  pageSize: number = SPPRA_DEFAULT_PAGE_SIZE,
  timeoutMs: number = 20000,
  retryOptions?: SppraRetryOptions
): Promise<{ totalRecords: number; records: SppraTenderRecord[] }> {
  const json = await fetchSppraJson(
    SPPRA_LIST_URL,
    {
      pagination: {
        pageNumber: String(pageNumber),
        pageSize: String(pageSize),
        orderBy: '',
        orderByColumnName: '',
        approvalStatusID: 0,
        refTypeID: 0
      },
      filter: {
        sortOrder: '',
        activityStatus: null,
        keywords: '',
        tenderNo: '',
        departmentName: null,
        dateOfAdvertisement: null,
        closingDate: null,
        selectedWorth: null
      },
      loggedInUserID: 1,
      loggedInUserOfficeID: SPPRA_OFFICE_ID
    },
    (status) => `SPPRA API HTTP ${status} on page ${pageNumber}`,
    {
      timeoutMs,
      maxAttempts: retryOptions?.maxAttempts,
      retryDelaysMs: retryOptions?.retryDelaysMs
    }
  );
  const records: SppraTenderRecord[] = Array.isArray(json?.data?.records) ? json.data.records : [];
  const totalRecords = Number(json?.data?.totalRecords ?? records.length) || records.length;
  return { totalRecords, records };
}

/**
 * Scrapes Sindh SPPRA via its official public EPADS JSON API with quick/deep pagination
 * and DB early-stop when page >= 2 repeats already-known unchanged notices.
 */
export async function scrapeSppraPortal(
  portal: PortalDefinition,
  options?: {
    depth?: 'quick' | 'deep';
    knownMap?: Map<string, KnownTenderStopEntry> | null;
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelaysMs?: readonly number[];
  }
): Promise<ScrapeResult> {
  const depth = options?.depth === 'deep' ? 'deep' : 'quick';
  const maxPages = resolvePaginationMaxPages(portal, depth, 2);

  const allItems: RawScrapedItem[] = [];
  const seenKeys = new Set<string>();
  let pagesScanned = 0;

  for (let page = 1; page <= maxPages; page++) {
    let records: SppraTenderRecord[];
    try {
      const pageData = await fetchSppraTendersPage(page, SPPRA_DEFAULT_PAGE_SIZE, options?.timeoutMs ?? 20000, {
        maxAttempts: options?.maxAttempts,
        retryDelaysMs: options?.retryDelaysMs
      });
      records = pageData.records;
    } catch (err: any) {
      if (pagesScanned > 0) {
        console.warn(`[SPPRA] Stopping pagination on page ${page} after collecting ${allItems.length} item(s): ${err?.message || err}`);
        break;
      }
      throw err;
    }
    pagesScanned++;
    if (records.length === 0) break;

    const pageItems: RawScrapedItem[] = [];

    for (const rec of records) {
      const mapped = mapSppraRecordToScrapedTender(rec);
      if (!mapped) continue;
      const key = (mapped.referenceNo || mapped.directUrl || mapped.title).toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      allItems.push(mapped);
      pageItems.push(mapped);
    }

    if (pageItems.length === 0) break;
    if (page >= 2 && shouldEarlyStopKnownPage(pageItems, options?.knownMap)) {
      break;
    }
    if (records.length < SPPRA_DEFAULT_PAGE_SIZE) break;
  }

  return {
    items: allItems,
    hitlRequired: false,
    pagesScanned
  };
}
