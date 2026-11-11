/**
 * Captures a sanitized HTML fixture of a portal's tender listing for the portal contract tests
 * (docs/13-ingestion-pipeline-plan.md, §4.2).
 *
 *   npx tsx scripts/capture-portal-fixture.ts <portalId> [<portalId> ...]
 *
 * For each portal: fetches its tenders page once (same HTTP client as a scan), strips scripts,
 * styles, hidden form state, emails, phone numbers, CNICs, session tokens and honorific-prefixed
 * names, trims long lists to keep the file ≤ 50 KB, and writes:
 *   tests/fixtures/portals/<id>/page.html
 *   tests/fixtures/portals/<id>/expected.json   (what the parser found at capture time)
 * Run with TENDER_DATA_DIR pointing at a scratch folder so the live database is never touched.
 */
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { PORTAL_DEFINITIONS } from '../src/server/scrapers/portalList.js';
import { fetchHtmlWithTolerantAgent, parsePortalHtml } from '../src/server/scrapers/crawlerEngine.js';

const MAX_BYTES = 50 * 1024;
const MAX_ROWS = 25;
const ROOT = path.resolve(process.cwd(), 'tests', 'fixtures', 'portals');

/**
 * Shrinks a page to MAX_BYTES by repeatedly removing the largest element that contains none of
 * the tender links the parser found (so the listing itself always survives).
 */
function shrinkKeepingListings(html: string, keepUrls: string[]): string {
  const $ = cheerio.load(html);
  const keep = keepUrls.map(u => {
    try { return new URL(u).pathname + new URL(u).search; } catch { return u; }
  }).filter(Boolean);
  const containsKeep = (el: any) => {
    const h = $.html(el);
    return keep.some(k => h.includes(k) || h.includes(k.replace(/&/g, '&amp;')));
  };
  $('header, footer, nav, aside, form').each((_, el) => { if (!containsKeep(el)) $(el).remove(); });
  $('.inner-advertisement-listing-box, .dropdown-content a, tr, li, section, .elementor-section').each((_, el) => {
    if (!containsKeep(el)) $(el).remove();
  });

  for (let guard = 0; guard < 400 && Buffer.byteLength($.html()) > MAX_BYTES; guard++) {
    let biggest: any = null;
    let biggestSize = 0;
    $('body *').each((_, el) => {
      const size = $.html(el).length;
      if (size > biggestSize && size < $.html().length * 0.95 && !containsKeep(el)) {
        biggest = el;
        biggestSize = size;
      }
    });
    if (!biggest || biggestSize < 200) break;
    $(biggest).remove();
  }
  let out = $.html().replace(/\s{2,}/g, ' ');
  if (Buffer.byteLength(out) > MAX_BYTES) {
    $('*').each((_, el) => {
      const cls = $(el).attr('class') || '';
      const keepClasses = cls
        .split(/\s+/)
        .filter(c => /inner-advertisement-listing-box|listingadver-title1|dropdown-content|tender|package|card|wpdm/i.test(c));
      if (keepClasses.length > 0) $(el).attr('class', keepClasses.join(' '));
      else $(el).removeAttr('class');
    });
    out = $.html().replace(/\s{2,}/g, ' ');
  }
  return out;
}

export function sanitizeHtml(html: string, baseUrl: string, keepUrls: string[] = []): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, link, meta, template, canvas, video, audio, object, embed').remove();
  $('input[type="hidden"]').remove();
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.startsWith('data:')) $(el).attr('src', '');
    $(el).removeAttr('srcset');
  });
  $('*').each((_, el) => {
    for (const attr of Object.keys((el as any).attribs || {})) {
      if (/^on/i.test(attr) || attr === 'style' || /^data-(?!wpdm)/i.test(attr)) $(el).removeAttr(attr);
    }
  });
  // Keep listings representative but small.
  $('table').each((_, t) => {
    $(t).find('tr').slice(MAX_ROWS + 1).remove();
  });
  $('ul, ol').each((_, l) => {
    $(l).children('li').slice(MAX_ROWS).remove();
  });

  let out = $.html();
  out = out
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'redacted@example.com')
    .replace(/\b\d{5}-\d{7}-\d\b/g, '00000-0000000-0')
    .replace(/(?:\+92[\s-]?|\b0)\d{2,4}[\s-]?\d{6,8}\b/g, '000-0000000')
    .replace(/\(\s*0\d{2,4}\s*\)\s*\d{6,8}/g, '(000) 0000000')
    .replace(/\b(Mr|Mrs|Ms|Miss|Engr|Dr|Syed|Sardar|Malik|Ch|President|Prime\s+Minister|Federal\s+Minister(?:\s+for\s+[A-Za-z]+)?|Minister(?:\s+for\s+[A-Za-z]+|\s+of\s+State)?|Chairman|Director(?:\s+General)?|Secretary|Ambassador|Datuk\s+Seri)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4}/g, '$1 [name]')
    .replace(/([?&](?:sid|session|sessionid|token|auth|key|jsessionid|phpsessid|ticket)=)[^&"'\s]+/gi, '$1REDACTED')
    .replace(/(__VIEWSTATE|__EVENTVALIDATION|__VIEWSTATEGENERATOR)[^>]*>/g, '');

  if (Buffer.byteLength(out) > MAX_BYTES) out = shrinkKeepingListings(out, keepUrls);
  return `<!-- Captured from ${baseUrl} on ${new Date().toISOString().slice(0, 10)}; sanitized by scripts/capture-portal-fixture.ts -->\n${out}`;
}

async function capture(portalId: string) {
  const portal = PORTAL_DEFINITIONS.find(p => p.id === portalId);
  if (!portal) throw new Error(`Unknown portal: ${portalId}`);
  const raw = await fetchHtmlWithTolerantAgent(portal.tendersUrl);
  const rawResult = parsePortalHtml(raw, portal);
  // Keep at most MAX_ROWS listings, and every link the parser used for them.
  const keepUrls = rawResult.items.slice(0, MAX_ROWS).flatMap(i => [i.directUrl, ...(i.attachmentUrls || [])]);
  const clean = sanitizeHtml(raw, portal.tendersUrl, keepUrls);
  const result = parsePortalHtml(clean, portal);
  const dir = path.join(ROOT, portalId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'page.html'), clean, 'utf8');
  const expected = {
    portalId,
    url: portal.tendersUrl,
    capturedAt: new Date().toISOString().slice(0, 10),
    items: result.items.length,
    /** Items the parser found on the live page before sanitizing (0 = parser gap, not a fixture problem). */
    rawItems: rawResult.items.length,
    hitlRequired: result.hitlRequired,
    withClosingDate: result.items.filter(i => i.closingDate).length,
    withAttachments: result.items.filter(i => (i.attachmentUrls || []).length > 0 || /\.(pdf|docx?|jpe?g|png)(\?|$)|wpdmdl=/i.test(i.directUrl)).length
  };
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  return { bytes: Buffer.byteLength(clean), ...expected };
}

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('Usage: npx tsx scripts/capture-portal-fixture.ts <portalId> [...]');
  process.exit(1);
}
for (const id of ids) {
  try {
    console.log(JSON.stringify(await capture(id)));
  } catch (err: any) {
    console.log(JSON.stringify({ portalId: id, error: err?.message || String(err) }));
  }
}
