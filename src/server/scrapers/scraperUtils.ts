import { PortalDefinition } from './portalList.js';
import { parseDateString } from './dateParser.js';
import { getPktDateKey } from '../../shared/pktDate.js';

export const CLOSED_STATUS_RE = /\b(closed|cancelled|canceled|completed|awarded|archived|expired|dropped)\b/i;

export const AUCTION_TYPE_RE = /\b(?:sales?\s*\/\s*auction|auction|disposal|sales?|sale\s+of\s+scrap)\b/i;

export const AUCTION_TITLE_RE =
  /^(?:auction|disposal|sale)\b|\b(?:open\s+auction|public\s+auction|auction\s+(?:notice|of\b)|auction\s+of\s+toll\s+tax|toll\s+tax\s+auction|sale\s+of\s+(?:scrap|condemned|unserviceable|obsolete|vehicles|trees|fruit|wood)|disposal\s+of\s+(?:scrap|condemned|unserviceable|obsolete|old|surplus|assets))\b/i;

export function isAuctionOrDisposalTender(
  title: string,
  ...typeFields: Array<string | null | undefined>
): boolean {
  if (typeFields.some(f => Boolean(f && AUCTION_TYPE_RE.test(f)))) {
    return true;
  }
  return AUCTION_TITLE_RE.test(title || '');
}

export function resolvePaginationMaxPages(
  portal: PortalDefinition,
  depth: 'quick' | 'deep',
  fallback: number
): number {
  if (!portal.pagination) return fallback;
  return depth === 'deep'
    ? (portal.pagination.deepMaxPages ?? portal.pagination.maxPages)
    : (portal.pagination.quickMaxPages ?? portal.pagination.maxPages);
}

export function normalizeClosingDayKey(val?: string | null): string {
  if (!val) return '';
  const trimmed = val.trim();
  if (!trimmed) return '';
  const isOffsetIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const resolved = isOffsetIso
    ? trimmed
    : (parseDateString(trimmed) || (/^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed : ''));
  if (resolved) {
    return getPktDateKey(resolved) || trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

export interface KnownTenderStopEntry {
  closing_date?: string | null;
  has_corrigendum?: number;
  title?: string | null;
}

export function shouldEarlyStopKnownPage(
  items: Array<{ directUrl?: string | null; title?: string | null; closingDate?: string | null; isCorrigendum?: boolean }>,
  knownMap: Map<string, KnownTenderStopEntry> | null | undefined,
  options?: { threshold?: number; keyMode?: 'url' | 'urlOrTitle' }
): boolean {
  if (!knownMap || knownMap.size === 0 || items.length === 0) return false;
  const threshold = options?.threshold ?? 0.85;
  const keyMode = options?.keyMode ?? 'url';

  let knownUnchanged = 0;
  for (const item of items) {
    const lookupKey =
      keyMode === 'urlOrTitle'
        ? (item.directUrl || item.title || '').toLowerCase()
        : (item.directUrl || '').toLowerCase();
    if (!lookupKey) continue;
    const existing = knownMap.get(lookupKey);
    if (!existing) continue;
    if (item.isCorrigendum && !existing.has_corrigendum) continue;
    if (normalizeClosingDayKey(item.closingDate) === normalizeClosingDayKey(existing.closing_date)) {
      knownUnchanged++;
    }
  }
  return knownUnchanged / items.length >= threshold;
}
