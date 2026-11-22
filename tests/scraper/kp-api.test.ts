import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractKpLocation,
  mapKpRecordToScrapedTender,
  fetchKpTendersPage,
  scrapeKpPortal,
  KP_TENDERS_API_URL
} from '../../src/server/scrapers/kpApi.js';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import { scrapePortal } from '../../src/server/scrapers/crawlerEngine.js';
import { sslTolerantDispatcher } from '../../src/server/scrapers/baseScraper.js';
import { db, initDatabase } from '../../src/server/db/index.js';

describe('Khyber Pakhtunkhwa (kppra) Official JSON API scraper', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('extracts KP districts, multi-word names, abbreviations, title fallbacks, and avoids false positives', () => {
    expect(extractKpLocation('C&W Highway Division D.I. Khan')).toBe('Dera Ismail Khan, Khyber Pakhtunkhwa');
    expect(extractKpLocation('Elementary Education Office Lower Dir')).toBe('Lower Dir, Khyber Pakhtunkhwa');
    expect(extractKpLocation('District Health Officer Lakki Marwat')).toBe('Lakki Marwat, Khyber Pakhtunkhwa');
    expect(extractKpLocation('Irrigation Department North Waziristan')).toBe('North Waziristan, Khyber Pakhtunkhwa');

    expect(extractKpLocation('Abdul Wali Khan University, Mardan')).toBe('Mardan, Khyber Pakhtunkhwa');
    expect(extractKpLocation('Directorate of Health Services Peshawar')).toBe('Peshawar, Khyber Pakhtunkhwa');
    expect(extractKpLocation('TMA Mingora Swat')).toBe('Swat, Khyber Pakhtunkhwa');

    expect(
      extractKpLocation('Elementary & Secondary Education Department', 'Supply of Furniture for Govt High School Kohat')
    ).toBe('Kohat, Khyber Pakhtunkhwa');

    expect(
      extractKpLocation('Khyber Pakhtunkhwa Textbook Board', 'Construction of Overhead Water Tank')
    ).toBe('Khyber Pakhtunkhwa, Pakistan');
  });

  it('maps active KP JSON records, ignores empty file_path, resolves corrigenda extensions, and skips auctions/closed tenders', () => {
    const active = mapKpRecordToScrapedTender({
      uuid: 'c61fbe44-c486-4d5e-933c-feeef5c952b6',
      tender_number: '33486',
      title: 'Supply of Lab Equipment for Department of Geology AWKUM',
      description: null,
      reference: 'kppra',
      status: 'Open',
      tender_type: 'Goods',
      date_of_advertisement_formatted: '2026-11-05',
      closing_date_formatted: '2026-11-23',
      date_of_advertisement: '05/11/2026',
      closing_date: '23/11/2026',
      department_name: 'Abdul Wali Khan University, Mardan',
      company: { title: 'Abdul Wali Khan University, Mardan' },
      media: { file_path: 'http://kppra.gov.pk/kppra/dept/upload/1793885563awkum.pdf' },
      bidding_document: { file_path: 'http://kppra.gov.pk/kppra/dept/upload/1793885563awkumbidding.pdf' },
      corrigendum: null,
      corrigenda: null
    });

    expect(active).not.toBeNull();
    expect(active!.directUrl).toBe('https://kp.gov.pk/tender/detail/c61fbe44-c486-4d5e-933c-feeef5c952b6');
    expect(active!.referenceNo).toBe('33486');
    expect(active!.organization).toBe('Abdul Wali Khan University, Mardan');
    expect(active!.location).toBe('Mardan, Khyber Pakhtunkhwa');
    expect(active!.publishDate).toBe('2026-11-05T09:00:00.000Z');
    expect(active!.closingDate).toBe('2026-11-23T09:00:00.000Z');
    expect(active!.description).toContain('Type: Goods');
    expect(active!.isCorrigendum).toBeUndefined();
    expect(active!.attachmentUrls).toEqual([
      'http://kppra.gov.pk/kppra/dept/upload/1793885563awkum.pdf',
      'http://kppra.gov.pk/kppra/dept/upload/1793885563awkumbidding.pdf'
    ]);

    // Empty bidding_document.file_path is ignored and generic department defaults cleanly
    const emptyBidPath = mapKpRecordToScrapedTender({
      uuid: '2798d6a9-e999-4001-b061-622059e00671',
      tender_number: '99',
      title: 'Provision of Networking Equipment for Secretariat',
      reference: 'kppra',
      status: 'Open',
      tender_type: 'Goods',
      date_of_advertisement_formatted: '2026-11-20',
      closing_date_formatted: '2026-12-05',
      department_name: 'Khyber Pakhtunkhwa',
      company: { title: 'Khyber Pakhtunkhwa\r\nPortal' },
      media: { file_path: 'https://mgn1.kp.gov.pk/storage/media/2026/11/nit.pdf' },
      bidding_document: { file_path: '' }
    });
    expect(emptyBidPath).not.toBeNull();
    expect(emptyBidPath!.referenceNo).toBe('KPPRA-99');
    expect(emptyBidPath!.organization).toBe('Khyber Pakhtunkhwa Procurement (KPPRA)');
    expect(emptyBidPath!.attachmentUrls).toEqual(['https://mgn1.kp.gov.pk/storage/media/2026/11/nit.pdf']);

    // Corrigendum with DD/MM/YYYY "03/12/2026" extends closing date to Dec 3, 2026 PKT (not Mar 12)
    const extended = mapKpRecordToScrapedTender({
      uuid: '1240deea-f377-4a7a-afc5-98157b56fb10',
      tender_number: '33500',
      title: 'Construction of Flood Protection Works etc',
      reference: 'kppra',
      status: 'Open',
      tender_type: 'Works',
      date_of_advertisement_formatted: '2026-11-06',
      closing_date_formatted: '2026-11-25',
      department_name: 'Warsak Canals Division, Irrigation Department',
      media: { file_path: 'http://kppra.gov.pk/kppra/dept/upload/1793978580NIT.pdf' },
      bidding_document: { file_path: 'http://kppra.gov.pk/kppra/dept/upload/1793978580SBD1.pdf' },
      corrigendum: 'Yes',
      corrigenda: [
        {
          corrigendum_description: 'date extended',
          corrigendum_close_date: '03/12/2026',
          corrigendum_created: '13/11/2026',
          corrigendum_document: 'http://kppra.gov.pk/kppra/dept/upload/corri1794570769corr.pdf'
        }
      ]
    });
    expect(extended).not.toBeNull();
    expect(extended!.isCorrigendum).toBe(true);
    expect(extended!.closingDate).toBe('2026-12-03T09:00:00.000Z');
    expect(extended!.attachmentUrls).toEqual([
      'http://kppra.gov.pk/kppra/dept/upload/1793978580NIT.pdf',
      'http://kppra.gov.pk/kppra/dept/upload/1793978580SBD1.pdf',
      'http://kppra.gov.pk/kppra/dept/upload/corri1794570769corr.pdf'
    ]);

    // Auction and Closed/Cancelled rows are skipped
    expect(
      mapKpRecordToScrapedTender({
        uuid: 'a-1',
        title: 'Auction of Condemned Vehicles at Directorate',
        status: 'Open',
        tender_type: 'Goods'
      })
    ).toBeNull();
    expect(
      mapKpRecordToScrapedTender({
        uuid: 'a-2',
        title: 'Auction of Toll Tax Collection Rights at Kohat Bridge',
        status: 'Open',
        tender_type: 'Non-Consulting Services'
      })
    ).toBeNull();
    expect(
      mapKpRecordToScrapedTender({
        uuid: 'a-3',
        title: 'Lease of Canteen Space in Hospital',
        status: 'Open',
        tender_type: 'Auction'
      })
    ).toBeNull();
    expect(
      mapKpRecordToScrapedTender({
        uuid: 'c-1',
        title: 'Supply of Medical Kits for District Hospital',
        status: 'Closed',
        tender_type: 'Goods'
      })
    ).toBeNull();
    expect(
      mapKpRecordToScrapedTender({
        uuid: 'c-2',
        title: 'Supply of Solar Inverters for Schools',
        status: 'Cancelled',
        tender_type: 'Goods'
      })
    ).toBeNull();
  });

  it('paginates scrapeKpPortal up to quick/deep bounds and stops early on unchanged quick-scan pages', async () => {
    const kppraPortal = PORTAL_DEFINITIONS.find(p => p.id === 'kppra')!;
    expect(kppraPortal.tier).toBe('http');
    expect(kppraPortal.accessMode).toBe('public');
    expect(kppraPortal.tendersUrl).toBe('https://kp.gov.pk/tenders');
    expect(kppraPortal.pagination?.quickMaxPages).toBe(8);
    expect(kppraPortal.pagination?.deepMaxPages).toBe(15);

    const makeRecord = (idx: number) => ({
      uuid: `uuid-${idx}`,
      tender_number: `${40000 + idx}`,
      title: `Procurement of Training Equipment Lot ${idx}`,
      reference: 'kppra',
      status: 'Open',
      tender_type: 'Goods',
      date_of_advertisement_formatted: '2026-11-10',
      closing_date_formatted: '2026-12-20',
      department_name: 'KP TEVTA Peshawar',
      media: { file_path: `https://mgn1.kp.gov.pk/storage/media/${idx}.pdf` }
    });

    const requestedPages: number[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const pageNum = Number(new URL(url).searchParams.get('page') || '1');
      requestedPages.push(pageNum);
      const records = [makeRecord((pageNum - 1) * 2 + 1), makeRecord((pageNum - 1) * 2 + 2)];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: records,
          meta: { current_page: pageNum, last_page: 20, total: 40 }
        })
      };
    }) as any;

    const singlePage = await fetchKpTendersPage(1);
    expect(singlePage.records).toHaveLength(2);
    expect(singlePage.lastPage).toBe(20);
    expect(global.fetch).toHaveBeenCalledWith(
      `${KP_TENDERS_API_URL}?domain=&page=1&search=`,
      expect.objectContaining({ method: 'GET', dispatcher: sslTolerantDispatcher })
    );

    // Quick scan stops at quickMaxPages (8)
    requestedPages.length = 0;
    const quickRes = await scrapeKpPortal(kppraPortal, { depth: 'quick' });
    expect(quickRes.pagesScanned).toBe(8);
    expect(quickRes.items).toHaveLength(16);
    expect(requestedPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Deep scan stops at deepMaxPages (15)
    requestedPages.length = 0;
    const deepRes = await scrapeKpPortal(kppraPortal, { depth: 'deep' });
    expect(deepRes.pagesScanned).toBe(15);
    expect(deepRes.items).toHaveLength(30);

    // Quick scan with knownMap stops early after page 2 when >=85% items on page 2 are unchanged
    requestedPages.length = 0;
    const knownMap = new Map<string, { closing_date: string | null; has_corrigendum: number }>([
      ['https://kp.gov.pk/tender/detail/uuid-3', { closing_date: '2026-12-20T09:00:00.000Z', has_corrigendum: 0 }],
      ['https://kp.gov.pk/tender/detail/uuid-4', { closing_date: '2026-12-20T09:00:00.000Z', has_corrigendum: 0 }]
    ]);
    const earlyStopRes = await scrapeKpPortal(kppraPortal, { depth: 'quick', knownMap });
    expect(earlyStopRes.pagesScanned).toBe(2);
    expect(earlyStopRes.items).toHaveLength(4);
    expect(requestedPages).toEqual([1, 2]);
  });

  it('dispatches kppra scans through scrapePortal in crawlerEngine', async () => {
    initDatabase();
    for (const t of ['document_ingest_jobs', 'corrigendum_logs', 'pipeline_audit_logs', 'tenders', 'deleted_tenders']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            uuid: 'kp-dispatch-1',
            tender_number: '33900',
            title: 'Establishment of IT Skills Lab in Swabi',
            reference: 'kppra',
            status: 'Open',
            tender_type: 'Goods',
            date_of_advertisement_formatted: '2026-11-15',
            closing_date_formatted: '2026-12-18',
            department_name: 'KPITB Peshawar',
            media: { file_path: 'https://mgn1.kp.gov.pk/storage/media/it-lab.pdf' }
          }
        ],
        meta: { current_page: 1, last_page: 1, total: 1 }
      })
    }) as any;

    const kppraPortal = PORTAL_DEFINITIONS.find(p => p.id === 'kppra')!;
    const result = await scrapePortal(kppraPortal, { depth: 'quick' });
    expect(result.hitlRequired).toBe(false);
    expect(result.pagesScanned).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Establishment of IT Skills Lab in Swabi');
    expect(result.items[0].location).toBe('Peshawar, Khyber Pakhtunkhwa');
  });
});
