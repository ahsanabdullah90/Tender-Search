import { isDirectDocumentUrl } from '../../../shared/documentUtils.js';
import { isEpmsDetailDiscoveryUrl } from '../../domain/detailDiscovery.js';
import { parseDateString } from '../dateParser.js';
import {
  RawScrapedItem,
  resolvePortalUrl,
  isNonBidEvaluationOrPlanTitle,
  extractRefFromText,
  collectRowAttachments,
  parseEpmsDetailHtml
} from '../parserHelpers.js';
import { extractHtmlDetailTargets } from './guards.js';
import type { AdapterFieldUpdates, PortalAdapter } from './types.js';

export const epmsPpraAdapter: PortalAdapter = {
  portalIds: ['epms_ppra'],
  transport: {
    degradedTimeoutMs: 55000,
    forwardResponseCookiesOnPagination: false
  },
  isDetailDiscoveryUrl: (url: string) => isEpmsDetailDiscoveryUrl(url, 'epms_ppra'),
  parseHtml($, portal) {
    // 3f. Structured Federal PPRA EPMS Active Tenders Table (https://epms.ppra.gov.pk/public/tenders/active-tenders)
    const epmsRows = $('table tbody tr').filter((_, el) => $(el).find('a[href*="/public/tenders/tender-details/"]').length > 0);
    if (epmsRows.length === 0) {
      return { matched: false, items: [] };
    }

    const items: RawScrapedItem[] = [];
    const decodeAmp = (s: string) => s.replace(/&#0*38;|&amp;/gi, '&');
    epmsRows.each((_, el) => {
      const statusCell = $(el).find('td[data-label="Status"]');
      const statusText = statusCell.text().replace(/\s+/g, ' ').trim();
      if (/\bcancelled\b/i.test(statusText) || statusCell.find('.badge-danger').length > 0) return;

      const detailLink = $(el).find('a[href*="/public/tenders/tender-details/"]').first();
      const directUrl = resolvePortalUrl(detailLink.attr('href'), portal);

      const detailsCell = $(el).find('td[data-label="Tender Details"]').first();
      const title = decodeAmp((detailsCell.find('strong').first().text() || '').replace(/\s+/g, ' ').trim());
      if (!title || title.length <= 5) return;
      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const tenderNoCell = $(el).find('td[data-label="Tender No"]').first();
      const ppraRef = (tenderNoCell.find('strong').first().text() || '').replace(/\s+/g, ' ').trim();
      const noticeMethod = (tenderNoCell.find('.badge').first().text() || '').replace(/\s+/g, ' ').trim();

      const snippet = decodeAmp((detailsCell.find('small.text-muted').first().text() || '').replace(/\s+/g, ' ').trim());
      const detailBadges = detailsCell.find('div small.badge').map((__, b) => $(b).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
      const sectorBadge = detailBadges[0] || '';
      const inquiryRef = detailBadges[1] && detailBadges[1] !== ppraRef ? detailBadges[1] : '';

      const expandId = $(el).find('.cb-rt-expand').attr('data-id');
      const expandedRow = expandId ? $(`#cb-rt-detail-${expandId}`) : $(el).next('tr.cb-rt-detail-row');
      let organization = portal.name;
      let location: string | undefined;
      const detailMeta: Record<string, string> = {};

      if (expandedRow.length > 0) {
        expandedRow.find('.cb-rt-grid > div').each((__, col) => {
          const label = $(col).find('.cb-rt-dl').text().replace(/\s+/g, ' ').trim().toLowerCase();
          const valEl = $(col).find('.cb-rt-dv').first();
          if (!label || !valEl.length) return;
          if (label === 'organization') {
            const orgName = decodeAmp(valEl.find('strong').first().text().replace(/\s+/g, ' ').trim());
            const subOffice = decodeAmp(valEl.find('.text-dark').first().text().replace(/\s+/g, ' ').trim());
            const locTxt = decodeAmp(valEl.find('small').first().text().replace(/\s+/g, ' ').trim());
            if (orgName.length > 2) {
              organization = subOffice && subOffice !== orgName ? `${orgName} (${subOffice})` : orgName;
            }
            if (locTxt.length > 2) {
              location = locTxt;
            }
          } else {
            detailMeta[label] = decodeAmp(valEl.text().replace(/\s+/g, ' ').trim());
          }
        });
      }

      const advRaw = $(el).find('td[data-label="Advertised"]').first().text().replace(/\s+/g, ' ').trim();
      const publishDate = parseDateString(advRaw) || undefined;

      const closeCell = $(el).find('td[data-label="Closing"]').first();
      const closeDatePart = closeCell.find('strong').first().text().replace(/\s+/g, ' ').trim();
      const closeTimePart = closeCell.find('small').first().text().replace(/\s+/g, ' ').trim();
      const closeRaw = closeDatePart && closeTimePart
        ? `${closeDatePart} ${closeTimePart}`
        : closeCell.text().replace(/\s+/g, ' ').trim();
      const closingDate = parseDateString(closeRaw);

      const metaTags = [
        noticeMethod,
        detailMeta['tender type'],
        detailMeta['procurement category'],
        sectorBadge || detailMeta['sector'],
        detailMeta['tender nature'],
        inquiryRef ? `Ref: ${inquiryRef}` : ''
      ].filter(Boolean);
      const description = [snippet, metaTags.join(' · ')].filter(Boolean).join(' — ').slice(0, 350);

      items.push({
        referenceNo: (ppraRef && /^[A-Z]{2}\d{5,}[A-Z0-9]*$/i.test(ppraRef) ? ppraRef : undefined) || inquiryRef || extractRefFromText(title),
        title,
        organization,
        directUrl,
        publishDate,
        closingDate,
        location,
        description,
        isCorrigendum:
          statusCell.find('.badge-corrigendum').length > 0 ||
          /\b(?:corrigendum|amendment|addendum|extension)\b/i.test(
            `${title} ${snippet} ${statusText} ${detailMeta['tender type'] || ''}`
          ),
        attachmentUrls: collectRowAttachments($, el, portal)
      });
    });

    return { matched: true, items, sanitize: true, stopOnEmpty: false };
  },
  async enrichDetail(ctx) {
    const { tender } = ctx;
    if (!tender.direct_url || !tender.direct_url.startsWith('http') || isDirectDocumentUrl(tender.direct_url)) {
      return { handled: true, checked: false, discoveredUrls: [] };
    }

    const isEpmsUrl = tender.direct_url.includes('epms.ppra.gov.pk');
    if (ctx.existingDossierCount > 0 && !ctx.forceRefresh && !isEpmsUrl) {
      return { handled: true, checked: false, discoveredUrls: [] };
    }

    const html = await ctx.fetchHtml(tender.direct_url);
    const fieldUpdates: AdapterFieldUpdates = {};

    if (isEpmsUrl) {
      const meta = parseEpmsDetailHtml(html);
      if (meta) {
        if (meta.bidBrief && (ctx.forceRefresh || !tender.bid_brief)) {
          fieldUpdates.bid_brief = meta.bidBrief;
        }
        if (meta.description && (ctx.forceRefresh || !tender.description || meta.description.length > tender.description.length + 20)) {
          fieldUpdates.description = meta.description;
        }
        if (meta.location && (!tender.location || tender.location === 'Pakistan')) {
          fieldUpdates.location = meta.location;
        }
      }
    }

    const extracted = extractHtmlDetailTargets(html, tender, ctx.portal);
    return {
      handled: true,
      checked: true,
      fieldUpdates: Object.keys(fieldUpdates).length > 0 ? fieldUpdates : undefined,
      discoveredUrls: extracted.discoveredUrls,
      detailText: extracted.detailText
    };
  }
};
