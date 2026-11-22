import * as cheerio from 'cheerio';
import { ScrapeResult, sanitizeScrapedItems } from '../parserHelpers.js';
import { detectHtmlAccessBlock } from './guards.js';
import { ndmaAdapter, fdeAdapter, psdfAdapter, ungmAdapter } from './agencyAdapters.js';
import { bppraAdapter } from './bppraAdapter.js';
import { gbppraAdapter } from './gbppraAdapter.js';
import { sppraAdapter } from './sppraAdapter.js';
import { punjabEprocAdapter } from './punjabEprocAdapter.js';
import { epmsPpraAdapter } from './epmsPpraAdapter.js';
import { ajkPpraAdapter } from './ajkPpraAdapter.js';
import { kppraAdapter } from './kppraAdapter.js';
import { genericAdapter } from './genericAdapter.js';
import type {
  AdapterDetailContext,
  DetailEnrichmentResult,
  PortalAdapter,
  PortalWithSession
} from './types.js';

export { genericAdapter };

/**
 * Specialized portal adapters ordered by deterministic Section 1..3g HTML selector precedence.
 */
export const PORTAL_ADAPTERS: readonly PortalAdapter[] = [
  ndmaAdapter,
  fdeAdapter,
  psdfAdapter,
  bppraAdapter,
  gbppraAdapter,
  sppraAdapter,
  ungmAdapter,
  punjabEprocAdapter,
  epmsPpraAdapter,
  ajkPpraAdapter,
  kppraAdapter
];

const ADAPTER_BY_PORTAL_ID = new Map<string, PortalAdapter>();
for (const adapter of [...PORTAL_ADAPTERS, genericAdapter]) {
  for (const id of adapter.portalIds) {
    ADAPTER_BY_PORTAL_ID.set(id, adapter);
  }
}

export function getPortalAdapter(portalId: string): PortalAdapter {
  return ADAPTER_BY_PORTAL_ID.get(portalId) ?? genericAdapter;
}

export function getAllPortalAdapters(): readonly PortalAdapter[] {
  return [...PORTAL_ADAPTERS, genericAdapter];
}

/**
 * Runs WAF/login guards followed by ordered deterministic portal HTML parsers with generic fallback.
 */
export function parseWithAdapters(html: string, portal: PortalWithSession): ScrapeResult {
  const $ = cheerio.load(html);

  const blocked = detectHtmlAccessBlock($, html, portal);
  if (blocked) {
    return blocked;
  }

  for (const adapter of PORTAL_ADAPTERS) {
    if (!adapter.parseHtml) continue;
    const res = adapter.parseHtml($, portal);
    if (res.matched && (res.items.length > 0 || res.stopOnEmpty)) {
      return {
        items: res.sanitize ? sanitizeScrapedItems(res.items, portal) : res.items,
        hitlRequired: false
      };
    }
  }

  const genericRes = genericAdapter.parseHtml!($, portal);
  return {
    items: sanitizeScrapedItems(genericRes.items, portal),
    hitlRequired: false
  };
}

/**
 * Delegates portal-specific detail enrichment (SPPRA DMS, BPPRA :9446 API, EPMS detail metadata)
 * to the registered adapter for `ctx.tender.portal_id`, returning `null` for generic HTML portals.
 */
export async function runDetailEnrichment(ctx: AdapterDetailContext): Promise<DetailEnrichmentResult | null> {
  const adapter = getPortalAdapter(ctx.tender.portal_id);
  if (!adapter.enrichDetail) {
    return null;
  }
  return adapter.enrichDetail(ctx);
}
