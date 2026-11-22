import { describe, it, expect } from 'vitest';
import { PORTAL_DEFINITIONS } from '../../src/server/domain/portalList.js';
import { isDetailPageDiscoveryUrl } from '../../src/server/domain/detailDiscovery.js';
import {
  getPortalAdapter,
  getAllPortalAdapters,
  genericAdapter,
  parseWithAdapters
} from '../../src/server/scrapers/adapters/registry.js';
import { bppraAdapter } from '../../src/server/scrapers/adapters/bppraAdapter.js';

describe('PortalAdapter Registry & Specialized Connector Dispatch', () => {
  it('resolves an adapter for all 19 canonical PORTAL_DEFINITIONS and falls back to genericAdapter for custom portals', () => {
    const allAdapters = getAllPortalAdapters();
    expect(allAdapters.length).toBeGreaterThanOrEqual(10);

    for (const portal of PORTAL_DEFINITIONS) {
      const adapter = getPortalAdapter(portal.id);
      expect(adapter).toBeDefined();
      expect(adapter.portalIds).toContain(portal.id);
    }

    const custom = getPortalAdapter('custom_provincial_authority');
    expect(custom).toBe(genericAdapter);
  });

  it('configures EPMS PPRA transport tuning (55s degraded timeout and no cookie forwarding on pagination)', () => {
    const epms = getPortalAdapter('epms_ppra');
    expect(epms.transport?.degradedTimeoutMs).toBe(55000);
    expect(epms.transport?.forwardResponseCookiesOnPagination).toBe(false);
  });

  it('enforces stopOnEmpty on GBPPRA and AJK PPRA while allowing Punjab RadGrid to fall through to generic GridView/table', () => {
    const gbPortal = PORTAL_DEFINITIONS.find(p => p.id === 'gilgit')!;
    const gbEmptyMatchedHtml = `
      <html><body>
        <div class="job-post-item">
          <div class="badge-wrap"><span class="badge">Final Evaluation Report</span></div>
          <h2>Supply of Solar Equipment</h2>
        </div>
        <table><tbody><tr><td>Ignored generic fallback row because board matched GBPPRA</td><td>15-Dec-2026</td><td><a href="/doc.pdf">PDF</a></td></tr></tbody></table>
      </body></html>
    `;
    expect(parseWithAdapters(gbEmptyMatchedHtml, gbPortal).items).toEqual([]);

    const ajkPortal = PORTAL_DEFINITIONS.find(p => p.id === 'ajk_ppra')!;
    const ajkAuctionOnlyHtml = `
      <html><body>
        <table class="table">
          <tr><th>Procurement</th><th>Title</th><th>Publishing Date</th><th>Closing Date</th><th>Department</th><th>Procuring Agency</th><th>Download</th></tr>
          <tr><td>Sale/Auction 9001</td><td>Auction of Condemned Vehicles and Scrap Material</td><td>01-11-2026</td><td>30-11-2026</td><td>Works</td><td>PWD</td><td></td></tr>
        </table>
      </body></html>
    `;
    expect(parseWithAdapters(ajkAuctionOnlyHtml, ajkPortal).items).toEqual([]);

    const punjabPortal = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;
    const punjabGridViewHtml = `
      <html><body>
        <table id="ContentPlaceHolder1_GridView1">
          <tbody>
            <tr>
              <td><a href="/ViewTender.aspx?id=42">Supply and Installation of 50kW Hybrid Solar System</a></td>
              <td>Energy Department Punjab</td>
              <td>30-12-2026</td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;
    const punjabParsed = parseWithAdapters(punjabGridViewHtml, punjabPortal);
    expect(punjabParsed.items).toHaveLength(1);
    expect(punjabParsed.items[0].title).toContain('Hybrid Solar System');
  });

  it('returns null from bppraAdapter.scrapeListings when usingRealTransport is false so mock-fetchHtml paths stay active', async () => {
    const bppraPortal = PORTAL_DEFINITIONS.find(p => p.id === 'bppra')!;
    const result = await bppraAdapter.scrapeListings!(bppraPortal, {
      depth: 'quick',
      degradedMode: false,
      usingRealTransport: false,
      getKnownMap: () => null
    });
    expect(result).toBeNull();
  });

  it('classifies detail-page discovery URLs accurately for epms_ppra, fde, and bppra', () => {
    expect(isDetailPageDiscoveryUrl('https://epms.ppra.gov.pk/public/tenders/tender-details/12345', 'epms_ppra')).toBe(true);
    expect(isDetailPageDiscoveryUrl('https://fde.gov.pk/download/procurement-of-furniture/', 'fde')).toBe(true);
    expect(isDetailPageDiscoveryUrl('https://fde.gov.pk/download-category/tenders/', 'fde')).toBe(false);
    expect(isDetailPageDiscoveryUrl('https://bpptwo.vdc.services:9446/Reports/ViewTender.aspx?id=7788', 'bppra')).toBe(true);
    expect(isDetailPageDiscoveryUrl('https://example.gov.pk/notice.pdf', 'epms_ppra')).toBe(false);
  });
});
