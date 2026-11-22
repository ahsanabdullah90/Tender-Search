import { isImageUrl } from '../../../shared/documentUtils.js';
import { parseDateString, extractDatesFromText } from '../dateParser.js';
import {
  RawScrapedItem,
  resolvePortalUrl,
  isNonBidEvaluationOrPlanTitle,
  extractRefFromText,
  collectRowAttachments,
  extractGbLocation
} from '../parserHelpers.js';
import type { PortalAdapter } from './types.js';

const NON_BID_GB_BADGE_RE =
  /\b(?:final\s+evaluation(?:\s+report)?|technical\s+evaluation(?:\s+report)?|financial\s+evaluation(?:\s+result|\s+report)?|evaluation\s+report|result|cancelled|canceled|postponed|auction|work\s+order|supply\s+order)\b/i;

export const gbppraAdapter: PortalAdapter = {
  portalIds: ['gilgit'],
  parseHtml($, portal) {
    // 3c. Structured GBPPRA & Laravel Job/Procurement Cards (.job-post-item)
    if ($('.job-post-item').length === 0) {
      return { matched: false, items: [] };
    }

    const items: RawScrapedItem[] = [];
    $('.job-post-item').each((_, el) => {
      const badgeText = $(el)
        .find('.badge-wrap .badge')
        .map((__, b) => $(b).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean)
        .join(' | ');
      if (badgeText && NON_BID_GB_BADGE_RE.test(badgeText)) return;

      let refNo: string | undefined;
      const refMatch = $(el).text().match(/\[?(TSE-[\w\d]+)\]?/i);
      if (refMatch) refNo = refMatch[1];

      let title = '';
      $(el).find('.job-post-item-header h2, .job-post-item-header h3, .job-post-item-header h4').each((__, hEl) => {
        const text = $(hEl).text().replace(/\s+/g, ' ').trim();
        if (text && (!refNo || !text.includes(refNo)) && text.length > 5 && !title) {
          title = text;
        }
      });
      if (!title) {
        title = $(el).find('h2, h3, h4').last().text().replace(/\s+/g, ' ').trim();
      }
      if (!title || title.length <= 5) return;

      let organization = portal.name;
      const orgEl = $(el).find('.fa-university').parent();
      if (orgEl.length > 0) {
        const orgText = orgEl.text().replace(/\s+/g, ' ').trim();
        if (orgText && orgText.length > 2) organization = orgText;
      }

      const attachmentUrls = collectRowAttachments($, el, portal);
      $(el).find('a[href*="proc_files"], a[href$=".pdf"]').each((__, aEl) => {
        const href = $(aEl).attr('href');
        if (href) {
          const absUrl = resolvePortalUrl(href, portal);
          if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
        }
      });

      let detailUrl: string | undefined;
      const detailLink = $(el).find('a[href*="/procurementdetails/"], a.btn-primary[href]').first().attr('href');
      if (detailLink) {
        detailUrl = resolvePortalUrl(detailLink, portal);
      }
      const nonImageDoc = attachmentUrls.find(u => !isImageUrl(u));
      const directUrl = detailUrl || nonImageDoc || portal.tendersUrl;

      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const rowText = $(el).text().replace(/\s+/g, ' ').trim();
      const rawSuccessDate = $(el).find('.text-success').first().text().replace(/\s+/g, ' ').trim();
      const rawDangerDate = $(el).find('.text-danger').first().text().replace(/\s+/g, ' ').trim();
      const directPublish = rawSuccessDate ? parseDateString(rawSuccessDate) : null;
      const directClosing = rawDangerDate ? parseDateString(rawDangerDate) : null;
      const fallbackDates = (!directPublish || !directClosing) ? extractDatesFromText(rowText) : { publishDate: null, closingDate: null };
      const publishDate = directPublish || fallbackDates.publishDate;
      const closingDate = directClosing || fallbackDates.closingDate;

      const isCorrigendum =
        /\b(?:corrigendum|addendum)\b/i.test(badgeText) ||
        /\b(?:corrigendum|addendum)\b/i.test(title);

      items.push({
        referenceNo: refNo || extractRefFromText(rowText),
        title,
        organization,
        location: extractGbLocation(organization, title),
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: badgeText,
        isCorrigendum: isCorrigendum || undefined,
        attachmentUrls
      });
    });

    return { matched: true, items, stopOnEmpty: true, sanitize: true };
  }
};
