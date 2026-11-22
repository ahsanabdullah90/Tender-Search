import { scrapeKpPortal } from '../kpApi.js';
import type { PortalAdapter } from './types.js';

export const kppraAdapter: PortalAdapter = {
  portalIds: ['kppra'],
  async scrapeListings(portal, ctx) {
    return scrapeKpPortal(portal, {
      depth: ctx.depth,
      knownMap: ctx.getKnownMap(),
      timeoutMs: ctx.degradedMode ? 45000 : 20000
    });
  }
};
