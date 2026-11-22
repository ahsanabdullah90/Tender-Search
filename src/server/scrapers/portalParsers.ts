import { PortalDefinition } from './portalList.js';
import { ScrapeResult } from './parserHelpers.js';
import { parseWithAdapters } from './adapters/registry.js';

export * from './parserHelpers.js';

/**
 * Parses raw HTML string from a portal into structured items or detects verification challenge.
 */
export function parsePortalHtml(html: string, portal: PortalDefinition): ScrapeResult {
  return parseWithAdapters(html, portal);
}
