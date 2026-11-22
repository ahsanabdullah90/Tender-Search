import { isImageUrl, isCorrigendumLabel } from '../../../shared/documentUtils.js';
import { isAuctionOrDisposalTender } from '../scraperUtils.js';
import { parseDateString } from '../dateParser.js';
import {
  RawScrapedItem,
  resolvePortalUrl,
  isNonBidEvaluationOrPlanTitle,
  extractAjkLocation
} from '../parserHelpers.js';
import type { PortalAdapter } from './types.js';

export const ajkPpraAdapter: PortalAdapter = {
  portalIds: ['ajk_ppra'],
  parseHtml($, portal) {
    // 3g. Structured AJK PPRA Active Advertisements Table (https://www.ajkppra.gov.pk/advertisements.php)
    const ajkTable = $('table.table').filter((_, tbl) => {
      const firstRowText = $(tbl).find('tr').first().text().replace(/\s+/g, ' ').trim().toLowerCase();
      return (
        firstRowText.includes('procurement') &&
        firstRowText.includes('publishing date') &&
        firstRowText.includes('closing date') &&
        (firstRowText.includes('procuring agency') || portal.id === 'ajk_ppra')
      );
    }).first();
    if (ajkTable.length === 0) {
      return { matched: false, items: [] };
    }

    const items: RawScrapedItem[] = [];
    ajkTable.find('tr').each((_, el) => {
      if ($(el).find('th').length > 0) return;
      const tds = $(el).children('td');
      if (tds.length < 7) return;

      const col0Text = $(tds[0]).text().replace(/\s+/g, ' ').trim();
      if (!col0Text || isAuctionOrDisposalTender('', col0Text)) return;

      const idMatch = col0Text.match(/\b(\d{3,8})\b/);
      const referenceNo = idMatch ? `AJKPPRA-${idMatch[1]}` : undefined;
      const procType = col0Text.replace(/\b\d{3,8}\b/, '').replace(/\s+/g, ' ').trim();

      const titleClone = $(tds[1]).clone();
      titleClone.find('strong').each((__, sEl) => {
        if (/^\(?\d+\)?$/.test($(sEl).text().trim())) {
          $(sEl).remove();
        }
      });
      const title = titleClone.text().replace(/\s+/g, ' ').trim();
      if (!title || title.length <= 5) return;
      if (isAuctionOrDisposalTender(title)) {
        return;
      }

      const publishDate = parseDateString($(tds[2]).text().trim()) || undefined;
      const closingDate = parseDateString($(tds[3]).text().trim());
      const department = $(tds[4]).text().replace(/\s+/g, ' ').trim();
      const agency = $(tds[5]).text().replace(/\s+/g, ' ').trim();
      const organization =
        agency && department && !agency.toLowerCase().includes(department.toLowerCase())
          ? `${agency} (${department})`
          : (agency || department || portal.name);

      const attachmentUrls: string[] = [];
      let mainDocUrl: string | undefined;
      let hasCorrLink = false;
      $(tds[6]).find('a[href]').each((__, aEl) => {
        const href = $(aEl).attr('href');
        if (!href) return;
        const absUrl = resolvePortalUrl(href, portal);
        if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);

        const linkText = $(aEl).text().replace(/\s+/g, ' ').trim();
        const linkTitle = $(aEl).attr('title') || '';
        const linkStyle = ($(aEl).attr('style') || '').toLowerCase();
        const isCorr =
          isCorrigendumLabel(linkText) ||
          isCorrigendumLabel(`${href} ${linkTitle}`) ||
          /#ff0000|\bred\b/.test(linkStyle);
        if (isCorr) {
          hasCorrLink = true;
        } else if (!mainDocUrl && !isImageUrl(absUrl)) {
          mainDocUrl = absUrl;
        }
      });

      const directUrl = mainDocUrl || attachmentUrls[0] || portal.tendersUrl;
      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const isCorrigendum =
        hasCorrLink ||
        isCorrigendumLabel(col0Text) ||
        isCorrigendumLabel(title);

      items.push({
        referenceNo,
        title,
        organization,
        location: extractAjkLocation(`${agency} ${department}`, title),
        directUrl,
        publishDate,
        closingDate,
        description: [procType, department, agency].filter(Boolean).join(' | ').slice(0, 350),
        isCorrigendum: isCorrigendum || undefined,
        attachmentUrls
      });
    });

    return { matched: true, items, stopOnEmpty: true, sanitize: true };
  }
};
