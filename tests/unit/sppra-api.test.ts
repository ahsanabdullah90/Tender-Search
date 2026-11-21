import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSppraDownloadUrl,
  parseSppraDownloadUrl,
  isSppraDownloadUrl,
  extractSppraPublishedDocId,
  mapSppraRecordToScrapedTender,
  scrapeSppraPortal,
  fetchSppraPublishedDocuments,
  downloadSppraFileBuffer,
  SPPRA_DOWNLOAD_URL
} from '../../src/server/scrapers/sppraApi.js';
import { deriveDossierLabel } from '../../src/server/services/dossierManager.js';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import { db, initDatabase, getAllTenders, setAppSetting } from '../../src/server/db/index.js';
import { processAndSaveTender, fetchDocumentsForTender, crawlerDeps } from '../../src/server/scrapers/crawlerEngine.js';

describe('Sindh SPPRA EPADS API module', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('builds and parses synthetic SPPRA DMS download URLs and labels', () => {
    const url = buildSppraDownloadUrl(8970327, 'f940bd9f-9738-453d-9c1d-45a9a0938215', 'Standard Bidding Document');
    expect(isSppraDownloadUrl(url)).toBe(true);
    expect(parseSppraDownloadUrl(url)).toEqual({
      fileId: 8970327,
      guid: 'f940bd9f-9738-453d-9c1d-45a9a0938215',
      label: 'Standard Bidding Document'
    });
    expect(deriveDossierLabel(url)).toBe('Standard Bidding Document');
    expect(isSppraDownloadUrl('https://example.com/file.pdf')).toBe(false);
    expect(parseSppraDownloadUrl(`${SPPRA_DOWNLOAD_URL}?id=0&guid=abc`)).toBeNull();
  });

  it('extracts publishedDocumentID (pdid) from SPPRA direct_url', () => {
    expect(extractSppraPublishedDocId('https://portalsindh.eprocure.gov.pk/#/?tender=EPADS-S-26110847166&pdid=717150')).toBe(717150);
    expect(extractSppraPublishedDocId('https://portalsindh.eprocure.gov.pk/#/')).toBeNull();
    expect(extractSppraPublishedDocId(null)).toBeNull();
  });

  it('maps active SPPRA JSON records and skips closed/cancelled ones', () => {
    const active = mapSppraRecordToScrapedTender({
      publishedDocumentID: 717150,
      name: 'Design, Supply & Installation of 250KW Solar Energy System at ICCBS',
      tenderNumbers: 'EPADS-S-26110847166',
      departmentName: 'ICCBS University of Karachi',
      statusName: 'In-Progress',
      location: 'Karachi west',
      publishDate: '2026-11-20T17:55:11.523',
      lastSubmissionDate: '2026-12-22T11:30:00',
      estimatedCost: '33500000',
      documentId: 768090,
      documentGUID: 'a84f62fc-4fb6-4e8e-887c-fcbae3871d39'
    });

    expect(active).not.toBeNull();
    expect(active!.referenceNo).toBe('EPADS-S-26110847166');
    expect(active!.organization).toBe('ICCBS University of Karachi');
    expect(active!.location).toBe('Karachi west, Sindh');
    expect(active!.directUrl).toBe('https://portalsindh.eprocure.gov.pk/#/?tender=EPADS-S-26110847166&pdid=717150');
    expect(active!.closingDate).toBe('2026-12-22T06:30:00.000Z');
    expect(active!.description).toContain('PKR 33.50M');
    expect(active!.attachmentUrls).toHaveLength(1);
    expect(isSppraDownloadUrl(active!.attachmentUrls![0])).toBe(true);

    expect(
      mapSppraRecordToScrapedTender({
        publishedDocumentID: 1,
        name: 'Cancelled Road Works Tender',
        statusName: 'Cancelled'
      })
    ).toBeNull();
    expect(
      mapSppraRecordToScrapedTender({
        publishedDocumentID: 2,
        name: 'Completed Building Tender',
        statusName: 'Completed'
      })
    ).toBeNull();
  });

  it('paginates scrapeSppraPortal and stops early on known unchanged quick-scan pages', async () => {
    const spPortal = PORTAL_DEFINITIONS.find(p => p.id === 'sppra')!;
    const makeRec = (n: number) => ({
      publishedDocumentID: 700000 + n,
      name: `Sindh Solarization Tender Package ${n}`,
      tenderNumbers: `EPADS-S-2611000${n}`,
      departmentName: 'Sindh Energy Dept',
      statusName: 'In-Progress',
      location: 'Hyderabad',
      lastSubmissionDate: '2026-12-25T11:00:00'
    });

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const page = Number(body.pagination.pageNumber);
      const records = Array.from({ length: 50 }, (_, i) => makeRec((page - 1) * 50 + i + 1));
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { totalRecords: 500, records }, success: true })
      };
    });
    global.fetch = fetchMock as any;

    // Known map marks all page-2 items as already known & unchanged -> should stop after page 2
    const knownMap = new Map<string, { closing_date?: string | null; title?: string | null }>();
    for (let n = 51; n <= 100; n++) {
      knownMap.set(`https://portalsindh.eprocure.gov.pk/#/?tender=EPADS-S-2611000${n}&pdid=${700000 + n}`.toLowerCase(), {
        closing_date: '2026-12-25T06:00:00.000Z',
        title: `Sindh Solarization Tender Package ${n}`
      });
    }

    const res = await scrapeSppraPortal(
      { ...spPortal, pagination: { kind: 'api', maxPages: 4, quickMaxPages: 4, deepMaxPages: 6 } },
      { depth: 'quick', knownMap }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.pagesScanned).toBe(2);
    expect(res.items).toHaveLength(100);
  });

  it('fetches PA Published Documents and labels corrigenda accurately', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            dmS_FileID: 8970327,
            dmS_FileGUID: 'guid-sbd-1',
            documentTemplateName: 'Standard Bidding Document',
            isCorrigendum: 0
          },
          {
            dmS_FileID: 8970328,
            dmS_FileGUID: 'guid-corr-2',
            documentTemplateName: 'Addendum',
            isCorrigendum: 1
          }
        ]
      })
    }) as any;

    const urls = await fetchSppraPublishedDocuments(717150);
    expect(urls).toHaveLength(2);
    expect(parseSppraDownloadUrl(urls[0])?.label).toBe('Standard Bidding Document');
    expect(parseSppraDownloadUrl(urls[1])?.label).toBe('Corrigendum');
  });

  it('downloads and base64-decodes SPPRA DMS PDF buffers with headers and enforces size limits', async () => {
    const samplePdf = Buffer.from('%PDF-1.6\nSindh SPPRA Sample Bidding Document\n%%EOF', 'utf8');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          fileName: 'CED 145 Doc.pdf',
          contentType: 'application/pdf',
          bytes: samplePdf.toString('base64')
        }
      })
    }) as any;

    const url = buildSppraDownloadUrl(8970327, 'guid-1', 'Standard Bidding Document');
    const buf = await downloadSppraFileBuffer(url);
    expect(buf.toString('utf8')).toContain('%PDF-1.6');
    expect((buf as any).contentType).toBe('application/pdf');
    expect((buf as any).contentDisposition).toBe('attachment; filename="CED 145 Doc.pdf"');

    await expect(downloadSppraFileBuffer(url, { maxBytes: 10 })).rejects.toThrow(/File too large/);
  });

  it('discovers PA Published Documents via pdid inside fetchDocumentsForTender without calling fetchHtml', async () => {
    initDatabase();
    for (const t of ['document_ingest_jobs', 'corrigendum_logs', 'pipeline_audit_logs', 'tenders', 'deleted_tenders']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
    setAppSetting('gemini_api_key', '');

    const spPortal = PORTAL_DEFINITIONS.find(p => p.id === 'sppra')!;
    const nitUrl = buildSppraDownloadUrl(768090, 'guid-nit', 'Tender Notice');
    const sbdUrl = buildSppraDownloadUrl(8970327, 'guid-sbd', 'Standard Bidding Document');

    const origDownload = crawlerDeps.downloadAndCacheDossier;
    crawlerDeps.downloadAndCacheDossier = vi.fn().mockResolvedValue(null);
    const fetchHtmlSpy = vi.spyOn(crawlerDeps, 'fetchHtml');
    const fetchBufSpy = vi.spyOn(crawlerDeps, 'fetchFileBuffer').mockImplementation(async (u: string) => {
      const b = Buffer.from(`%PDF-1.4 synthetic SPPRA PDF for ${u}`);
      (b as any).contentType = 'application/pdf';
      return b;
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            dmS_FileID: 8970327,
            dmS_FileGUID: 'guid-sbd',
            documentTemplateName: 'Standard Bidding Document',
            isCorrigendum: 0
          }
        ]
      })
    }) as any;

    try {
      await processAndSaveTender(
        {
          title: 'Design and Installation of 250KW Solar Energy System at ICCBS',
          organization: 'ICCBS University of Karachi',
          referenceNo: 'EPADS-S-26110847166',
          location: 'Karachi west, Sindh',
          closingDate: '2026-12-22T06:30:00.000Z',
          directUrl: 'https://portalsindh.eprocure.gov.pk/#/?tender=EPADS-S-26110847166&pdid=717150',
          attachmentUrls: [nitUrl]
        },
        spPortal,
        [
          {
            id: 'track-solar',
            name: 'Solarization',
            positive_keywords: ['solar'],
            negative_keywords: [],
            is_active: 1
          }
        ]
      );

      const saved = getAllTenders()[0];
      expect(saved).toBeDefined();

      const res = await fetchDocumentsForTender(saved.id);
      expect(fetchHtmlSpy).not.toHaveBeenCalled();
      expect(res.newlyFetched).toBe(2);
      expect(res.dossiers.map(d => d.originalUrl)).toEqual([nitUrl, sbdUrl]);
    } finally {
      crawlerDeps.downloadAndCacheDossier = origDownload;
      fetchHtmlSpy.mockRestore();
      fetchBufSpy.mockRestore();
    }
  });
});
