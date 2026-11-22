import { useEffect, useState } from 'react';
import type { DocumentQueueStatus, Tender } from '../../../shared/types';
import { isDirectDocumentUrl } from '../../../shared/documentUtils';
import { asList } from '../../utils/format';

export function formatCountdown(closingDate: string | null) {
  if (!closingDate) return null;
  const diff = new Date(closingDate).getTime() - Date.now();
  if (Number.isNaN(diff)) return null;
  if (diff <= 0) return 'Closed';
  const s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

export function buildEditForm(t: Tender) {
  return {
    title: t.title || '',
    organization: t.organization || '',
    reference_no: t.reference_no || '',
    closing_date: t.closing_date ? t.closing_date.slice(0, 10) : '',
    estimated_value: t.estimated_value || '',
    direct_url: t.direct_url || '',
    description: t.description || '',
  };
}

export type EditTenderForm = ReturnType<typeof buildEditForm>;

/** Re-renders its caller once per interval and returns the current timestamp cleanly. */
export function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Where a tender's deadline came from, as a badge (docs/13 §4.1). */
export function deadlineProvenance(t: Pick<Tender, 'closing_date' | 'deadline_source' | 'deadline_confidence'>): {
  label: string;
  tone: 'ok' | 'warn' | 'neutral';
  title: string;
} {
  if (!t.closing_date) {
    return { label: 'No deadline · Portal HTML only', tone: 'neutral', title: 'The portal gave no deadline and none was found in the documents.' };
  }
  const fromDocument = t.deadline_source === 'corrigendum_doc' || t.deadline_source === 'primary_doc';
  if (fromDocument && t.deadline_confidence === 'high') {
    return t.deadline_source === 'corrigendum_doc'
      ? { label: 'Verified from corrigendum', tone: 'ok', title: 'Deadline read from the corrigendum document.' }
      : { label: 'Document verified', tone: 'ok', title: 'Deadline read from the official tender document.' };
  }
  if (fromDocument) {
    return { label: 'From document · check', tone: 'warn', title: 'Deadline read from a document, but the reading was not certain. Check before bidding.' };
  }
  if (t.deadline_source === 'manual') {
    return { label: 'Entered manually', tone: 'neutral', title: 'Deadline entered by hand.' };
  }
  return { label: 'Portal listing', tone: 'neutral', title: 'Deadline taken from the portal listing; the documents have not confirmed it.' };
}

/** Turns a stored review_reason ("kind: detail") into a sentence for the operator. */
export function humanReviewReason(reason?: string | null): string {
  if (!reason) return 'Please check this tender.';
  const sep = reason.indexOf(':');
  const kind = sep > 0 ? reason.slice(0, sep) : reason;
  const detail = sep > 0 ? reason.slice(sep + 1).trim() : '';
  switch (kind) {
    case 'deadline_moved_earlier':
      return `A corrigendum moved the deadline earlier (${detail}).`;
    case 'corrigendum_cancelled':
      return 'A corrigendum says this tender was cancelled or withdrawn.';
    case 'uncertain_past_deadline':
      return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
    case 'excluded_terms_in_documents':
      return `The documents mention excluded terms: ${detail}.`;
    default:
      return detail || reason;
  }
}

export interface TenderDocProcessingState {
  kind: 'processing' | 'queued' | 'failed' | 'complete' | 'listing_only';
  savedCount: number;
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  shortLabel: string;
  bannerTitle: string;
  bannerDetail: string;
  tone: 'accent' | 'warn' | 'ok' | 'neutral';
}

export function getTenderDocProcessingState(
  t: Tender,
  docQueue?: DocumentQueueStatus,
  isFetchingLocal: boolean = false
): TenderDocProcessingState {
  const savedCount = asList(t.cached_dossiers).length;
  const processingCount = t.doc_jobs_processing ?? 0;
  const pendingCount = t.doc_jobs_pending ?? 0;
  const failedCount = t.doc_jobs_failed ?? 0;
  const inActiveQueue = Boolean(docQueue?.activeTenderIds?.includes(t.id));
  const isProcessing = Boolean(isFetchingLocal || processingCount > 0 || inActiveQueue);

  if (isProcessing) {
    return {
      kind: 'processing',
      savedCount,
      pendingCount,
      processingCount,
      failedCount,
      shortLabel: savedCount > 0 ? 'Processing more…' : 'Processing…',
      bannerTitle: processingCount > 0 ? `Actively processing ${processingCount} file(s)…` : 'Downloading & extracting documents…',
      bannerDetail: pendingCount > 0
        ? `${pendingCount} additional file(s) queued next.`
        : savedCount > 0
          ? `${savedCount} document(s) already saved; updating metadata and text index.`
          : 'Reading portal documents, dates, and scope right now.',
      tone: 'accent'
    };
  }

  if (pendingCount > 0 || t.doc_fetch_status === 'pending') {
    const q = pendingCount > 0 ? pendingCount : 1;
    return {
      kind: 'queued',
      savedCount,
      pendingCount: q,
      processingCount,
      failedCount,
      shortLabel: savedCount > 0 ? `+${q} queued` : `Queued (${q})`,
      bannerTitle: pendingCount > 0 ? `Queued for processing (${pendingCount} file(s))` : 'Queued for background processing',
      bannerDetail: savedCount > 0
        ? `${savedCount} document(s) saved; remaining file(s) will process automatically or on Fetch Documents.`
        : 'Waiting in the background document queue — click Fetch Documents to pull now.',
      tone: 'accent'
    };
  }

  if (t.doc_fetch_status === 'failed' || t.doc_fetch_status === 'partial' || (savedCount === 0 && failedCount > 0)) {
    return {
      kind: 'failed',
      savedCount,
      pendingCount,
      processingCount,
      failedCount,
      shortLabel: 'Retry docs',
      bannerTitle: t.doc_fetch_status === 'partial' || savedCount > 0
        ? `Partial download (${savedCount} saved, ${failedCount || 1} failed)`
        : 'Document download failed',
      bannerDetail: 'Some portal files could not be downloaded. Click Retry document fetch to try again.',
      tone: 'warn'
    };
  }

  if (savedCount > 0 || t.doc_fetch_status === 'complete') {
    return {
      kind: 'complete',
      savedCount,
      pendingCount,
      processingCount,
      failedCount,
      shortLabel: savedCount > 0 ? `${savedCount} saved` : 'Processed',
      bannerTitle: savedCount > 0
        ? `Processed · ${savedCount} ${savedCount === 1 ? 'document' : 'documents'} saved`
        : 'Processed · Portal checked',
      bannerDetail: savedCount > 0
        ? 'Files downloaded and indexed for deadline and keyword matching.'
        : 'Portal page was checked; no pending document jobs remain.',
      tone: 'ok'
    };
  }

  return {
    kind: 'listing_only',
    savedCount,
    pendingCount,
    processingCount,
    failedCount,
    shortLabel: 'Listing only',
    bannerTitle: 'Portal listing only · No downloadable files provided',
    bannerDetail: 'This notice did not publish PDF/Word attachments on the portal. Click Fetch Documents to re-check or upload a notice manually.',
    tone: 'neutral'
  };
}

/** True when an opened tender has no saved files yet, is not Passed/failed, and has a fetchable attachment or detail page. */
export function hasAutoFetchableDocuments(t: Tender): boolean {
  if (asList(t.cached_dossiers).length > 0) return false;
  if (t.pipeline_status === 'Passed' || t.doc_fetch_status === 'failed') return false;
  const attUrls = asList<string>(t.attachment_urls);
  if (attUrls.some(u => typeof u === 'string' && /^https?:\/\//i.test(u))) return true;
  const directUrl = t.direct_url || '';
  if (isDirectDocumentUrl(directUrl)) return true;
  if (/epms\.ppra\.gov\.pk\/public\/tenders\/tender-details\//i.test(directUrl)) return true;
  if (/fde\.gov\.pk\/download\/[^/?#]+/i.test(directUrl) && !/\/download-category\//i.test(directUrl)) return true;
  return false;
}
