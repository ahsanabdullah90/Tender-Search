import { fetchHtmlWithTolerantAgent, fetchHtmlWithMetadata, postFormWithMetadata, HtmlFetchResult } from './htmlFetcher.js';
import { sleep } from './baseScraper.js';
import { downloadAndCacheDossier, deriveDossierLabel, fetchFileBuffer, DownloadDossierOptions } from '../services/dossierManager.js';

export const crawlerDeps = {
  fetchHtml: fetchHtmlWithTolerantAgent,
  postForm: postFormWithMetadata,
  sleep: (ms: number) => sleep(ms),
  downloadAndCacheDossier: (tenderId: string, url: string, label?: string, options?: DownloadDossierOptions) =>
    downloadAndCacheDossier(tenderId, url, label || deriveDossierLabel(url, 'Tender Document'), undefined, undefined, options),
  fetchFileBuffer: (url: string, cookie?: string, options?: DownloadDossierOptions) => fetchFileBuffer(url, cookie, 0, options),
  onScanFinished: null as (() => void) | null,
  onDocFetchChange: null as (() => void) | null
};

/**
 * Helper that fetches HTML and returns { html, finalUrl, cookies }.
 * Uses crawlerDeps.fetchHtml when mocked in tests, or fetchHtmlWithMetadata in live production runs
 * so cross-origin 301/302 redirects (e.g. bppra.gob.pk -> bpptwo.vdc.services:5451) are accurately tracked.
 */
export async function fetchHtmlSmart(url: string, cookieStr?: string, timeoutMs?: number): Promise<HtmlFetchResult> {
  if (crawlerDeps.fetchHtml !== fetchHtmlWithTolerantAgent) {
    const html = await crawlerDeps.fetchHtml(url, 0, cookieStr);
    return { html, finalUrl: url, cookies: cookieStr };
  }
  return fetchHtmlWithMetadata(url, 0, cookieStr, false, true, timeoutMs);
}

/**
 * Submits an x-www-form-urlencoded POST (e.g. ASP.NET __doPostBack pagination).
 */
export async function postFormSmart(url: string, formBody: string, cookieStr?: string, timeoutMs?: number): Promise<HtmlFetchResult> {
  if (crawlerDeps.postForm !== postFormWithMetadata) {
    return crawlerDeps.postForm(url, formBody, cookieStr);
  }
  return postFormWithMetadata(url, formBody, cookieStr, timeoutMs);
}
