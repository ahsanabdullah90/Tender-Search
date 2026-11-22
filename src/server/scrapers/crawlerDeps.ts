import { CachedDossier } from '../../shared/types.js';
import { fetchHtmlWithTolerantAgent, fetchHtmlWithMetadata, postFormWithMetadata, HtmlFetchResult } from './htmlFetcher.js';
import { sleep } from './baseScraper.js';
import { downloadAndCacheDossier, deriveDossierLabel, fetchFileBuffer, DownloadDossierOptions } from '../services/dossierManager.js';

export interface CrawlerPorts {
  fetchHtml: (url: string, retryCount?: number, cookieStr?: string) => Promise<string>;
  postForm: (url: string, formBody: string, cookieStr?: string, timeoutMs?: number) => Promise<HtmlFetchResult>;
  sleep: (ms: number) => Promise<void>;
  downloadAndCacheDossier: (
    tenderId: string,
    url: string,
    label?: string,
    options?: DownloadDossierOptions
  ) => Promise<CachedDossier | null>;
  fetchFileBuffer: (
    url: string,
    cookie?: string,
    options?: DownloadDossierOptions
  ) => Promise<Buffer>;
}

export const defaultCrawlerPorts: CrawlerPorts = {
  fetchHtml: fetchHtmlWithTolerantAgent,
  postForm: postFormWithMetadata,
  sleep: (ms: number) => sleep(ms),
  downloadAndCacheDossier: (tenderId: string, url: string, label?: string, options?: DownloadDossierOptions) =>
    downloadAndCacheDossier(tenderId, url, label || deriveDossierLabel(url, 'Tender Document'), undefined, undefined, options),
  fetchFileBuffer: (url: string, cookie?: string, options?: DownloadDossierOptions) =>
    fetchFileBuffer(url, cookie, 0, options)
};

let activePorts: CrawlerPorts = { ...defaultCrawlerPorts };

export function getCrawlerPorts(): Readonly<CrawlerPorts> {
  return { ...activePorts };
}

export function configureCrawlerPorts(overrides: Partial<CrawlerPorts>): () => void {
  const previous: CrawlerPorts = { ...activePorts };
  activePorts = {
    ...activePorts,
    ...(overrides.fetchHtml !== undefined ? { fetchHtml: overrides.fetchHtml } : {}),
    ...(overrides.postForm !== undefined ? { postForm: overrides.postForm } : {}),
    ...(overrides.sleep !== undefined ? { sleep: overrides.sleep } : {}),
    ...(overrides.downloadAndCacheDossier !== undefined
      ? { downloadAndCacheDossier: overrides.downloadAndCacheDossier }
      : {}),
    ...(overrides.fetchFileBuffer !== undefined ? { fetchFileBuffer: overrides.fetchFileBuffer } : {})
  };
  return () => {
    activePorts = previous;
  };
}

export function resetCrawlerPorts(): void {
  activePorts = { ...defaultCrawlerPorts };
}

export function isUsingRealFetchTransport(ports?: CrawlerPorts): boolean {
  return (ports ?? activePorts).fetchHtml === fetchHtmlWithTolerantAgent;
}

/**
 * Helper that fetches HTML and returns { html, finalUrl, cookies }.
 * Uses activePorts.fetchHtml when overridden in tests, or fetchHtmlWithMetadata in live production runs
 * so cross-origin 301/302 redirects (e.g. bppra.gob.pk -> bpptwo.vdc.services:5451) are accurately tracked.
 */
export async function fetchHtmlSmart(
  url: string,
  cookieStr?: string,
  timeoutMs?: number,
  ports: CrawlerPorts = activePorts
): Promise<HtmlFetchResult> {
  if (ports.fetchHtml !== fetchHtmlWithTolerantAgent) {
    const html = await ports.fetchHtml(url, 0, cookieStr);
    return { html, finalUrl: url, cookies: cookieStr };
  }
  return fetchHtmlWithMetadata(url, 0, cookieStr, false, true, timeoutMs);
}

/**
 * Submits an x-www-form-urlencoded POST (e.g. ASP.NET __doPostBack pagination).
 */
export async function postFormSmart(
  url: string,
  formBody: string,
  cookieStr?: string,
  timeoutMs?: number,
  ports: CrawlerPorts = activePorts
): Promise<HtmlFetchResult> {
  if (ports.postForm !== postFormWithMetadata) {
    return timeoutMs !== undefined
      ? ports.postForm(url, formBody, cookieStr, timeoutMs)
      : ports.postForm(url, formBody, cookieStr);
  }
  return postFormWithMetadata(url, formBody, cookieStr, timeoutMs);
}
