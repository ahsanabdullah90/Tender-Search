import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSppraDownloadUrl,
  parseSppraDownloadUrl,
  isSppraDownloadUrl,
  extractSppraPublishedDocId,
  mapSppraRecordToScrapedTender,
  fetchSppraTendersPage,
  scrapeSppraPortal,
  fetchSppraPublishedDocuments,
  downloadSppraFileBuffer,
  getSppraDispatcher,
  SPPRA_LIST_URL,
  SPPRA_DOCS_URL,
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

  it('passes active TLS-tolerant dispatcher across list, published docs, and DMS download calls', async () => {
    const samplePdf = Buffer.from('%PDF-1.6\nSPPRA TLS Dispatcher Test\n%%EOF', 'utf8');
    const expectedDispatcher = getSppraDispatcher();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === SPPRA_LIST_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { totalRecords: 0, records: [] } })
        };
      }
      if (url === SPPRA_DOCS_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [] })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            fileName: 'nit.pdf',
            contentType: 'application/pdf',
            bytes: samplePdf.toString('base64')
          }
        })
      };
    });
    global.fetch = fetchMock as any;

    await fetchSppraTendersPage(1, 50, 5000, { retryDelaysMs: [0] });
    await fetchSppraPublishedDocuments(717150, 5000, { retryDelaysMs: [0] });
    await downloadSppraFileBuffer(buildSppraDownloadUrl(101, 'guid-tls', 'Tender Notice'), {
      retryDelaysMs: [0]
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.dispatcher).toBe(expectedDispatcher);
    }
  });

  it('rotates dispatcher on transient HTTP 500 WSO2 auth failures, drains error bodies, and rejects 4xx without rotating', async () => {
    let attempts = 0;
    const drainText = vi.fn().mockResolvedValue('{"code":"900900","message":"Unclassified Authentication Failure","description":"peer not authenticated"}');
    const retryMock = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts <= 3) {
        return {
          ok: false,
          status: 500,
          text: drainText
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            totalRecords: 1,
            records: [
              {
                publishedDocumentID: 717150,
                name: 'Procurement of Lab Equipment for University of Sindh',
                tenderNumbers: 'EPADS-S-26119999999',
                departmentName: 'University of Sindh',
                statusName: 'In-Progress',
                lastSubmissionDate: '2026-12-28T11:30:00'
              }
            ]
          }
        })
      };
    });
    global.fetch = retryMock as any;

    const spPortal = PORTAL_DEFINITIONS.find(p => p.id === 'sppra')!;
    const res = await scrapeSppraPortal(
      { ...spPortal, pagination: { kind: 'api', maxPages: 1, quickMaxPages: 1, deepMaxPages: 1 } },
      { depth: 'quick', maxAttempts: 6, retryDelaysMs: [0, 0, 0, 0, 0] }
    );
    expect(retryMock).toHaveBeenCalledTimes(4);
    expect(drainText).toHaveBeenCalledTimes(3);
    const seenDispatchers = retryMock.mock.calls.map(([, init]) => init.dispatcher);
    expect(new Set(seenDispatchers).size).toBe(4);
    expect(getSppraDispatcher()).toBe(seenDispatchers[3]);
    expect(res.pagesScanned).toBe(1);
    expect(res.items).toHaveLength(1);

    const before400Dispatcher = getSppraDispatcher();
    const clientErrorMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('Bad Request')
    });
    global.fetch = clientErrorMock as any;

    await expect(
      fetchSppraTendersPage(1, 50, 5000, { maxAttempts: 6, retryDelaysMs: [0] })
    ).rejects.toThrow('SPPRA API HTTP 400 on page 1');
    expect(clientErrorMock).toHaveBeenCalledTimes(1);
    expect(getSppraDispatcher()).toBe(before400Dispatcher);
  });

  it('preserves already-scraped pages if page 2 exhausts retries, but throws when page 1 fails', async () => {
    const spPortal = PORTAL_DEFINITIONS.find(p => p.id === 'sppra')!;
    const makeRec = (n: number) => ({
      publishedDocumentID: 710000 + n,
      name: `Sindh Water Supply Scheme Package ${n}`,
      tenderNumbers: `EPADS-S-2611100${n}`,
      departmentName: 'Public Health Engineering Dept',
      statusName: 'In-Progress',
      lastSubmissionDate: '2026-12-30T11:00:00'
    });

    const partialMock = vi.fn().mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const page = Number(body.pagination.pageNumber);
      if (page === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              totalRecords: 100,
              records: Array.from({ length: 50 }, (_, i) => makeRec(i + 1))
            }
          })
        };
      }
      return {
        ok: false,
        status: 500,
        text: async () => '{"code":"900900"}'
      };
    });
    global.fetch = partialMock as any;

    const partialRes = await scrapeSppraPortal(
      { ...spPortal, pagination: { kind: 'api', maxPages: 2, quickMaxPages: 2, deepMaxPages: 2 } },
      { depth: 'quick', maxAttempts: 3, retryDelaysMs: [0, 0] }
    );
    expect(partialRes.pagesScanned).toBe(1);
    expect(partialRes.items).toHaveLength(50);
    // 1 call for page 1 + 3 retry attempts for page 2
    expect(partialMock).toHaveBeenCalledTimes(4);

    const page1FailMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '{"code":"900900"}'
    });
    global.fetch = page1FailMock as any;

    await expect(
      scrapeSppraPortal(
        { ...spPortal, pagination: { kind: 'api', maxPages: 2, quickMaxPages: 2, deepMaxPages: 2 } },
        { depth: 'quick', maxAttempts: 3, retryDelaysMs: [0, 0] }
      )
    ).rejects.toThrow('SPPRA API HTTP 500 on page 1');
    expect(page1FailMock).toHaveBeenCalledTimes(3);
  });

  it('retries transient HTTP 500 on downloadSppraFileBuffer and stops immediately on abort', async () => {
    const samplePdf = Buffer.from('%PDF-1.6\nRetry Download Success\n%%EOF', 'utf8');
    let dlCalls = 0;
    const dlMock = vi.fn().mockImplementation(async () => {
      dlCalls++;
      if (dlCalls < 3) {
        return {
          ok: false,
          status: 500,
          text: async () => '{"code":"900900"}'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            fileName: 'RetryDoc.pdf',
            contentType: 'application/pdf',
            bytes: samplePdf.toString('base64')
          }
        })
      };
    });
    global.fetch = dlMock as any;

    const url = buildSppraDownloadUrl(555, 'guid-retry', 'Tender Notice');
    const buf = await downloadSppraFileBuffer(url, { maxAttempts: 5, retryDelaysMs: [0, 0] });
    expect(dlMock).toHaveBeenCalledTimes(3);
    expect(buf.toString('utf8')).toContain('Retry Download Success');

    const controller = new AbortController();
    const abortFetchMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    global.fetch = abortFetchMock as any;

    await expect(
      downloadSppraFileBuffer(url, { signal: controller.signal, maxAttempts: 5, retryDelaysMs: [100] })
    ).rejects.toThrow('File download aborted');
    expect(abortFetchMock).toHaveBeenCalledTimes(1);
  });
});
