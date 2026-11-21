import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';
import {
  normalizeBppraUrl,
  extractBppraBidId,
  parseBppraNitApiResponse,
  fetchBppraDetailMetadata
} from '../../src/server/scrapers/bppraScraper.js';
import { parsePortalHtml } from '../../src/server/scrapers/portalParsers.js';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import { isDetailPageDiscoveryUrl } from '../../src/server/db/repositories/ingestJobsRepo.js';
import { db, initDatabase, getAllTenders, setAppSetting } from '../../src/server/db/index.js';
import { processAndSaveTender, fetchDocumentsForTender, crawlerDeps } from '../../src/server/scrapers/crawlerEngine.js';

describe('Balochistan BPPRA upgraded scraper & :9446 API integration', () => {
  const bppraPortal = PORTAL_DEFINITIONS.find(p => p.id === 'bppra')!;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes double slashes in :9446 report URLs and extracts bid IDs including malformed query strings', () => {
    expect(normalizeBppraUrl('https://bpptwo.vdc.services:9446//Reports/Works/BiddingDocumentWorks.html?id=106231'))
      .toBe('https://bpptwo.vdc.services:9446/Reports/Works/BiddingDocumentWorks.html?id=106231');

    expect(extractBppraBidId('https://bpptwo.vdc.services:9446//Reports/Works/BiddingDocumentWorks.html?id=106231')).toBe(106231);
    expect(extractBppraBidId('https://bpptwo.vdc.services:9446/Reports/GoodsProcurement/BiddingDocument.html?id=106325')).toBe(106325);
    expect(extractBppraBidId('https://bpptwo.vdc.services:9446/Reports/GoodsProcurement/NITDocument.html?id=106231')).toBe(106231);
    expect(extractBppraBidId('https://bpptwo.vdc.services:9446/Reports/GoodsProcurement/RFPNITDocument.html?id=1164Nitflaf=true')).toBe(1164);
    expect(extractBppraBidId('https://bpptwo.vdc.services:5451/Tenders')).toBeNull();
  });

  it('parses BPPRA Works NIT JSON into deterministic BidBrief, FTS5 text, and BOQ PDF URL', () => {
    const meta = parseBppraNitApiResponse({
      BiddingData: JSON.stringify([
        {
          Bidding_ID: 106231,
          TSENumber: 'TSE-2627111226773',
          TenderName: 'Construction of Village Road Bridge on Out Fall Drain',
          AgencyName: 'Executive Engineer Drainage Irrigation Division Dera Allah Yar',
          BiddingPlace: 'Irrigation Colony Dera Allah Yar',
          ApprovedBudget: 40000000,
          TenderDocFee: 1500,
          BidSecurityPercentage: 3,
          BidPaymentType: 'Cash Deposit,Green Challan',
          Method: 'Single Stage Two Envelope Bidding Procedure',
          EVALUATIONTYPE: 'Package wise',
          Criteria: 'Least Cost Selection',
          AttachDocument: '888c2540-7d5c-4cfc-a323-1611eea8a1a8.pdf',
          IsCorrigendum: 0
        }
      ]),
      EligibilityCriteria: JSON.stringify([
        {
          EligibilityFactor: 'Active Tax Payer',
          FactorDescription: 'Presence in Active Tax Payer List',
          RequiredDocument: 'Attach Copy of NTN',
          IncomeTaxCheck: 1
        },
        {
          EligibilityFactor: 'BRA Registration',
          FactorDescription: 'Balochistan Revenue Authority Registration is required',
          RequiredDocument: 'BRA Certificate',
          BRARegistrationcheck: 1
        },
        {
          EligibilityFactor: 'PEC Registration',
          FactorDescription: 'Valid C-4 PEC License',
          PECCheck: 1,
          SpecializedCode: 'CE-01'
        }
      ]),
      TenderItems: '[]',
      CorrigendumData: 'null'
    });

    expect(meta).not.toBeNull();
    expect(meta!.bidId).toBe(106231);
    expect(meta!.bidBrief.tenderFee).toBe('PKR 1,500');
    expect(meta!.bidBrief.bidSecurityAmount).toBe('3% (Cash Deposit, Green Challan)');
    expect(meta!.bidBrief.bidMethod).toBe('Single Stage Two Envelope Bidding Procedure • Package wise • Least Cost Selection');
    expect(meta!.bidBrief.requiredRegistrations).toEqual([
      'NTN / Active Tax Payer (ATL)',
      'BRA Registration',
      'PEC (CE-01)'
    ]);
    expect(meta!.boqPdfUrl).toBe('https://bpptwo.vdc.services:9446/Images/BOQManual/888c2540-7d5c-4cfc-a323-1611eea8a1a8.pdf');
    expect(meta!.extractedText).toContain('TSE-2627111226773');
    expect(meta!.extractedText).toContain('BRA Certificate');
    expect(meta!.isCorrigendum).toBe(false);
  });

  it('parses BPPRA Goods NIT JSON with TenderItems deliverables, experience, and corrigendum flag', () => {
    const meta = parseBppraNitApiResponse({
      BiddingData: JSON.stringify([
        {
          Bidding_ID: 106325,
          TSENumber: 'TSE-2627111225531',
          TenderName: 'Procurement of Disposables for Dialysis Centres',
          AgencyName: 'Health Department Quetta',
          BidSecurityPercentage: 2,
          Method: 'Single Stage Two Envelope Bidding Procedure',
          EVALUATIONTYPE: 'Item wise',
          Criteria: 'Least Cost Selection',
          IsCorrigendum: 1
        }
      ]),
      EligibilityCriteria: JSON.stringify([
        {
          EligibilityFactor: 'Experience',
          FactorDescription: '3 Assignments of Similar Nature in Previous 3 Years',
          RequiredDocument: 'Supply orders'
        },
        {
          EligibilityFactor: 'Financial Capacity',
          FactorDescription: 'Turnover of at least 30,000,000 PKR'
        }
      ]),
      TenderItems: JSON.stringify([
        { ItemName: 'Dialyzer Hollow Fiber', Quantity: 12000, ItemDetail: 'High flux adult dialyzer' },
        { ItemName: 'Blood Tubing Set', Quantity: 12000 }
      ]),
      CorrigendumData: JSON.stringify([{ CorrigendumId: 1 }])
    });

    expect(meta).not.toBeNull();
    expect(meta!.bidBrief.deliverablesSummary).toEqual([
      'Dialyzer Hollow Fiber (Qty: 12000)',
      'Blood Tubing Set (Qty: 12000)'
    ]);
    expect(meta!.bidBrief.requiredExperience).toContain('3 Assignments of Similar Nature');
    expect(meta!.bidBrief.requiredExperience).toContain('Turnover of at least 30,000,000 PKR');
    expect(meta!.boqPdfUrl).toBeNull();
    expect(meta!.isCorrigendum).toBe(true);
    expect(meta!.extractedText).toContain('High flux adult dialyzer');
  });

  it('parses BPPRA table rows with District location, Corrigendum flag, normalized //Reports/ URLs, and skips Closed/Awarded rows', () => {
    const html = `
      <table><tbody>
        <tr class="tender-row-main">
          <td class="td-sr-cell" rowspan="3">1</td>
          <td class="td-title-cell" rowspan="3">
            <div class="td-title-docs">
              <div class="td-title-top"><a class="td-title-link"><b>TSE-2627111226773</b><br>Solar Water Pumping Station at Gandakha</a></div>
              <div class="td-doc-links">
                <a class="td-doc-link" href="https://bpptwo.vdc.services:9446//Reports/Works/BiddingDocumentWorks.html?id=106231">Bidding Document</a>
                <a class="td-doc-link" href="https://bpptwo.vdc.services:9446/Reports/GoodsProcurement/NITDocument.html?id=106231">NIT Document</a>
                <a class="td-doc-link" href="https://bpptwo.vdc.services:9446/Images/BOQManual/solar-boq.pdf">BOQ Document</a>
              </div>
              <div class="td-title-footer">
                <span class="badge" title="Corrigendum">Corrigendum (11/20/2026 4:41:10 PM)</span>
                <span class="badge" title="Open">Open</span>
              </div>
            </div>
          </td>
          <td>Director General Energy<br><b>Department:</b> Energy Department<br><b>District:</b> Jafarabad</td>
          <td>Power Supply Solar and Energy Works</td>
          <td>Rs. 40,000,000 Approved</td>
        </tr>
        <tr class="tender-row-dates"><td colspan="3">Date</td></tr>
        <tr class="tender-row-dates">
          <td><b>Publish:</b> <span>20-Nov-2026</span> <b>Dead Line:</b> <span>07-Dec-2026 9:30 AM</span></td>
          <td></td><td></td>
        </tr>
        <tr class="tender-row-main">
          <td class="td-sr-cell" rowspan="3">2</td>
          <td class="td-title-cell" rowspan="3">
            <div class="td-title-docs">
              <div class="td-title-top"><a class="td-title-link"><b>TSE-2627000000001</b><br>Already Awarded Road Contract</a></div>
              <div class="td-title-footer"><span class="badge" title="Awarded">Awarded</span></div>
            </div>
          </td>
          <td>C&amp;W Quetta<br><b>District:</b> Quetta</td>
          <td>Road Works</td>
          <td>Rs. 10,000,000 Approved</td>
        </tr>
      </tbody></table>
    `;

    const parsed = parsePortalHtml(html, bppraPortal);
    expect(parsed.items).toHaveLength(1);
    const item = parsed.items[0];
    expect(item.referenceNo).toBe('TSE-2627111226773');
    expect(item.location).toBe('Jafarabad, Balochistan');
    expect(item.isCorrigendum).toBe(true);
    expect(item.directUrl).toBe('https://bpptwo.vdc.services:9446/Reports/Works/BiddingDocumentWorks.html?id=106231');
    expect(item.attachmentUrls).toContain('https://bpptwo.vdc.services:9446/Images/BOQManual/solar-boq.pdf');
    expect(item.attachmentUrls).toContain('https://bpptwo.vdc.services:9446/Reports/Works/BiddingDocumentWorks.html?id=106231');
  });

  it('marks BPPRA :9446 report URLs as background detail-discovery targets', () => {
    expect(isDetailPageDiscoveryUrl('https://bpptwo.vdc.services:9446/Reports/Works/BiddingDocumentWorks.html?id=106231', 'bppra')).toBe(true);
    expect(isDetailPageDiscoveryUrl('https://bpptwo.vdc.services:9446/Reports/PQN/PQNDocumentReport.html?id=102280', 'bppra')).toBe(true);
    expect(isDetailPageDiscoveryUrl('https://bpptwo.vdc.services:9446/Images/BOQManual/file.pdf', 'bppra')).toBe(false);
  });

  it('enriches BPPRA BidBrief, FTS5 extracted_text, and BOQ PDF inside fetchDocumentsForTender without fetchHtml', async () => {
    initDatabase();
    for (const t of ['document_ingest_jobs', 'corrigendum_logs', 'pipeline_audit_logs', 'tenders', 'deleted_tenders']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
    setAppSetting('gemini_api_key', '');

    const origDownload = crawlerDeps.downloadAndCacheDossier;
    crawlerDeps.downloadAndCacheDossier = vi.fn().mockResolvedValue(null);
    const fetchHtmlSpy = vi.spyOn(crawlerDeps, 'fetchHtml');
    const fetchBufSpy = vi.spyOn(crawlerDeps, 'fetchFileBuffer').mockImplementation(async (u: string) => {
      const b = Buffer.from(`%PDF-1.7 BPPRA BOQ from ${u}`);
      (b as any).contentType = 'application/pdf';
      return b;
    });

    const httpsGetSpy = vi.spyOn(https, 'get').mockImplementation(((_url: any, _opts: any, cb: any) => {
      const res: any = new EventEmitter();
      res.statusCode = 200;
      const req: any = new EventEmitter();
      req.destroy = vi.fn();
      process.nextTick(() => {
        cb(res);
        res.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              BiddingData: JSON.stringify([
                {
                  Bidding_ID: 106231,
                  TSENumber: 'TSE-2627111226773',
                  TenderName: 'Solar Energy System in Quetta',
                  AgencyName: 'Energy Dept Quetta',
                  TenderDocFee: 2000,
                  BidSecurityPercentage: 2,
                  Method: 'Single Stage Two Envelope Bidding Procedure',
                  AttachDocument: 'boq-106231.pdf',
                  IsCorrigendum: 0
                }
              ]),
              EligibilityCriteria: JSON.stringify([
                { EligibilityFactor: 'PEC Registration', PECCheck: 1, SpecializedCode: 'EE-04' }
              ]),
              TenderItems: '[]',
              CorrigendumData: 'null'
            })
          )
        );
        res.emit('end');
      });
      return req;
    }) as any);

    try {
      await processAndSaveTender(
        {
          title: 'Solar Energy System in Quetta',
          organization: 'Energy Dept Quetta',
          referenceNo: 'TSE-2627111226773',
          location: 'Quetta, Balochistan',
          closingDate: '2026-12-20T06:00:00.000Z',
          directUrl: 'https://bpptwo.vdc.services:9446/Reports/Works/BiddingDocumentWorks.html?id=106231',
          attachmentUrls: ['https://bpptwo.vdc.services:9446/Reports/Works/BiddingDocumentWorks.html?id=106231']
        },
        bppraPortal,
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

      // Verify direct unit call works too
      const meta = await fetchBppraDetailMetadata(106231);
      expect(meta?.bidBrief.tenderFee).toBe('PKR 2,000');

      const res = await fetchDocumentsForTender(saved.id);
      expect(fetchHtmlSpy).not.toHaveBeenCalled();
      expect(res.newlyFetched).toBe(1);
      expect(res.dossiers[0].originalUrl).toBe('https://bpptwo.vdc.services:9446/Images/BOQManual/boq-106231.pdf');
      expect(res.tender?.bid_brief?.tenderFee).toBe('PKR 2,000');
      expect(res.tender?.bid_brief?.requiredRegistrations).toContain('PEC (EE-04)');
    } finally {
      crawlerDeps.downloadAndCacheDossier = origDownload;
      fetchHtmlSpy.mockRestore();
      fetchBufSpy.mockRestore();
      httpsGetSpy.mockRestore();
    }
  });
});
