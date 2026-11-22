import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { EventEmitter } from 'events';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import { parsePortalHtml, extractAjkLocation } from '../../src/server/scrapers/portalParsers.js';
import { getPortalFileCode, inferDocType } from '../../src/server/services/dossierStore.js';
import { fetchFileBuffer } from '../../src/server/services/dossierManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'portals', 'ajk_ppra', 'page.html');

describe('AJK PPRA (ajk_ppra) statutory connector', () => {
  it('registers ajk_ppra canonically in PORTAL_DEFINITIONS with AJKPPRA file code and corrigendum docType detection', () => {
    const ajk = PORTAL_DEFINITIONS.find(p => p.id === 'ajk_ppra');
    expect(ajk).toBeDefined();
    expect(ajk!.name).toBe('AJK PPRA (ajkppra.gov.pk)');
    expect(ajk!.category).toBe('Regulatory');
    expect(ajk!.tier).toBe('http');
    expect(ajk!.accessMode).toBe('public');
    expect(ajk!.baseUrl).toBe('https://www.ajkppra.gov.pk');
    expect(ajk!.tendersUrl).toBe('https://www.ajkppra.gov.pk/advertisements.php');
    expect(ajk!.fileCode).toBe('AJKPPRA');

    expect(getPortalFileCode('ajk_ppra')).toBe('AJKPPRA');
    expect(inferDocType('Download File', 'https://www.ajkppra.gov.pk/uploadfiles/tenderdocuments/1794998019JARBJ - Corr. 6704.pdf')).toBe('corrigendum');
  });

  it('parses Section 3g AJK PPRA table rows, strips badge counts, resolves inline Corrigendum PDFs, and skips Sales/Auction/Disposal rows', () => {
    const ajk = PORTAL_DEFINITIONS.find(p => p.id === 'ajk_ppra')!;
    const html = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const result = parsePortalHtml(html, ajk);

    expect(result.hitlRequired).toBe(false);
    expect(result.items).toHaveLength(2);

    const first = result.items[0];
    expect(first.referenceNo).toBe('AJKPPRA-6704');
    expect(first.title).toBe('Purchase of Miscellaneous Items (Cardiac Hospital Muzaffarabad)');
    expect(first.title).not.toContain('(11)');
    expect(first.organization).toBe('Health Muzaffarabad (Health Department)');
    expect(first.location).toBe('Muzaffarabad, Azad Kashmir');
    expect(first.publishDate).toBe('2026-11-04T09:00:00.000Z');
    expect(first.closingDate).toBe('2026-11-26T09:00:00.000Z');
    expect(first.isCorrigendum).toBe(true);
    expect(first.directUrl).toBe(
      'https://www.ajkppra.gov.pk/uploadfiles/tenderdocuments/1793794962SRPPA%20-%20Tender%20Cardiac.%20Hospital%20Mzd.pdf'
    );
    expect(first.attachmentUrls).toEqual([
      'https://www.ajkppra.gov.pk/uploadfiles/tenderdocuments/1793794962SRPPA%20-%20Tender%20Cardiac.%20Hospital%20Mzd.pdf',
      'https://www.ajkppra.gov.pk/uploadfiles/tenderdocuments/1794998019JARBJ%20-%20Corr.%206704.pdf'
    ]);

    const second = result.items[1];
    expect(second.referenceNo).toBe('AJKPPRA-6716');
    expect(second.title).toBe('Construction, Upgradation & Improvement of Education Facilities in AJK District Bagh (EEC)');
    expect(second.organization).toBe('Elementary and Secondary Education (Education Department)');
    expect(second.location).toBe('Bagh, Azad Kashmir');
    expect(second.publishDate).toBe('2026-11-16T09:00:00.000Z');
    expect(second.closingDate).toBe('2026-12-10T09:00:00.000Z');
    expect(second.isCorrigendum).toBeUndefined();

    // All-auction table returns 0 items cleanly without leaking to generic Section 4 fallback
    const auctionOnlyHtml = `
      <table class="table">
        <tr><th>Procurement</th><th>Procurement Title</th><th>Publishing Date</th><th>Closing Date</th><th>Department</th><th>Procuring Agency</th><th>Download</th></tr>
        <tr>
          <td>Sales/Auction/Disposal <br> 6714</td>
          <td>Auction of Wood</td>
          <td>13-11-2026</td>
          <td>24-11-2026</td>
          <td>Forest</td>
          <td>Forest Mirpur</td>
          <td><a href="uploadfiles/tenderdocuments/wood.pdf">Download File</a></td>
        </tr>
      </table>
    `;
    expect(parsePortalHtml(auctionOnlyHtml, ajk).items).toHaveLength(0);
  });

  it('extracts all 10 AJK districts including abbreviations and falls back to Azad Kashmir, Pakistan', () => {
    const cases: Array<[string, string | undefined, string]> = [
      ['Highways Division Mzd', undefined, 'Muzaffarabad, Azad Kashmir'],
      ['Water Supply Muzaffarabad', undefined, 'Muzaffarabad, Azad Kashmir'],
      ['Mirpur Development Authority', undefined, 'Mirpur, Azad Kashmir'],
      ['C&W Building Division Bagh', undefined, 'Bagh, Azad Kashmir'],
      ['Elementary Education Board Neelum', undefined, 'Neelum, Azad Kashmir'],
      ['Municipal Corporation Rawalakot', undefined, 'Rawalakot, Azad Kashmir'],
      ['Health Office Sudhanoti', undefined, 'Sudhanoti, Azad Kashmir'],
      ['Irrigation Division Bhimber', undefined, 'Bhimber, Azad Kashmir'],
      ['B&R Division Kotli', undefined, 'Kotli, Azad Kashmir'],
      ['District Office Hattian Bala', undefined, 'Hattian, Azad Kashmir'],
      ['Education Office Haveli', undefined, 'Haveli, Azad Kashmir'],
      ['AJK Central Secretariat', 'Supply of Solar Panels in Poonch', 'Rawalakot, Azad Kashmir'],
      ['AJK Central Secretariat', 'Procurement of IT Hardware', 'Azad Kashmir, Pakistan']
    ];
    for (const [dept, title, expected] of cases) {
      expect(extractAjkLocation(dept, title)).toBe(expected);
    }
  });

  it('fetchFileBuffer supplies portal Referer header by default and honors custom referer options', async () => {
    const sentHeaders: Array<Record<string, any>> = [];
    const httpsSpy = vi.spyOn(https, 'get').mockImplementation((_url: any, opts: any, cb: any) => {
      sentHeaders.push(opts.headers || {});
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      res.complete = true;
      res.headers = { 'content-type': 'application/pdf' };
      setImmediate(() => {
        cb(res);
        res.emit('data', Buffer.from('%PDF-1.4 AJK PPRA Document'));
        res.emit('end');
      });
      return req;
    });

    try {
      const buf1 = await fetchFileBuffer('https://www.ajkppra.gov.pk/uploadfiles/tenderdocuments/test.pdf');
      expect(buf1.toString()).toContain('%PDF-1.4 AJK PPRA Document');
      expect(sentHeaders[0]['Referer']).toBe('https://www.ajkppra.gov.pk/');

      await fetchFileBuffer('https://www.ajkppra.gov.pk/uploadfiles/tenderdocuments/test2.pdf', undefined, 0, {
        referer: 'https://www.ajkppra.gov.pk/advertisements.php'
      });
      expect(sentHeaders[1]['Referer']).toBe('https://www.ajkppra.gov.pk/advertisements.php');
    } finally {
      httpsSpy.mockRestore();
    }
  });
});
