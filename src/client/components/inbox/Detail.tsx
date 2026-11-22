import React, { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  Check,
  Copy,
  Download,
  ExternalLink,
  Pencil,
  RotateCw,
  Sparkles,
  Trash2,
  TriangleAlert
} from 'lucide-react';
import { Tender, CorrigendumLog, DocumentQueueStatus } from '../../../shared/types';
import { Button, Chip, FIELD_INPUT_CLASS } from '../../ui';
import { apiMutate } from '../../utils/apiClient';
import { asList, fileToBase64 } from '../../utils/format';
import { DeleteTenderModal } from './DeleteTenderModal';
import {
  buildEditForm,
  deadlineProvenance,
  formatCountdown,
  getTenderDocProcessingState,
  hasAutoFetchableDocuments,
  humanReviewReason,
  useTick
} from './detailHelpers';
import { DossierSection } from './DossierSection';
import { HighlightedDescription } from './HighlightedDescription';

export { asList };
export { useTick, deadlineProvenance, humanReviewReason, getTenderDocProcessingState };

function LiveCountdown({ closingDate }: { closingDate: string | null }) {
  useTick(1000);
  const countdown = formatCountdown(closingDate);
  if (!countdown) return null;
  const urgent = closingDate ? new Date(closingDate).getTime() - Date.now() < 86_400_000 : false;
  return (
    <div>
      <div className="text-xs text-ink-muted">Time left</div>
      <div className={`font-mono text-sm font-semibold ${urgent ? 'text-danger' : ''}`}>{countdown}</div>
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-muted">{children}</h3>;
}


interface DetailProps {
  tender: Tender;
  corrigenda: CorrigendumLog[];
  docQueue?: DocumentQueueStatus;
  onTrack?: () => void;
  onPass?: () => void;
  stageActions?: React.ReactNode;
  onSetResultDate?: (date: string | null) => void;
  onAcknowledgeCorrigendum: (logId: string) => Promise<void>;
  onSaveNotes: (tenderId: string, notes: string) => Promise<void>;
  onToggleBookmark: () => void;
  onTenderUpdated?: (tender: Tender) => void;
  onTenderDeleted?: (tenderId: string) => void;
}

/** Detail Pane exported for both Inbox and Pipeline */
export function Detail({
  tender,
  corrigenda,
  docQueue,
  onTrack,
  onPass,
  stageActions,
  onSetResultDate,
  onAcknowledgeCorrigendum,
  onSaveNotes,
  onToggleBookmark,
  onTenderUpdated,
  onTenderDeleted,
}: DetailProps) {
  const [currentTender, setCurrentTender] = useState<Tender>(tender);
  const [notes, setNotes] = useState(tender.status_notes || '');
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const lastSavedNotesRef = useRef(tender.status_notes || '');
  const hasPendingNotesRef = useRef(false);
  const prevTenderIdRef = useRef<string>(tender.id);
  const autoFetchedIdsRef = useRef<Set<string>>(new Set());
  const onSaveNotesRef = useRef(onSaveNotes);
  onSaveNotesRef.current = onSaveNotes;
  const onTenderDeletedRef = useRef(onTenderDeleted);
  onTenderDeletedRef.current = onTenderDeleted;
  const onTenderUpdatedRef = useRef(onTenderUpdated);
  onTenderUpdatedRef.current = onTenderUpdated;
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchingDocs, setFetchingDocs] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [aiStatusMessage, setAiStatusMessage] = useState<{ text: string; isError?: boolean } | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  const [editForm, setEditForm] = useState(() => buildEditForm(tender));

  useEffect(() => {
    setCurrentTender(tender);
    if (prevTenderIdRef.current !== tender.id) {
      if (hasPendingNotesRef.current && notesRef.current !== lastSavedNotesRef.current) {
        hasPendingNotesRef.current = false;
        void Promise.resolve(onSaveNotesRef.current(prevTenderIdRef.current, notesRef.current)).catch(() => {});
      }
      prevTenderIdRef.current = tender.id;
      hasPendingNotesRef.current = false;
      setNotes(tender.status_notes || '');
      lastSavedNotesRef.current = tender.status_notes || '';
      setNoteState('idle');
      setAiStatusMessage(null);
      setEditingDetails(false);
      setCopiedSummary(false);
      setEditForm(buildEditForm(tender));
    } else if (notesRef.current === lastSavedNotesRef.current) {
      // Same tender refreshed via SSE: preserve unsaved operator notes while keeping clean sync
      setNotes(tender.status_notes || '');
      lastSavedNotesRef.current = tender.status_notes || '';
    }
  }, [tender]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (hasPendingNotesRef.current && notesRef.current !== lastSavedNotesRef.current) {
        hasPendingNotesRef.current = false;
        void Promise.resolve(onSaveNotesRef.current(prevTenderIdRef.current, notesRef.current)).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!hasAutoFetchableDocuments(tender) || autoFetchedIdsRef.current.has(tender.id)) {
      return;
    }
    autoFetchedIdsRef.current.add(tender.id);
    const controller = new AbortController();
    setFetchingDocs(true);

    void fetch(`/api/tenders/${tender.id}/fetch-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceRefresh: false }),
      signal: controller.signal
    })
      .then(async res => {
        if (!res.ok || controller.signal.aborted) return;
        const data = await res.json();
        if (controller.signal.aborted) return;
        if (data.expired) {
          setAiStatusMessage({ text: data.message || 'Deadline has passed: tender removed from the Inbox.' });
          onTenderDeletedRef.current?.(tender.id);
        } else if (data.tender) {
          setCurrentTender(data.tender);
          onTenderUpdatedRef.current?.(data.tender);
        }
      })
      .catch(() => {
        // Best-effort auto-fetch on view; operator can still retry via Fetch Documents
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setFetchingDocs(false);
        }
      });

    return () => {
      controller.abort();
      setFetchingDocs(false);
    };
  }, [tender.id]);

  const keywords = asList<string>(currentTender.matched_keywords);
  const files = asList<{ label?: string; localPath: string; mimeType?: string; docType?: string; sizeBytes?: number }>(currentTender.cached_dossiers);
  const otherSources = asList<{ portalName: string; directUrl: string }>(currentTender.secondary_sources);
  const amendments = corrigenda.filter(c => c.tender_id === currentTender.id);

  const saveNotes = async (notesToSave: string = notes) => {
    hasPendingNotesRef.current = false;
    if (notesToSave === lastSavedNotesRef.current) return;
    setNoteState('saving');
    try {
      await onSaveNotesRef.current(currentTender.id, notesToSave);
      lastSavedNotesRef.current = notesToSave;
      setNoteState('saved');
    } catch {
      setNoteState('failed');
    }
  };

  useEffect(() => {
    if (notes === lastSavedNotesRef.current) return;
    const targetId = currentTender.id;
    const pendingValue = notes;
    const timer = setTimeout(() => {
      hasPendingNotesRef.current = false;
      void (async () => {
        if (pendingValue === lastSavedNotesRef.current) return;
        setNoteState('saving');
        try {
          await onSaveNotesRef.current(targetId, pendingValue);
          if (prevTenderIdRef.current === targetId) {
            lastSavedNotesRef.current = pendingValue;
            setNoteState('saved');
          }
        } catch {
          if (prevTenderIdRef.current === targetId) {
            setNoteState('failed');
          }
        }
      })();
    }, 700);
    return () => clearTimeout(timer);
  }, [notes, currentTender.id]);

  const handleTrackClick = () => {
    if (notes !== lastSavedNotesRef.current) {
      void saveNotes(notes);
    }
    onTrack?.();
  };

  const handlePassClick = () => {
    if (notes !== lastSavedNotesRef.current) {
      void saveNotes(notes);
    }
    onPass?.();
  };

  const handleCopySummary = async () => {
    const formattedCloses =
      currentTender.closing_date && currentTender.closing_date_formatted && currentTender.closing_date_formatted !== 'Not Available'
        ? currentTender.closing_date_formatted
        : 'No deadline stated';
    const summaryLines = [
      `📋 ${currentTender.title}`,
      `🏛 Organization: ${currentTender.organization}`,
      `🔖 Ref No: ${currentTender.reference_no || 'N/A'}`,
      `⏰ Closes: ${formattedCloses}`,
      currentTender.estimated_value ? `💰 Estimated Value: ${currentTender.estimated_value}` : null,
      `🌐 Portal: ${currentTender.portal_name}`,
      currentTender.direct_url && currentTender.direct_url !== '#' ? `🔗 Link: ${currentTender.direct_url}` : null,
    ].filter(Boolean).join('\n');

    try {
      await navigator.clipboard?.writeText(summaryLines);
      setCopiedSummary(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedSummary(false);
      }, 2000);
    } catch {}
  };

  // The server auto-expired (deleted) this tender because its deadline has passed:
  // drop it from the list instead of leaving a ghost row the operator can still act on.
  const handleTenderExpired = (message?: string) => {
    setAiStatusMessage({ text: message || 'Deadline has passed: tender removed from the Inbox.' });
    onTenderDeleted?.(currentTender.id);
  };

  type TenderMutationPayload = {
    expired?: boolean;
    tender?: Tender;
    message?: string;
    newlyFetched?: number;
    aiExtracted?: boolean;
    error?: string;
  };

  const readMutationError = (err: unknown, apiFallback: string, networkFallback = apiFallback): string => {
    const data = (err as { data?: { error?: string; message?: string } } | null)?.data;
    if (data !== undefined) {
      return data?.error || data?.message || apiFallback;
    }
    return networkFallback;
  };

  const runTenderPostAction = async (
    endpoint: string,
    setBusy: (busy: boolean) => void,
    successText: (data: TenderMutationPayload) => string,
    apiFallback: string,
    networkFallback = apiFallback,
  ) => {
    setBusy(true);
    setAiStatusMessage(null);
    try {
      const data = await apiMutate<TenderMutationPayload>(
        `/api/tenders/${currentTender.id}/${endpoint}`,
        'POST'
      );
      if (data.expired) {
        handleTenderExpired(data.message);
      } else if (data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setAiStatusMessage({ text: successText(data) });
      } else {
        setAiStatusMessage({ text: data.error || apiFallback, isError: true });
      }
    } catch (err) {
      setAiStatusMessage({ text: readMutationError(err, apiFallback, networkFallback), isError: true });
    } finally {
      setBusy(false);
    }
  };

  const handleFetchDocuments = () =>
    runTenderPostAction(
      'fetch-documents',
      setFetchingDocs,
      data => data.message || `Fetched ${data.newlyFetched} document(s) from portal.`,
      'Failed to fetch documents from portal.',
      'Error connecting to document fetch service.'
    );

  const handleAnalyzeWithAi = () =>
    runTenderPostAction(
      'analyze',
      setAnalyzing,
      data => data.message || 'Tender summary extracted with AI.',
      'Could not analyze tender with AI.',
      'Failed to reach AI extraction service.'
    );

  const handleRefreshTender = () =>
    runTenderPostAction(
      'refresh',
      setRefreshing,
      data => data.message || 'Tender information refreshed from portal.',
      'Could not refresh tender from portal.',
      'Failed to refresh tender from portal.'
    );

  const handleFileUpload = async (file: File) => {
    setUploadingFile(true);
    setAiStatusMessage(null);
    try {
      const dataBase64 = await fileToBase64(file);
      const data = await apiMutate<TenderMutationPayload>(
        `/api/tenders/${currentTender.id}/attachments`,
        'POST',
        {
          filename: file.name,
          mimeType: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
          dataBase64,
          label: file.name,
          runAi: true,
        }
      );
      if (data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setAiStatusMessage({
          text: data.aiExtracted
            ? 'Tender file saved and summarized with Google AI.'
            : 'Tender file saved to dossier.',
        });
      } else {
        setAiStatusMessage({ text: data.error || 'Failed to upload file.', isError: true });
      }
    } catch (err) {
      setAiStatusMessage({ text: readMutationError(err, 'Failed to upload file.'), isError: true });
    } finally {
      setUploadingFile(false);
    }
  };

  const handleSaveDetails = async () => {
    setSavingDetails(true);
    setAiStatusMessage(null);
    try {
      const data = await apiMutate<TenderMutationPayload>(`/api/tenders/${currentTender.id}`, 'PATCH', {
        title: editForm.title,
        organization: editForm.organization,
        reference_no: editForm.reference_no,
        closing_date: editForm.closing_date || null,
        estimated_value: editForm.estimated_value || null,
        direct_url: editForm.direct_url,
        description: editForm.description,
      });
      if (data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setEditingDetails(false);
        setAiStatusMessage({ text: 'Tender details updated.' });
      } else {
        setAiStatusMessage({ text: data.error || 'Could not save details.', isError: true });
      }
    } catch (err) {
      setAiStatusMessage({ text: readMutationError(err, 'Could not save details.'), isError: true });
    } finally {
      setSavingDetails(false);
    }
  };

  const [reviewBusy, setReviewBusy] = useState(false);
  const [retryingDocs, setRetryingDocs] = useState(false);

  const handleConfirmReview = async () => {
    setReviewBusy(true);
    try {
      const data = await apiMutate<TenderMutationPayload>(`/api/tenders/${currentTender.id}/review`, 'PATCH', {
        action: 'confirm',
      });
      if (data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setAiStatusMessage({ text: 'Review confirmed.' });
      } else {
        setAiStatusMessage({ text: data.error || 'Could not confirm review.', isError: true });
      }
    } catch (err) {
      setAiStatusMessage({ text: readMutationError(err, 'Could not confirm review.'), isError: true });
    } finally {
      setReviewBusy(false);
    }
  };

  const handleRetryDocuments = async () => {
    setRetryingDocs(true);
    try {
      const data = await apiMutate<TenderMutationPayload>(
        `/api/tenders/${currentTender.id}/retry-documents`,
        'POST'
      );
      if (data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setAiStatusMessage({ text: data.message || 'Retrying document download.' });
      } else {
        setAiStatusMessage({ text: data.error || 'Could not retry documents.', isError: true });
      }
    } catch (err) {
      setAiStatusMessage({ text: readMutationError(err, 'Could not retry documents.'), isError: true });
    } finally {
      setRetryingDocs(false);
    }
  };

  const provenance = deadlineProvenance(currentTender);
  const docState = getTenderDocProcessingState(currentTender, docQueue, fetchingDocs);

  const confirmDeleteTender = async (tenderId: string) => {
    try {
      await apiMutate(`/api/tenders/${tenderId}`, 'DELETE');
    } catch (err) {
      throw new Error(readMutationError(err, 'Failed to delete tender'));
    }
    onTenderDeleted?.(tenderId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-6">
        {Boolean(currentTender.needs_review) && (
          <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            <span className="font-semibold">Review: {humanReviewReason(currentTender.review_reason)}</span>
            <span className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => void handleConfirmReview()} disabled={reviewBusy}>
                {reviewBusy ? 'Confirming…' : 'Confirm'}
              </Button>
              {onPass && (
                <Button
                  variant={currentTender.review_reason?.startsWith('corrigendum_cancelled') ? 'danger' : 'ghost'}
                  size="sm"
                  onClick={handlePassClick}
                >
                  {currentTender.review_reason?.startsWith('corrigendum_cancelled') ? 'Pass as cancelled' : 'Pass'}
                </Button>
              )}
            </span>
          </div>
        )}
        <div className="text-[13px] text-ink-muted">
          {currentTender.portal_name} · <span className="font-mono">{currentTender.reference_no || 'No reference'}</span>
          {currentTender.location && <> · {currentTender.location}</>}
        </div>
        <h2 className="mt-1 text-lg font-bold leading-snug">{currentTender.title}</h2>
        <div className="mt-1 text-sm text-ink-muted">{currentTender.organization}</div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-xs text-ink-muted">Closes</div>
            <div className="text-sm font-semibold">
              {currentTender.closing_date
                ? currentTender.closing_date_formatted && currentTender.closing_date_formatted !== 'Not Available'
                  ? currentTender.closing_date_formatted
                  : new Date(currentTender.closing_date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
                : 'No deadline stated'}
            </div>
            <div className="mt-1">
              <span title={provenance.title} data-testid="deadline-provenance">
                <Chip tone={provenance.tone}>{provenance.label}</Chip>
              </span>
            </div>
          </div>
          <LiveCountdown closingDate={currentTender.closing_date} />
          {onSetResultDate && (
            <label>
              <div className="text-xs text-ink-muted">Result expected</div>
              <input
                type="date"
                value={currentTender.result_expected_date?.slice(0, 10) ?? ''}
                onChange={e => onSetResultDate(e.target.value || null)}
                className="h-8 rounded-lg border border-line bg-surface px-2 font-mono text-sm"
              />
            </label>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {stageActions ?? (
            <>
              <Button variant="primary" onClick={handleTrackClick}>Track this bid</Button>
              <Button onClick={handlePassClick}>Pass</Button>
            </>
          )}
          <Button
            variant="ghost"
            onClick={onToggleBookmark}
            aria-pressed={Boolean(currentTender.is_bookmarked)}
            aria-label={currentTender.is_bookmarked ? 'Remove bookmark' : 'Bookmark'}
            className="px-3"
          >
            <Bookmark className={`h-4 w-4 ${currentTender.is_bookmarked ? 'fill-current text-accent' : ''}`} />
          </Button>

          {/* Fetch Documents action */}
          <Button
            variant="secondary"
            onClick={handleFetchDocuments}
            disabled={fetchingDocs}
            className="gap-1.5"
            title="Download or refresh documents from this portal now"
          >
            <Download aria-hidden="true" className={`h-4 w-4 ${fetchingDocs ? 'motion-safe:animate-bounce text-accent' : ''}`} />
            {fetchingDocs ? 'Fetching docs…' : 'Fetch Documents'}
          </Button>

          {docState.kind === 'processing' && !fetchingDocs && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
              <RotateCw aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" /> {docState.bannerTitle}
            </span>
          )}
          {docState.kind === 'queued' && !fetchingDocs && (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
              <RotateCw aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" /> Fetching documents in the background…
            </span>
          )}
          {(currentTender.doc_fetch_status === 'failed' || currentTender.doc_fetch_status === 'partial') && (
            <Button
              variant="ghost"
              onClick={() => void handleRetryDocuments()}
              disabled={retryingDocs}
              className="text-warn"
              title="Some documents could not be downloaded from the portal. Try again."
            >
              <RotateCw className={`h-4 w-4 ${retryingDocs ? 'animate-spin' : ''}`} />
              {retryingDocs ? 'Retrying…' : 'Retry document fetch'}
            </Button>
          )}

          <Button
            variant="ghost"
            onClick={() => void handleRefreshTender()}
            disabled={refreshing}
            aria-label="Refresh info"
            title="Re-query portal and refresh tender info with AI"
          >
            <RotateCw className={`h-4 w-4 ${refreshing ? 'animate-spin text-accent' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh info'}
          </Button>

          <Button
            variant="ghost"
            onClick={() => void handleCopySummary()}
            aria-label="Copy summary"
            title="Copy formatted tender brief to clipboard"
          >
            {copiedSummary ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}
            {copiedSummary ? 'Copied!' : 'Copy summary'}
          </Button>

          {/* Delete Tender button */}
          <Button
            variant="ghost"
            onClick={() => setDeleteModalOpen(true)}
            className="text-ink-muted hover:text-danger hover:bg-danger-soft px-2.5"
            title="Permanently delete this tender and its dossier files"
          >
            <Trash2 className="h-4 w-4" />
          </Button>

          <a
            href={currentTender.direct_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-accent hover:bg-accent-soft"
          >
            Open on portal <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        {aiStatusMessage && (
          <div
            role="status"
            className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium ${
              aiStatusMessage.isError ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent'
            }`}
          >
            <span>{aiStatusMessage.text}</span>
            <button onClick={() => setAiStatusMessage(null)} className="ml-3 cursor-pointer font-semibold underline">
              Dismiss
            </button>
          </div>
        )}

        {amendments.length > 0 && (
          <div className="rounded-xl bg-warn-soft p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-warn">
              <TriangleAlert className="h-4 w-4" /> This tender was amended
            </div>
            <div className="space-y-2">
              {amendments.map(log => (
                <div key={log.id} className="flex items-start justify-between gap-3 rounded-lg bg-surface p-3 text-[13px]">
                  <div>
                    <div className="font-semibold capitalize">{log.change_type.replace(/_/g, ' ')}</div>
                    <div className="mt-0.5 text-ink-muted">
                      {log.previous_value && <>Was: {log.previous_value} → </>}
                      <span className="font-medium text-ink">Now: {log.new_value}</span>
                    </div>
                  </div>
                  {!log.is_acknowledged && (
                    <Button size="sm" onClick={() => onAcknowledgeCorrigendum(log.id)}>Got it</Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Fact Strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Fact label="Estimated value" value={currentTender.estimated_value || 'Not disclosed'} mono />
          <Fact label="Published" value={currentTender.publish_date ? new Date(currentTender.publish_date).toLocaleDateString('en-GB') : 'Not stated'} mono />
          <Fact label="Match" value={`${currentTender.match_score || 0}%`} mono />
        </div>

        <div>
          <SectionTitle>Why it matched</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {asList<string>(currentTender.domain_tracks).map(t => <Chip key={t} tone="accent">{t}</Chip>)}
            {keywords.map(k => <Chip key={k}>{k}</Chip>)}
          </div>
        </div>

        {/* Scope / Summary Section with Keyword Highlighting */}
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted">Summary</h3>
            <div className="flex items-center gap-1.5">
              <Button size="sm" onClick={() => void handleAnalyzeWithAi()} disabled={analyzing}>
                <Sparkles className="h-3.5 w-3.5" />
                {analyzing ? 'Analyzing…' : 'Extract with AI'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditForm(buildEditForm(currentTender));
                  setEditingDetails(v => !v);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                {editingDetails ? 'Cancel edit' : 'Edit details'}
              </Button>
            </div>
          </div>

          {editingDetails ? (
            <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-4">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-ink-muted">Title</span>
                <input
                  value={editForm.title}
                  onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                  className={FIELD_INPUT_CLASS}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Organization</span>
                  <input
                    value={editForm.organization}
                    onChange={e => setEditForm({ ...editForm, organization: e.target.value })}
                    className={FIELD_INPUT_CLASS}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Reference No</span>
                  <input
                    value={editForm.reference_no}
                    onChange={e => setEditForm({ ...editForm, reference_no: e.target.value })}
                    className={`${FIELD_INPUT_CLASS} font-mono`}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Closing Date</span>
                  <input
                    type="date"
                    value={editForm.closing_date}
                    onChange={e => setEditForm({ ...editForm, closing_date: e.target.value })}
                    className={`${FIELD_INPUT_CLASS} font-mono`}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Estimated Value</span>
                  <input
                    value={editForm.estimated_value}
                    onChange={e => setEditForm({ ...editForm, estimated_value: e.target.value })}
                    placeholder="e.g. PKR 25,000,000"
                    className={FIELD_INPUT_CLASS}
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-ink-muted">Summary / Scope</span>
                <textarea
                  rows={4}
                  value={editForm.description}
                  onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                  placeholder="Enter tender scope, eligibility requirements, or summary bullets…"
                  className={FIELD_INPUT_CLASS}
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => setEditingDetails(false)}>Cancel</Button>
                <Button size="sm" variant="primary" disabled={savingDetails} onClick={() => void handleSaveDetails()}>
                  {savingDetails ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          ) : currentTender.description && currentTender.description.trim() ? (
            <HighlightedDescription text={currentTender.description} keywords={keywords} />
          ) : docState.kind === 'processing' || docState.kind === 'queued' ? (
            <div className="rounded-lg border border-dashed border-line bg-surface-2 px-4 py-3 text-sm text-ink-muted">
              Documents for this tender are currently {docState.kind === 'processing' ? 'being processed' : 'queued for background extraction'}. Summary and scope details will appear automatically once extracted, or click <span className="font-semibold text-ink">Fetch Documents</span> to run now.
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-line bg-surface-2 px-4 py-3 text-sm text-ink-muted">
              No detailed scope was provided on the portal listing page. Click <span className="font-semibold text-ink">Extract with AI</span> to analyze the portal page, or upload a tender notice image/PDF below.
            </div>
          )}

          {currentTender.bid_brief && (
            <details className="mt-4 rounded-xl border border-line bg-surface-2 p-4" open>
              <summary className="cursor-pointer select-none text-xs font-bold uppercase tracking-wider text-ink-muted">
                Go / No-Go Bid Brief
              </summary>
              <div className="mt-3 space-y-3 text-sm">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <div className="rounded-lg bg-surface px-3 py-2">
                    <div className="text-[11px] text-ink-muted">Bid security / CDR</div>
                    <div className="mt-0.5 font-mono text-xs font-semibold text-ink">
                      {currentTender.bid_brief.bidSecurityAmount || 'Not stated'}
                    </div>
                  </div>
                  <div className="rounded-lg bg-surface px-3 py-2">
                    <div className="text-[11px] text-ink-muted">Tender fee</div>
                    <div className="mt-0.5 font-mono text-xs font-semibold text-ink">
                      {currentTender.bid_brief.tenderFee || 'Not stated'}
                    </div>
                  </div>
                  <div className="rounded-lg bg-surface px-3 py-2">
                    <div className="text-[11px] text-ink-muted">Bidding method</div>
                    <div className="mt-0.5 text-xs font-semibold text-ink">
                      {currentTender.bid_brief.bidMethod || 'Not stated'}
                    </div>
                  </div>
                </div>

                {currentTender.bid_brief.requiredRegistrations?.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-semibold text-ink-muted">Required registrations</div>
                    <div className="flex flex-wrap gap-1.5">
                      {currentTender.bid_brief.requiredRegistrations.map(reg => (
                        <Chip key={reg} tone="accent">{reg}</Chip>
                      ))}
                    </div>
                  </div>
                )}

                {currentTender.bid_brief.requiredExperience && (
                  <div>
                    <div className="mb-0.5 text-xs font-semibold text-ink-muted">Experience / eligibility</div>
                    <p className="text-[13px] text-ink">{currentTender.bid_brief.requiredExperience}</p>
                  </div>
                )}

                {currentTender.bid_brief.deliverablesSummary?.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-semibold text-ink-muted">Key deliverables</div>
                    <ul className="list-disc space-y-1 pl-4 text-[13px] text-ink">
                      {currentTender.bid_brief.deliverablesSummary.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>

        {/* Documents / Dossiers Section */}
        <DossierSection
          tenderId={currentTender.id}
          files={files}
          docState={docState}
          fetchingDocs={fetchingDocs}
          uploadingFile={uploadingFile}
          onUploadFile={handleFileUpload}
        />

        {otherSources.length > 0 && (
          <div>
            <SectionTitle>Also listed on</SectionTitle>
            <div className="space-y-1.5">
              {otherSources.map((s, i) => (
                <a key={i} href={s.directUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 hover:underline">
                  <span className="font-medium">{s.portalName}</span>
                  <ExternalLink className="h-4 w-4 text-ink-muted" />
                </a>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted">Notes</h3>
            <span className={`text-xs ${noteState === 'failed' ? 'text-danger' : 'text-ink-muted'}`}>
              {noteState === 'saving' ? 'Saving…' : noteState === 'saved' ? 'Saved' : noteState === 'failed' ? 'Could not save' : 'Auto-saves as you type'}
            </span>
          </div>
          <textarea
            value={notes}
            onChange={e => {
              hasPendingNotesRef.current = true;
              setNotes(e.target.value);
            }}
            onBlur={() => void saveNotes()}
            rows={4}
            placeholder="Bank guarantee, partner contacts, site visit dates…"
            className="w-full rounded-lg border border-line bg-surface p-3 text-sm placeholder:text-ink-muted"
          />
        </div>
      </div>

      <DeleteTenderModal
        tender={currentTender}
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirmDelete={confirmDeleteTender}
      />
    </div>
  );
}
