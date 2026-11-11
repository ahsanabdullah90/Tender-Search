import { fetchHtmlWithTolerantAgent, fetchHtmlWithMetadata } from './htmlFetcher.js';
import { sleep } from './baseScraper.js';
import { downloadAndCacheDossier, deriveDossierLabel, fetchFileBuffer, DownloadDossierOptions } from '../dossierManager.js';

export const crawlerDeps = {
  fetchHtml: fetchHtmlWithTolerantAgent,
  sleep: (ms: number) => sleep(ms),
  downloadAndCacheDossier: (tenderId: string, url: string, label?: string, options?: DownloadDossierOptions) =>
    downloadAndCacheDossier(tenderId, url, label || deriveDossierLabel(url, 'Tender Document'), undefined, undefined, options),
  fetchFileBuffer: (url: string, cookie?: string, options?: DownloadDossierOptions) => fetchFileBuffer(url, cookie, 0, options)
};

/**
 * Helper that fetches HTML and returns { html, finalUrl }.
 * Uses crawlerDeps.fetchHtml when mocked in tests, or fetchHtmlWithMetadata in live production runs
 * so cross-origin 301/302 redirects (e.g. bppra.gob.pk -> bpptwo.vdc.services:5451) are accurately tracked.
 */
export async function fetchHtmlSmart(url: string, cookieStr?: string): Promise<{ html: string; finalUrl: string }> {
  if (crawlerDeps.fetchHtml !== fetchHtmlWithTolerantAgent) {
    const html = await crawlerDeps.fetchHtml(url, 0, cookieStr);
    return { html, finalUrl: url };
  }
  return fetchHtmlWithMetadata(url, 0, cookieStr);
}
