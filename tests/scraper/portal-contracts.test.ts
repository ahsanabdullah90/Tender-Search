import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, initDatabase, getAllTenders, setAppSetting } from '../../src/server/db/index.js';
import { parsePortalHtml, processAndSaveTender, crawlerDeps, orderDocumentCandidates, fetchDocumentsForTender, hasEmptyTenderTableState } from '../../src/server/scrapers/crawlerEngine.js';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import { getPortalFileCode } from '../../src/server/services/dossierStore.js';

/**
 * Portal contract tests (docs/13-ingestion-pipeline-plan.md, §4.2). Every fixture captured by
 * scripts/capture-portal-fixture.ts is parsed and pushed through the full ingest pipeline with the
 * clock frozen to its capture date, asserting:
 *   1. the parser still finds what it found at capture time (expected.json),
 *   2. every item has a title and an absolute link, and at most 5 document candidates,
 *   3. no tender with a past deadline survives ingest unless flagged for review,
 *   4. documents get the portal's canonical file code.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'portals');

interface Expected {
  portalId: string;
  capturedAt: string;
  items: number;
  rawItems?: number;
  hitlRequired: boolean;
  withClosingDate: number;
  withAttachments: number;
}

const captured = fs.readdirSync(FIXTURES)
  .filter(d => fs.existsSync(path.join(FIXTURES, d, 'expected.json')))
  .map(d => ({
    dir: d,
    html: fs.readFileSync(path.join(FIXTURES, d, 'page.html'), 'utf8'),
    expected: JSON.parse(fs.readFileSync(path.join(FIXTURES, d, 'expected.json'), 'utf8')) as Expected
  }));

const synthetic = ['punjab_eproc', 'sppra', 'tender_services'].filter(d => fs.existsSync(path.join(FIXTURES, d, 'page.html')));

/** Portals with no fixture, and why. */
const NOT_COVERED: Record<string, string> = {
  kppra: 'offline_broken: the portal is unreachable',
  gilgit: 'offline_broken: the portal is unreachable',
  ungm: 'JavaScript-rendered: needs the Playwright tier, not plain HTTP'
};

describe('Portal contract tests', () => {
  const originalDownload = crawlerDeps.downloadAndCacheDossier;

  beforeEach(() => {
    initDatabase();
    for (const t of ['document_ingest_jobs', 'corrigendum_logs', 'pipeline_audit_logs', 'tenders', 'deleted_tenders']) db.prepare(`DELETE FROM ${t}`).run();
    setAppSetting('gemini_api_key', '');
    // No network: every document download "fails", so documents are queued, never fetched.
    crawlerDeps.downloadAndCacheDossier = vi.fn().mockResolvedValue(null);
  });

  afterEach(() => {
    crawlerDeps.downloadAndCacheDossier = originalDownload;
    vi.useRealTimers();
  });

  it('accounts for all 18 portals: a fixture, a synthetic fixture, or a stated reason', () => {
    const covered = new Set([...captured.map(c => c.dir), ...synthetic, ...Object.keys(NOT_COVERED)]);
    const missing = PORTAL_DEFINITIONS.map(p => p.id).filter(id => !covered.has(id));
    expect(missing).toEqual([]);
    expect(PORTAL_DEFINITIONS).toHaveLength(18);
  });

  for (const { dir, html, expected } of captured) {
    const portal = PORTAL_DEFINITIONS.find(p => p.id === dir)!;

    if (expected.rawItems === 0) {
      it(`${dir}: known parser gap: the live page yields no tenders over HTTP (captured ${expected.capturedAt})`, () => {
        // Documents the gap so it is visible in the test run; fix the parser, re-capture, and this becomes a full contract.
        expect(parsePortalHtml(html, portal).items).toHaveLength(0);
      });
      continue;
    }

    describe(`${dir} (captured ${expected.capturedAt})`, () => {
      it('parser still finds the captured listings, each with a title and absolute link', () => {
        const result = parsePortalHtml(html, portal);
        expect(result.hitlRequired).toBe(expected.hitlRequired);
        expect(result.items).toHaveLength(expected.items);
        expect(result.items.filter(i => i.closingDate)).toHaveLength(expected.withClosingDate);
        for (const item of result.items) {
          expect(item.title.trim().length, `title in ${dir}`).toBeGreaterThan(0);
          expect(item.directUrl, `link in ${dir}`).toMatch(/^https?:\/\//);
          expect(orderDocumentCandidates(item).length).toBeLessThanOrEqual(5);
        }
        expect(getPortalFileCode(portal.id)).toMatch(/^[A-Z0-9]{2,6}$/);
      });

      it('no tender with a past deadline survives ingest (clock frozen to capture date)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(`${expected.capturedAt}T12:00:00+05:00`));
        const items = parsePortalHtml(html, portal).items;
        const catchAll = [{
          id: 'track-all',
          name: 'All',
          positive_keywords: Array.from(new Set(items.map(i => i.title.toLowerCase().slice(0, 20)))),
          negative_keywords: [],
          is_active: 1
        }];
        for (const item of items) await processAndSaveTender({ ...item }, portal, catchAll);

        const now = Date.now();
        const saved = getAllTenders();
        expect(saved.length).toBeLessThanOrEqual(items.length);
        const leaked = saved.filter(t => t.closing_date && new Date(t.closing_date).getTime() < now && !t.needs_review);
        expect(leaked.map(t => `${t.title} (${t.closing_date})`)).toEqual([]);
        // Items the portal gave no publish date never get "today" invented for them
        // (only NULL, or an upload-folder month-end, which is never the 12th).
        const today = new Date(now).toISOString().slice(0, 10);
        const undatedTitles = new Set(items.filter(i => !i.publishDate).map(i => i.title));
        for (const t of saved.filter(s => undatedTitles.has(s.title))) {
          expect(t.publish_date, `${t.title} publish_date`).not.toBe(today);
        }
      });
    });
  }

  for (const dir of synthetic) {
    it(`${dir}: synthetic fixture parses without error`, () => {
      const portal = PORTAL_DEFINITIONS.find(p => p.id === dir)!;
      const result = parsePortalHtml(fs.readFileSync(path.join(FIXTURES, dir, 'page.html'), 'utf8'), portal);
      expect(result.items.length > 0 || result.hitlRequired).toBe(true);
    });
  }

  it('keeps every portal HTML fixture at or below the 50 KB size cap (P3-3)', () => {
    const allDirs = fs.readdirSync(FIXTURES).filter(d => fs.existsSync(path.join(FIXTURES, d, 'page.html')));
    for (const d of allDirs) {
      const size = fs.statSync(path.join(FIXTURES, d, 'page.html')).size;
      expect(size, `${d}/page.html size`).toBeLessThanOrEqual(50 * 1024);
    }
  });

  it('recognizes PSDA "No Opening" page as a valid empty tender table state (P1-2)', () => {
    const psdaHtml = fs.readFileSync(path.join(FIXTURES, 'psda', 'page.html'), 'utf8');
    expect(hasEmptyTenderTableState(psdaHtml)).toBe(true);
  });

  it('discovers ?wpdmdl= attachments from an FDE detail page fixture (P3-5)', async () => {
    const fdePortal = PORTAL_DEFINITIONS.find(p => p.id === 'fde')!;
    const fdeListingHtml = fs.readFileSync(path.join(FIXTURES, 'fde', 'page.html'), 'utf8');
    const detailHtml = fs.readFileSync(path.join(FIXTURES, 'fde_detail', 'page.html'), 'utf8');
    const firstItem = parsePortalHtml(fdeListingHtml, fdePortal).items[0];
    expect(firstItem).toBeDefined();

    const catchAll = [{
      id: 'track-fde',
      name: 'Education',
      positive_keywords: [firstItem.title.toLowerCase().slice(0, 15)],
      negative_keywords: [],
      is_active: 1
    }];
    await processAndSaveTender({ ...firstItem, closingDate: '2026-12-15T09:00:00.000Z' }, fdePortal, catchAll);
    const saved = getAllTenders()[0];
    expect(saved).toBeDefined();

    const fetchHtmlSpy = vi.spyOn(crawlerDeps, 'fetchHtml').mockResolvedValue(detailHtml);
    const fetchBufSpy = vi.spyOn(crawlerDeps, 'fetchFileBuffer').mockImplementation(async (url: string) =>
      Buffer.from(`%PDF-1.4 synthetic FDE attachment from ${url}`)
    );
    try {
      const res = await fetchDocumentsForTender(saved.id);
      expect(fetchHtmlSpy).toHaveBeenCalledWith(saved.direct_url);
      expect(fetchBufSpy).toHaveBeenCalledTimes(2);
      expect(res.newlyFetched).toBe(2);
      expect(res.dossiers.map(d => d.originalUrl)).toEqual([
        'https://fde.gov.pk/download/printing-and-supply-of-textbooks/?wpdmdl=13892&refresh=6730a1b2c3d4e',
        'https://fde.gov.pk/download/printing-and-supply-of-textbooks/?wpdmdl=13893'
      ]);
    } finally {
      fetchHtmlSpy.mockRestore();
      fetchBufSpy.mockRestore();
    }
  });
});
