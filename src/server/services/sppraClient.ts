import { maxFileBytes } from './ingestBudget.js';
import { reportNetworkOutcome, PASSIVE_SLOW_DOC_MS } from './networkMonitor.js';
import { createSslTolerantDispatcher } from '../domain/tlsTransport.js';

export const SPPRA_API_BASE = 'https://apiprd.eprocure.gov.pk';
export const SPPRA_LIST_URL = `${SPPRA_API_BASE}/websiteportal/publicportal/1.0.0/api/v1/publicportal/getallpublictenders`;
export const SPPRA_DOCS_URL = `${SPPRA_API_BASE}/websiteportal/publicportal/1.0.0/api/v1/publicportal/getallpublisheddocumentdetailbypdid`;
export const SPPRA_DOWNLOAD_URL = `${SPPRA_API_BASE}/documentmanagementsystem/dmspublicapi/1.0.0/api/v1/dmspublicapi/downloadportalfilebyguid`;
export const SPPRA_PORTAL_ORIGIN = 'https://portalsindh.eprocure.gov.pk';
export const SPPRA_OFFICE_ID = 31640;
export const SPPRA_MAX_ATTEMPTS = 6;
export const SPPRA_RETRY_DELAYS_MS = [100, 200, 400, 800, 1200] as const;

let sppraDispatcher = createSslTolerantDispatcher();

/**
 * Returns the active Undici dispatcher pool used by SPPRA API requests.
 */
export function getSppraDispatcher() {
  return sppraDispatcher;
}

function rotateSppraDispatcher(failedDispatcher: typeof sppraDispatcher): void {
  if (sppraDispatcher !== failedDispatcher) return;
  sppraDispatcher = createSslTolerantDispatcher();
  void failedDispatcher.close().catch(() => {});
}

export interface SppraRetryOptions {
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
}

function isRetryableSppraStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sleepWithAbort(ms: number, signal?: AbortSignal, abortMessage: string = 'Request aborted'): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error(abortMessage));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(abortMessage));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const SPPRA_PUBLIC_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  authorization: 'Basic YWRtaW46cHByYTEy',
  'content-type': 'application/json',
  officedetail: 'Sindh-PPRA-Dev',
  origin: SPPRA_PORTAL_ORIGIN,
  referer: `${SPPRA_PORTAL_ORIGIN}/`
};

export async function fetchSppraJson<T = any>(
  url: string,
  payload: Record<string, unknown>,
  formatHttpError: (status: number) => string,
  opts?: SppraRetryOptions & { timeoutMs?: number; signal?: AbortSignal; abortMessage?: string }
): Promise<T> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? SPPRA_MAX_ATTEMPTS);
  const retryDelays = opts?.retryDelaysMs ?? SPPRA_RETRY_DELAYS_MS;
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const abortMessage = opts?.abortMessage ?? 'Request aborted';

  if (opts?.signal?.aborted) {
    throw new Error(abortMessage);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts?.signal?.aborted) {
      throw new Error(abortMessage);
    }

    const attemptDispatcher = sppraDispatcher;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (opts?.signal) {
      opts.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: SPPRA_PUBLIC_HEADERS,
        signal: controller.signal,
        dispatcher: attemptDispatcher,
        body: JSON.stringify(payload)
      } as any);

      if (!res.ok) {
        // Drain error body so Undici recycles/closes the socket cleanly on transient WSO2 500s.
        if (typeof (res as any).text === 'function') {
          await (res as any).text().catch(() => '');
        }
        const err: any = new Error(formatHttpError(res.status));
        err.statusCode = res.status;
        lastError = err;

        if (!isRetryableSppraStatus(res.status) || attempt >= maxAttempts || opts?.signal?.aborted) {
          throw err;
        }
      } else {
        return (await res.json()) as T;
      }
    } catch (err: any) {
      if (opts?.signal?.aborted) {
        throw new Error(abortMessage);
      }
      if (typeof err?.statusCode === 'number' && !isRetryableSppraStatus(err.statusCode)) {
        throw err;
      }
      lastError = err;
      if (attempt >= maxAttempts) {
        throw err;
      }
    } finally {
      clearTimeout(timer);
      if (opts?.signal) {
        opts.signal.removeEventListener('abort', onParentAbort);
      }
    }

    rotateSppraDispatcher(attemptDispatcher);
    const delayIdx = Math.min(attempt - 1, Math.max(0, retryDelays.length - 1));
    const delayMs = retryDelays.length > 0 ? retryDelays[delayIdx] : 0;
    await sleepWithAbort(delayMs, opts?.signal, abortMessage);
  }

  throw lastError;
}

export interface SppraPublishedDocRecord {
  dmS_FileID?: number | null;
  dmS_FileGUID?: string | null;
  documentTemplateName?: string | null;
  displayName?: string | null;
  isCorrigendum?: number | boolean | null;
}

export interface SppraDownloadFileParams {
  fileId: number;
  guid: string;
  label?: string;
}

/**
 * Builds a synthetic HTTPS URL representing a Sindh SPPRA DMS file downloadable via
 * `downloadportalfilebyguid` POST API.
 */
export function buildSppraDownloadUrl(fileId: number, guid: string, label?: string): string {
  const url = new URL(SPPRA_DOWNLOAD_URL);
  url.searchParams.set('id', String(fileId));
  url.searchParams.set('guid', guid.trim());
  if (label && label.trim()) {
    url.searchParams.set('name', label.trim());
  }
  return url.toString();
}

/**
 * Parses a synthetic Sindh SPPRA DMS download URL back into `{ fileId, guid, label }`.
 */
export function parseSppraDownloadUrl(rawUrl: string): SppraDownloadFileParams | null {
  if (!rawUrl || !rawUrl.includes('downloadportalfilebyguid')) return null;
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.endsWith('eprocure.gov.pk')) return null;
    if (!parsed.pathname.toLowerCase().includes('downloadportalfilebyguid')) return null;
    const idStr = parsed.searchParams.get('id');
    const guid = parsed.searchParams.get('guid')?.trim();
    const label = parsed.searchParams.get('name')?.trim() || undefined;
    const fileId = idStr ? Number(idStr) : NaN;
    if (!Number.isFinite(fileId) || fileId <= 0 || !guid) return null;
    return { fileId, guid, label };
  } catch {
    return null;
  }
}

export function isSppraDownloadUrl(rawUrl: string): boolean {
  return parseSppraDownloadUrl(rawUrl) !== null;
}

/**
 * Extracts `publishedDocumentID` from a SPPRA tender `direct_url` (`.../#/?tender=...&pdid=717150`).
 */
export function extractSppraPublishedDocId(directUrl?: string | null): number | null {
  if (!directUrl) return null;
  const match = directUrl.match(/[?&]pdid=(\d+)/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Fetches PA Published Documents (Standard Bidding Document, Corrigenda, BOQ, etc.)
 * for a Sindh SPPRA tender by its `publishedDocumentID`.
 */
export async function fetchSppraPublishedDocuments(
  publishedDocumentId: number,
  timeoutMs: number = 15000,
  retryOptions?: SppraRetryOptions
): Promise<string[]> {
  if (!Number.isFinite(publishedDocumentId) || publishedDocumentId <= 0) return [];
  const json = await fetchSppraJson(
    SPPRA_DOCS_URL,
    {
      Id: publishedDocumentId,
      loggedInUserID: 1,
      loggedInUserOfficeID: 1
    },
    (status) => `SPPRA published docs HTTP ${status} for pdid=${publishedDocumentId}`,
    {
      timeoutMs,
      maxAttempts: retryOptions?.maxAttempts,
      retryDelaysMs: retryOptions?.retryDelaysMs
    }
  );
  const list: SppraPublishedDocRecord[] = Array.isArray(json?.data) ? json.data : [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const fileId = Number(item.dmS_FileID);
    const guid = (item.dmS_FileGUID || '').trim();
    if (!Number.isFinite(fileId) || fileId <= 0 || !guid) continue;
    const isCorr = item.isCorrigendum === 1 || item.isCorrigendum === true;
    const rawLabel = (item.displayName || item.documentTemplateName || '').trim();
    const label = isCorr
      ? (rawLabel && /corrigendum/i.test(rawLabel) ? rawLabel : 'Corrigendum')
      : (rawLabel || 'Standard Bidding Document');
    const u = buildSppraDownloadUrl(fileId, guid, label);
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

/**
 * Downloads a Sindh SPPRA DMS file via `downloadportalfilebyguid` POST API, decodes its
 * base64 payload into a raw `Buffer`, and attaches `contentType` and `contentDisposition`
 * metadata compatible with `dossierManager` and `tenderAnalysis`.
 */
export async function downloadSppraFileBuffer(
  rawUrl: string,
  options?: {
    signal?: AbortSignal;
    maxBytes?: number;
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelaysMs?: readonly number[];
  }
): Promise<Buffer> {
  const params = parseSppraDownloadUrl(rawUrl);
  if (!params) {
    throw new Error(`Invalid SPPRA download URL: ${rawUrl}`);
  }
  if (options?.signal?.aborted) {
    throw new Error('File download aborted');
  }

  const timeoutMs = options?.timeoutMs ?? 45000;
  const limitBytes = options?.maxBytes ?? maxFileBytes();
  const startedAt = Date.now();

  const json = await fetchSppraJson(
    SPPRA_DOWNLOAD_URL,
    {
      loggedInUserOfficeID: SPPRA_OFFICE_ID,
      loggedInUserID: 1,
      ID: params.fileId,
      idsList: params.guid
    },
    (status) => `SPPRA file download HTTP ${status}`,
    {
      timeoutMs,
      signal: options?.signal,
      maxAttempts: options?.maxAttempts,
      retryDelaysMs: options?.retryDelaysMs,
      abortMessage: 'File download aborted'
    }
  );

  const base64Bytes = json?.data?.bytes;
  if (typeof base64Bytes !== 'string' || base64Bytes.length < 16) {
    throw new Error(`SPPRA DMS returned empty file payload for file ID ${params.fileId}`);
  }

  const buf = Buffer.from(base64Bytes, 'base64');
  if (buf.length > limitBytes) {
    throw new Error(`File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  reportNetworkOutcome('apiprd.eprocure.gov.pk', true, {
    durationMs: Date.now() - startedAt,
    slowThresholdMs: PASSIVE_SLOW_DOC_MS
  });

  const contentType = (json?.data?.contentType || 'application/pdf').trim();
  const fileName = (json?.data?.fileName || '').trim();
  (buf as any).contentType = contentType;
  if (fileName) {
    (buf as any).contentDisposition = `attachment; filename="${fileName.replace(/"/g, '')}"`;
  }
  return buf;
}
