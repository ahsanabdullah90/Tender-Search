import { isImageUrl, isCorrigendumLabel } from '../../../shared/documentUtils.js';
import { isAuctionOrDisposalTender } from '../scraperUtils.js';
import { parseDateString } from '../dateParser.js';
import {
  RawScrapedItem,
  GENERIC_LINK_LABELS,
  resolvePortalUrl,
  isNonBidEvaluationOrPlanTitle,
  extractRefFromText,
  collectRowAttachments,
  extractPunjabLocation
} from '../parserHelpers.js';
import type { PortalAdapter } from './types.js';

export const punjabEprocAdapter: PortalAdapter = {
  portalIds: ['punjab_eproc'],
  parseHtml($, portal) {
    // 3e. Structured ASP.NET Telerik RadGrid table (Punjab eProc: table.rgMasterTable inside <form id="aspnetForm">)
    const radGridRows = $('table.rgMasterTable tbody > tr.rgRow, table.rgMasterTable tbody > tr.rgAltRow');
    if (radGridRows.length === 0) {
      return { matched: false, items: [] };
    }

    const items: RawScrapedItem[] = [];
    radGridRows.each((_, el) => {
      const tds = $(el).children('td');
      if (tds.length < 6) return;

      const procType = $(tds[0]).text().replace(/\s+/g, ' ').trim();
      const nameCell = $(tds[1]);
      let detailHref: string | undefined;
      nameCell.find('a[href]').each((__, aEl) => {
        const href = $(aEl).attr('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          detailHref = href;
          return false;
        }
      });

      const nameClone = nameCell.clone();
      nameClone.find('a').each((__, aEl) => {
        const aText = $(aEl).text().replace(/\s+/g, ' ').trim();
        if (GENERIC_LINK_LABELS.test(aText)) {
          $(aEl).remove();
        }
      });
      const rawTitle = nameClone
        .text()
        .replace(/\(\s*\)\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!rawTitle) return;

      const typeText = $(tds[2]).text().replace(/\s+/g, ' ').trim();
      const publishDate = parseDateString($(tds[3]).text().trim()) || undefined;
      const closingDate = parseDateString($(tds[4]).text().trim());
      const deptText = $(tds[5]).text().replace(/\s+/g, ' ').trim();
      const statusText = tds.length > 6 ? $(tds[6]).text().replace(/\s+/g, ' ').trim() : '';

      if (isAuctionOrDisposalTender(rawTitle, procType, typeText)) return;

      let title = rawTitle;
      if (deptText && /^(?:tender\s+notice|notice\s+inviting\s+tenders?|invitation\s+(?:for|to)\s+bids?|tender\s+advertisement|procurement\s+notice|short\s+tender\s+notice|nit)$/i.test(rawTitle)) {
        title = `Tender Notice — ${deptText}`;
      } else if (deptText && /^(?:corrigendum|addendum)(?:\s+notice)?$/i.test(rawTitle)) {
        title = `${rawTitle} — ${deptText}`;
      }
      if (!title || title.length <= 5) return;

      const attachmentUrls = collectRowAttachments($, el, portal);
      const detailUrl = detailHref ? resolvePortalUrl(detailHref, portal) : null;
      const nonImageDoc = attachmentUrls.find(u => !isImageUrl(u));
      const directUrl = detailUrl || nonImageDoc || portal.tendersUrl;

      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const isCorrigendum = isCorrigendumLabel(procType) || isCorrigendumLabel(rawTitle);

      const summaryParts = [procType, typeText, statusText].filter(Boolean);

      items.push({
        referenceNo: extractRefFromText(rawTitle),
        title,
        organization: deptText || portal.name,
        location: extractPunjabLocation(deptText, rawTitle),
        directUrl,
        publishDate,
        closingDate,
        description: summaryParts.join(' | ').slice(0, 350),
        isCorrigendum,
        attachmentUrls
      });
    });

    return { matched: true, items, sanitize: true, stopOnEmpty: false };
  }
};
