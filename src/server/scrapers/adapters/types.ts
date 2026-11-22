import type * as cheerio from 'cheerio';
import type { ScanDepth, Tender } from '../../../shared/types.js';
import type { PortalDefinition } from '../portalList.js';
import type { RawScrapedItem, ScrapeResult } from '../parserHelpers.js';
import type { KnownTenderStopEntry } from '../scraperUtils.js';

export type PortalWithSession = PortalDefinition & { sessionCookies?: string };

export interface AdapterScrapeContext {
  depth: ScanDepth;
  degradedMode: boolean;
  usingRealTransport: boolean;
  getKnownMap: () => Map<string, KnownTenderStopEntry> | null;
}

export interface HtmlParseMatchResult {
  matched: boolean;
  items: RawScrapedItem[];
  stopOnEmpty?: boolean;
  sanitize?: boolean;
}

export interface AdapterDetailContext {
  tender: Tender;
  portal: PortalDefinition;
  existingDossierCount: number;
  forceRefresh: boolean;
  fetchHtml: (url: string) => Promise<string>;
}

export type AdapterFieldUpdates = Partial<
  Pick<
    Tender,
    | 'title'
    | 'organization'
    | 'reference_no'
    | 'closing_date'
    | 'closing_date_formatted'
    | 'estimated_value'
    | 'description'
    | 'direct_url'
    | 'location'
    | 'has_corrigendum'
    | 'bid_brief'
  >
>;

export interface DetailEnrichmentResult {
  handled: boolean;
  checked?: boolean;
  fieldUpdates?: AdapterFieldUpdates;
  extractedText?: string;
  discoveredUrls?: string[];
  detailText?: string;
}

export interface PortalTransportConfig {
  degradedTimeoutMs?: number;
  forwardResponseCookiesOnPagination?: boolean;
}

export interface PortalAdapter {
  readonly portalIds: readonly string[];
  scrapeListings?: (portal: PortalWithSession, ctx: AdapterScrapeContext) => Promise<ScrapeResult | null>;
  parseHtml?: ($: cheerio.CheerioAPI, portal: PortalDefinition) => HtmlParseMatchResult;
  transport?: PortalTransportConfig;
  isDetailDiscoveryUrl?: (url: string) => boolean;
  enrichDetail?: (ctx: AdapterDetailContext) => Promise<DetailEnrichmentResult | null>;
}
