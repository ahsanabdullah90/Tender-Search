/**
 * Pure, dependency-free URL, text, and classification helpers shared across
 * shared/server/client layers without introducing import cycles.
 */

export const IMAGE_URL_RE = /\.(jpe?g|png|webp)(\?|$)/i;
export const CORRIGENDUM_TEXT_RE = /(corrigend(?:um|a)?|amendment|addend(?:um|a)|errat(?:um|a)?|date[\s_-]*extension|(?:^|[^a-z0-9])corr\.?(?:[^a-z0-9]|$)|corri\d+)/i;
export const GENERIC_DOSSIER_LABEL_RE = /^(?:bidding document|tender document|document|notice|tender notice|tender notice image)(?:\s+\d+)?$/i;

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isImageUrl(url?: string | null): boolean {
  return Boolean(url && IMAGE_URL_RE.test(url));
}

export function isDirectDocumentUrl(url?: string | null): boolean {
  return Boolean(url && (/\.(pdf|docx?|xlsx?|jpe?g|png|webp)(\?|$)/i.test(url) || /[?&]wpdmdl=\d+/i.test(url)));
}

export function isDownloadableCandidateUrl(url?: string | null): boolean {
  return Boolean(
    url && (!/\.(html?|aspx?|php|jsp)(\?|$)/i.test(url) || /[?&]wpdmdl=\d+/i.test(url) || /\/pdf\?file=/i.test(url))
  );
}

export function isCorrigendumLabel(text?: string | null): boolean {
  return Boolean(text && CORRIGENDUM_TEXT_RE.test(text));
}

export function isGenericDossierLabel(label?: string | null): boolean {
  const trimmed = label?.trim() || '';
  if (!trimmed) return true;
  if (/_Doc(\s+\d+)?$/i.test(trimmed)) return true;
  return GENERIC_DOSSIER_LABEL_RE.test(trimmed);
}

export function sanitizeOriginUrl(url?: string | null, fallback?: string): string {
  if (typeof url === 'string' && url.trim()) {
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {}
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    try {
      const fb = new URL(fallback.trim());
      if (fb.protocol === 'http:' || fb.protocol === 'https:') {
        return fb.origin;
      }
    } catch {}
    return fallback.trim();
  }
  return '';
}

export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
