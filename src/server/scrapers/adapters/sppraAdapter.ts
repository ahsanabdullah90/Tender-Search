import { extractSppraPublishedDocId, fetchSppraPublishedDocuments } from '../../services/sppraClient.js';
import { scrapeSppraPortal } from '../sppraApi.js';
import { extractDatesFromText, normalizeExtractedDate } from '../dateParser.js';
import {
  RawScrapedItem,
  cleanRowSummary,
  collectRowAttachments
} from '../parserHelpers.js';
import type { PortalAdapter } from './types.js';

export const sppraAdapter: PortalAdapter = {
  portalIds: ['sppra'],
  async scrapeListings(portal, ctx) {
    return scrapeSppraPortal(portal, {
      depth: ctx.depth,
      knownMap: ctx.getKnownMap(),
      timeoutMs: ctx.degradedMode ? 45000 : 20000
    });
  },
  parseHtml($, portal) {
    // 3d. Structured Sindh SPPRA EPADS Angular Cards (section.card with EPADS-S-... tender numbers)
    const spCards = $('section.card').filter((_, el) => /EPADS-S-\d+/i.test($(el).text()));
    if (spCards.length === 0) {
      return { matched: false, items: [] };
    }

    const items: RawScrapedItem[] = [];
    spCards.each((_, el) => {
      const card = $(el);
      const cardText = card.text().replace(/\s+/g, ' ').trim();
      if (/Status:\s*(Closed|Cancelled|Completed|Awarded)/i.test(cardText)) return;

      const headings = card.find('h6').map((__, h) => $(h).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
      const refNo = headings.find(h => /^EPADS-S-\d+/i.test(h)) || cardText.match(/\b(EPADS-S-\d+)\b/i)?.[1];
      const title = headings.find(h => !/^EPADS-S-\d+/i.test(h) && !/^Department Name:/i.test(h) && h.length > 5) || '';
      if (!title) return;

      const deptMatch = cardText.match(/Department Name:\s*([^\n]+?)(?=\s+Status:|\s+Published Date:|$)/i);
      const organization = deptMatch?.[1]?.trim() || portal.name;
      const locMatch = cardText.match(/Location:\s*([^\n]+?)(?=\s+Published Date:|\s+View\/Download|$)/i);
      const rawLoc = locMatch?.[1]?.trim();
      const location = rawLoc ? (/sindh/i.test(rawLoc) ? rawLoc : `${rawLoc}, Sindh`) : 'Sindh, Pakistan';

      const pubMatch = cardText.match(/Published Date:\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}\s*[AP]M)?)/i);
      const closeMatch = cardText.match(/Closing Date:\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}\s*[AP]M)?)/i);
      const { publishDate: fallbackPub, closingDate: fallbackClose } = extractDatesFromText(cardText);
      const publishDate = (pubMatch ? normalizeExtractedDate(pubMatch[1]) : undefined) || fallbackPub || undefined;
      const closingDate = (closeMatch ? normalizeExtractedDate(closeMatch[1]) : undefined) || fallbackClose;

      const directUrl = refNo
        ? `${portal.baseUrl.replace(/\/$/, '')}/#/?tender=${encodeURIComponent(refNo)}`
        : portal.tendersUrl;

      items.push({
        referenceNo: refNo,
        title,
        organization,
        location,
        directUrl,
        publishDate,
        closingDate,
        description: cleanRowSummary(cardText, title, card),
        attachmentUrls: collectRowAttachments($, el, portal)
      });
    });

    return { matched: true, items, stopOnEmpty: false, sanitize: false };
  },
  async enrichDetail(ctx) {
    const spPublishedDocId = extractSppraPublishedDocId(ctx.tender.direct_url);
    if (!spPublishedDocId || !(ctx.existingDossierCount < 2 || ctx.forceRefresh)) {
      return { handled: true, checked: false, discoveredUrls: [] };
    }
    const discoveredUrls = await fetchSppraPublishedDocuments(spPublishedDocId);
    return { handled: true, checked: true, discoveredUrls };
  }
};
