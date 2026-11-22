import { isBppraDetailDiscoveryUrl } from '../../domain/detailDiscovery.js';
import {
  scrapeBppraPortal,
  parseBppraHtml,
  extractBppraBidId,
  fetchBppraDetailMetadata
} from '../bppraScraper.js';
import type { AdapterFieldUpdates, PortalAdapter } from './types.js';

export const bppraAdapter: PortalAdapter = {
  portalIds: ['bppra'],
  async scrapeListings(portal, ctx) {
    if (!ctx.usingRealTransport || !portal.tendersUrl.includes('bpptwo.vdc.services')) {
      return null;
    }
    return scrapeBppraPortal(portal, {
      depth: ctx.depth,
      knownMap: ctx.getKnownMap(),
      timeoutMs: ctx.degradedMode ? 45000 : 25000
    });
  },
  parseHtml($, portal) {
    return parseBppraHtml($, portal);
  },
  isDetailDiscoveryUrl: isBppraDetailDiscoveryUrl,
  async enrichDetail(ctx) {
    const { tender } = ctx;
    const bppraBidId =
      extractBppraBidId(tender.direct_url) ??
      (tender.attachment_urls || []).map(u => extractBppraBidId(u)).find((id): id is number => id !== null) ??
      null;

    if (!bppraBidId || !(ctx.forceRefresh || !tender.bid_brief || ctx.existingDossierCount === 0)) {
      return { handled: true, checked: false, discoveredUrls: [] };
    }

    const meta = await fetchBppraDetailMetadata(bppraBidId);
    if (!meta) {
      return { handled: true, checked: true, discoveredUrls: [] };
    }

    const fieldUpdates: AdapterFieldUpdates = {};
    if (ctx.forceRefresh || !tender.bid_brief) {
      fieldUpdates.bid_brief = meta.bidBrief;
    }
    if (meta.isCorrigendum && !tender.has_corrigendum) {
      fieldUpdates.has_corrigendum = 1;
    }

    return {
      handled: true,
      checked: true,
      fieldUpdates: Object.keys(fieldUpdates).length > 0 ? fieldUpdates : undefined,
      extractedText: meta.extractedText || undefined,
      discoveredUrls: meta.boqPdfUrl ? [meta.boqPdfUrl] : [],
      detailText: meta.extractedText || undefined
    };
  }
};
