import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Archive,
  Bookmark,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  Coins,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Inbox,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Target,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  X
} from 'lucide-react';
import { Tender, DomainTrack, CorrigendumLog, OpportunityStatus, CachedDossier } from '../types';
import { Button, Chip, DeadlineChip, Dialog, EmptyState, Panel, Popover } from '../ui';
import { DeadlineRunway } from './inbox/DeadlineRunway';
import { PortalPills, PortalSummaryItem } from './inbox/PortalPills';
import { HighlightedDescription } from './inbox/HighlightedDescription';
import { DeleteTenderModal } from './inbox/DeleteTenderModal';

type SortBy = 'urgency' | 'score' | 'newest';

export interface InboxScreenProps {
  tenders: Tender[];
  tracks: DomainTrack[];
  corrigenda: CorrigendumLog[];
  selectedTrack: string;
  onSelectTrack: (name: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  bookmarkedOnly: boolean;
  onToggleBookmarked: () => void;
  corrigendumOnly: boolean;
  onToggleCorrigendum: () => void;
  onStatusChange: (tenderId: string, status: OpportunityStatus) => Promise<void>;
  onAcknowledgeCorrigendum: (logId: string) => Promise<void>;
  onSaveNotes: (tenderId: string, notes: string) => Promise<void>;
  onToggleBookmark: (tenderId: string) => void;
  onMarkViewed?: (tenderId: string) => void;
  focusId?: string | null;
  onTenderUpdated?: (tender: Tender) => void;
  onTenderCreated?: (tender: Tender) => void;
  onTenderDeleted?: (tenderId: string) => void;
  portalSummary?: PortalSummaryItem[];
}

/** Older rows may hold these fields as JSON text. */
export function asList<T>(value: unknown): T[] {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value || '[]');
    } catch {
      return [];
    }
  }
  return (value as T[]) || [];
}

/** Re-renders its caller once per interval so countdowns stay current. */
export function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

function formatCountdown(closingDate: string | null) {
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

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

const fieldInputClass = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-ink-muted';

function TenderRow({
  tender,
  selected,
  unread,
  onSelect,
}: {
  tender: Tender;
  selected: boolean;
  unread: boolean;
  onSelect: () => void;
}) {
  const tracks = asList<string>(tender.domain_tracks);
  const keywords = asList<string>(tender.matched_keywords);
  const files = asList<{ label?: string; localPath: string }>(tender.cached_dossiers);
  const isSemanticMatch = keywords.some(k => k.startsWith('✨'));

  return (
    <button
      onClick={onSelect}
      data-tender-id={tender.id}
      aria-current={selected ? 'true' : undefined}
      className={`block w-full cursor-pointer border-b border-line px-4 py-3 text-left transition-colors ${
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {unread && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-accent"
              title="Unread tender"
              aria-label="Unread tender"
            />
          )}
          <DeadlineChip closingDate={tender.closing_date} />
          {tender.match_score > 0 && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-muted">
              {tender.match_score}%
            </span>
          )}
          {isSemanticMatch && (
            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold text-accent">
              ✨ Semantic
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {files.length > 0 && (
            <span
              className="inline-flex items-center gap-0.5 font-mono text-xs text-ink-muted"
              title={`${files.length} attached document(s)`}
              aria-label={`${files.length} attached document(s)`}
            >
              <Paperclip className="h-3.5 w-3.5" />
              {files.length}
            </span>
          )}
          {Boolean(tender.has_corrigendum) && <TriangleAlert className="h-4 w-4 text-warn" aria-label="Amended" />}
          {Boolean(tender.is_bookmarked) && <Bookmark className="h-4 w-4 fill-current text-accent" aria-label="Bookmarked" />}
        </span>
      </div>
      <div className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">{tender.title}</div>
      <div className="mt-1 truncate text-[13px] text-ink-muted">
        {tender.organization} · {tender.portal_name}
      </div>
      {(tracks.length > 0 || tender.estimated_value) && (
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-ink-muted">
          <span className="truncate">{tracks.join(' · ')}</span>
          {tender.estimated_value && (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink">
              {tender.estimated_value}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

/** Detail Pane exported for both Inbox and Pipeline */
export function Detail({
  tender,
  corrigenda,
  onTrack,
  onPass,
  stageActions,
  onSetResultDate,
  onAcknowledgeCorrigendum,
  onSaveNotes,
  onToggleBookmark,
  onTenderUpdated,
  onTenderDeleted,
}: {
  tender: Tender;
  corrigenda: CorrigendumLog[];
  onTrack?: () => void;
  onPass?: () => void;
  stageActions?: React.ReactNode;
  onSetResultDate?: (date: string | null) => void;
  onAcknowledgeCorrigendum: (logId: string) => Promise<void>;
  onSaveNotes: (tenderId: string, notes: string) => Promise<void>;
  onToggleBookmark: () => void;
  onTenderUpdated?: (tender: Tender) => void;
  onTenderDeleted?: (tenderId: string) => void;
}) {
  const [currentTender, setCurrentTender] = useState<Tender>(tender);
  const [notes, setNotes] = useState(tender.status_notes || '');
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const lastSavedNotesRef = useRef(tender.status_notes || '');
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchingDocs, setFetchingDocs] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [aiStatusMessage, setAiStatusMessage] = useState<{ text: string; isError?: boolean } | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [previewPdfIndex, setPreviewPdfIndex] = useState<number | null>(null);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [editForm, setEditForm] = useState({
    title: tender.title || '',
    organization: tender.organization || '',
    reference_no: tender.reference_no || '',
    closing_date: tender.closing_date ? tender.closing_date.slice(0, 10) : '',
    estimated_value: tender.estimated_value || '',
    direct_url: tender.direct_url || '',
    description: tender.description || '',
  });

  useEffect(() => {
    setCurrentTender(tender);
    setNotes(tender.status_notes || '');
    lastSavedNotesRef.current = tender.status_notes || '';
    setNoteState('idle');
    setAiStatusMessage(null);
    setEditingDetails(false);
    setPreviewPdfIndex(null);
    setCopiedSummary(false);
    setEditForm({
      title: tender.title || '',
      organization: tender.organization || '',
      reference_no: tender.reference_no || '',
      closing_date: tender.closing_date ? tender.closing_date.slice(0, 10) : '',
      estimated_value: tender.estimated_value || '',
      direct_url: tender.direct_url || '',
      description: tender.description || '',
    });
  }, [tender]);

  const keywords = asList<string>(currentTender.matched_keywords);
  const files = asList<{ label?: string; localPath: string; mimeType?: string; docType?: string; sizeBytes?: number }>(currentTender.cached_dossiers);
  const otherSources = asList<{ portalName: string; directUrl: string }>(currentTender.secondary_sources);
  const amendments = corrigenda.filter(c => c.tender_id === currentTender.id);

  const saveNotes = async (notesToSave: string = notes) => {
    if (notesToSave === lastSavedNotesRef.current) return;
    setNoteState('saving');
    try {
      await onSaveNotes(currentTender.id, notesToSave);
      lastSavedNotesRef.current = notesToSave;
      setNoteState('saved');
    } catch {
      setNoteState('failed');
    }
  };

  useEffect(() => {
    if (notes === lastSavedNotesRef.current) return;
    const timer = setTimeout(() => {
      void saveNotes(notes);
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
    const summaryLines = [
      `📋 ${currentTender.title}`,
      `🏛 Organization: ${currentTender.organization}`,
      `🔖 Ref No: ${currentTender.reference_no || 'N/A'}`,
      `⏰ Closes: ${currentTender.closing_date_formatted || 'No deadline stated'}`,
      currentTender.estimated_value ? `💰 Estimated Value: ${currentTender.estimated_value}` : null,
      `🌐 Portal: ${currentTender.portal_name}`,
      currentTender.direct_url && currentTender.direct_url !== '#' ? `🔗 Link: ${currentTender.direct_url}` : null,
    ].filter(Boolean).join('\n');

    try {
      await navigator.clipboard?.writeText(summaryLines);
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2000);
    } catch {}
  };

  // The server auto-expired (deleted) this tender because its deadline has passed:
  // drop it from the list instead of leaving a ghost row the operator can still act on.
  const handleTenderExpired = (message?: string) => {
    setAiStatusMessage({ text: message || 'Deadline has passed: tender removed from the Inbox.' });
    onTenderDeleted?.(currentTender.id);
  };

  const handleFetchDocuments = async () => {
    setFetchingDocs(true);
    setAiStatusMessage(null);
    try {
      const res = await fetch(`/api/tenders/${currentTender.id}/fetch-documents`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.expired) {
        handleTenderExpired(data.message);
      } else if (res.ok && data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setAiStatusMessage({ text: data.message || `Fetched ${data.newlyFetched} document(s) from portal.` });
      } else {
        setAiStatusMessage({ text: data.error || 'Failed to fetch documents from portal.', isError: true });
      }
    } catch {
      setAiStatusMessage({ text: 'Error connecting to document fetch service.', isError: true });
    } finally {
      setFetchingDocs(false);
    }
  };

  const handleAnalyzeWithAi = async () => {
    setAnalyzing(true);
    setAiStatusMessage(null);
    try {
      const res = await fetch(`/api/tenders/${currentTender.id}/analyze`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.expired) {
        handleTenderExpired(data.message);
      } else if (res.ok && data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setAiStatusMessage({ text: data.message || 'Tender summary extracted with AI.' });
      } else {
        setAiStatusMessage({ text: data.error || 'Could not analyze tender with AI.', isError: true });
      }
    } catch {
      setAiStatusMessage({ text: 'Failed to reach AI extraction service.', isError: true });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRefreshTender = async () => {
    setRefreshing(true);
    setAiStatusMessage(null);
    try {
      const res = await fetch(`/api/tenders/${currentTender.id}/refresh`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.expired) {
        handleTenderExpired(data.message);
      } else if (res.ok && data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setAiStatusMessage({ text: data.message || 'Tender information refreshed from portal.' });
      } else {
        setAiStatusMessage({ text: data.error || 'Could not refresh tender from portal.', isError: true });
      }
    } catch {
      setAiStatusMessage({ text: 'Failed to refresh tender from portal.', isError: true });
    } finally {
      setRefreshing(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    setUploadingFile(true);
    setAiStatusMessage(null);
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await fetch(`/api/tenders/${currentTender.id}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
          dataBase64,
          label: file.name,
          runAi: true,
        }),
      });
      const data = await res.json();
      if (res.ok && data.tender) {
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
    } catch {
      setAiStatusMessage({ text: 'Failed to upload file.', isError: true });
    } finally {
      setUploadingFile(false);
    }
  };

  const handleSaveDetails = async () => {
    setSavingDetails(true);
    setAiStatusMessage(null);
    try {
      const res = await fetch(`/api/tenders/${currentTender.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editForm.title,
          organization: editForm.organization,
          reference_no: editForm.reference_no,
          closing_date: editForm.closing_date || null,
          estimated_value: editForm.estimated_value || null,
          direct_url: editForm.direct_url,
          description: editForm.description,
        }),
      });
      const data = await res.json();
      if (res.ok && data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setEditingDetails(false);
        setAiStatusMessage({ text: 'Tender details updated.' });
      } else {
        setAiStatusMessage({ text: data.error || 'Could not save details.', isError: true });
      }
    } catch {
      setAiStatusMessage({ text: 'Could not save details.', isError: true });
    } finally {
      setSavingDetails(false);
    }
  };

  const confirmDeleteTender = async (tenderId: string) => {
    const res = await fetch(`/api/tenders/${tenderId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to delete tender');
    }
    onTenderDeleted?.(tenderId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-6">
        <div className="text-[13px] text-ink-muted">
          {currentTender.portal_name} · <span className="font-mono">{currentTender.reference_no || 'No reference'}</span>
          {currentTender.location && <> · {currentTender.location}</>}
        </div>
        <h2 className="mt-1 text-lg font-bold leading-snug">{currentTender.title}</h2>
        <div className="mt-1 text-sm text-ink-muted">{currentTender.organization}</div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-xs text-ink-muted">Closes</div>
            <div className="text-sm font-semibold">{currentTender.closing_date_formatted || 'No deadline stated'}</div>
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
            title="Download documents directly from this portal page"
          >
            <Download className={`h-4 w-4 ${fetchingDocs ? 'animate-bounce text-accent' : ''}`} />
            {fetchingDocs ? 'Fetching docs…' : 'Fetch Documents'}
          </Button>

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

        {/* 4-Card Fact Strip */}
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
                  setEditForm({
                    title: currentTender.title || '',
                    organization: currentTender.organization || '',
                    reference_no: currentTender.reference_no || '',
                    closing_date: currentTender.closing_date ? currentTender.closing_date.slice(0, 10) : '',
                    estimated_value: currentTender.estimated_value || '',
                    direct_url: currentTender.direct_url || '',
                    description: currentTender.description || '',
                  });
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
                  className={fieldInputClass}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Organization</span>
                  <input
                    value={editForm.organization}
                    onChange={e => setEditForm({ ...editForm, organization: e.target.value })}
                    className={fieldInputClass}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Reference No</span>
                  <input
                    value={editForm.reference_no}
                    onChange={e => setEditForm({ ...editForm, reference_no: e.target.value })}
                    className={`${fieldInputClass} font-mono`}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Closing Date</span>
                  <input
                    type="date"
                    value={editForm.closing_date}
                    onChange={e => setEditForm({ ...editForm, closing_date: e.target.value })}
                    className={`${fieldInputClass} font-mono`}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Estimated Value</span>
                  <input
                    value={editForm.estimated_value}
                    onChange={e => setEditForm({ ...editForm, estimated_value: e.target.value })}
                    placeholder="e.g. PKR 25,000,000"
                    className={fieldInputClass}
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
                  className={fieldInputClass}
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
          ) : (
            <div className="rounded-lg border border-dashed border-line bg-surface-2 px-4 py-3 text-sm text-ink-muted">
              No detailed scope was provided on the portal listing page. Click <span className="font-semibold text-ink">Extract with AI</span> to analyze the portal page, or upload a tender notice image/PDF below.
            </div>
          )}
        </div>

        {/* Documents / Dossiers Section */}
        <div
          onPaste={e => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
              if (items[i].type.startsWith('image/') || items[i].type === 'application/pdf') {
                const f = items[i].getAsFile();
                if (f) {
                  e.preventDefault();
                  void handleFileUpload(f);
                  break;
                }
              }
            }
          }}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted">Saved documents ({files.length})</h3>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf"
                aria-label="Upload tender notice image or PDF"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                  e.target.value = '';
                }}
              />
              <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile}>
                <Upload className="h-3.5 w-3.5" />
                {uploadingFile ? 'Uploading…' : 'Upload image / PDF'}
              </Button>
            </div>
          </div>
          {files.length === 0 ? (
            <p className="text-ink-muted">No documents saved yet. They are fetched during scans, or you can upload a tender image/PDF manually.</p>
          ) : (
            <div className="space-y-3">
              {files.map((file, i) => {
                const fileUrl = file.localPath.startsWith('/')
                  ? file.localPath
                  : `/api/dossiers/${currentTender.id}/${encodeURIComponent(file.localPath.replace(/\\/g, '/').split('/').pop() || '')}`;
                const isImage =
                  file.mimeType?.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(file.localPath);
                const isPdf = file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.localPath);

                return (
                  <div key={i} className="rounded-lg border border-line p-3">
                    <div className="flex items-center justify-between gap-3">
                      <a
                        href={fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-w-0 flex-1 items-center gap-3 hover:underline"
                      >
                        <FileText className="h-4 w-4 shrink-0 text-ink-muted" />
                        <span className="truncate font-semibold">{file.label || `Document ${i + 1}`}</span>
                        {file.docType && (
                          <span className="rounded bg-chip px-1.5 py-0.2 text-[10px] font-bold uppercase text-ink-muted">
                            {file.docType}
                          </span>
                        )}
                      </a>
                      <div className="flex items-center gap-2">
                        {isPdf && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setPreviewPdfIndex(previewPdfIndex === i ? null : i)}
                          >
                            {previewPdfIndex === i ? 'Hide preview' : 'Preview PDF'}
                          </Button>
                        )}
                        <a
                          href={`${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=1`}
                          download
                          className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-2"
                        >
                          <Download className="h-3 w-3" />
                          Download
                        </a>
                      </div>
                    </div>
                    {isImage && (
                      <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block">
                        <img
                          src={fileUrl}
                          alt={file.label || `Tender notice ${i + 1}`}
                          className="max-h-96 w-full rounded-lg border border-line bg-surface-2 object-contain"
                          loading="lazy"
                        />
                      </a>
                    )}
                    {isPdf && previewPdfIndex === i && (
                      <iframe
                        src={fileUrl}
                        title={file.label || `PDF Preview ${i + 1}`}
                        className="mt-3 h-96 w-full rounded-lg border border-line bg-surface"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

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
            onChange={e => setNotes(e.target.value)}
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

export function InboxScreen(props: InboxScreenProps) {
  const {
    tenders,
    tracks,
    corrigenda,
    selectedTrack,
    searchQuery,
    bookmarkedOnly,
    corrigendumOnly
  } = props;

  const [sortBy, setSortBy] = useState<SortBy>('urgency');
  const [selectedId, setSelectedId] = useState<string | null>(props.focusId ?? null);
  const [selectedPortalId, setSelectedPortalId] = useState<string>('All');
  const [selectedRunwayDate, setSelectedRunwayDate] = useState<string | null>(null);
  const [showClosedTenders, setShowClosedTenders] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [viewedIds, setViewedIds] = useState<Set<string>>(() => new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [deletingClosed, setDeletingClosed] = useState(false);

  // Undo Toast state
  const [undoItem, setUndoItem] = useState<{ tender: Tender; status: OpportunityStatus } | null>(null);
  const [undoCountdown, setUndoCountdown] = useState(6);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Manual Tender Modal state
  const [addingManual, setAddingManual] = useState(false);
  const [creatingManual, setCreatingManual] = useState(false);
  const [extractingManualAi, setExtractingManualAi] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualFile, setManualFile] = useState<{ filename: string; mimeType: string; dataBase64: string } | null>(null);
  const [manualForm, setManualForm] = useState({
    title: '',
    organization: '',
    reference_no: '',
    closing_date: '',
    estimated_value: '',
    portal_name: 'Manual Entry',
    direct_url: '',
    description: '',
  });

  useTick(30_000);


  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, []);

  const isTenderViewed = (t: Tender) => Boolean(t.viewed) || viewedIds.has(t.id);

  const markViewed = (id: string) => {
    setViewedIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    props.onMarkViewed?.(id);
  };

  // Base list of live tenders excluding manually deleted items
  const activeTenders = useMemo(() => {
    return tenders.filter(t => !deletedIds.has(t.id));
  }, [tenders, deletedIds]);

  // Filter and sort tenders
  const now = Date.now();
  // Closed = deadline passed, or undated and first published/seen over 60 days ago. Bookmarked
  // tenders are never treated as closed. Closed tenders are always hidden unless the operator
  // turns on "Show closed" (previously they were shown as normal whenever no open tender
  // remained, so an all-expired Inbox looked active).
  const isClosedUntracked = (t: Tender) => {
    if (t.is_bookmarked) return false;
    if (t.closing_date && new Date(t.closing_date).getTime() < now) return true;
    const seenAt = t.publish_date || t.created_at;
    if (!t.closing_date && seenAt && now - new Date(seenAt).getTime() > 60 * 86400000) return true;
    return false;
  };

  // Dynamic portal summary computed directly from active tenders
  const computedPortalSummary: PortalSummaryItem[] = useMemo(() => {
    const map = new Map<string, PortalSummaryItem>();
    for (const t of activeTenders) {
      if (!showClosedTenders && isClosedUntracked(t)) {
        continue;
      }
      const pid = t.portal_id || 'other';
      const existing = map.get(pid);
      const isUnread = !Boolean(t.viewed) && !viewedIds.has(t.id);
      if (existing) {
        existing.total_count += 1;
        if (isUnread) existing.unread_count += 1;
      } else {
        map.set(pid, {
          portal_id: pid,
          portal_name: t.portal_name || pid,
          total_count: 1,
          unread_count: isUnread ? 1 : 0
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.unread_count - a.unread_count || b.total_count - a.total_count);
  }, [activeTenders, showClosedTenders, viewedIds]);

  const portalSummary = props.portalSummary ?? computedPortalSummary;

  // Tenders matching active category filters
  const filteredTenders = useMemo(() => {
    return activeTenders.filter(t => {
      // 1. Unread filter
      if (unreadOnly && isTenderViewed(t)) return false;

      // 2. Portal filter
      if (selectedPortalId !== 'All' && t.portal_id !== selectedPortalId) {
        return false;
      }

      // 3. Runway date filter
      if (selectedRunwayDate !== null && t.closing_date?.slice(0, 10) !== selectedRunwayDate) {
        return false;
      }

      return true;
    });
  }, [activeTenders, unreadOnly, viewedIds, selectedPortalId, selectedRunwayDate]);

  // Count hidden closed tenders in current filter
  const hiddenClosedTenders = useMemo(() => {
    return filteredTenders.filter(isClosedUntracked);
  }, [filteredTenders]);

  // Final list displayed in triage column: closed tenders are excluded unless "Show closed" is on.
  const displayTenders = useMemo(() => {
    if (!showClosedTenders) {
      return filteredTenders.filter(t => !isClosedUntracked(t));
    }
    return filteredTenders;
  }, [filteredTenders, showClosedTenders]);

  // Sort display tenders
  const sorted = useMemo(() => {
    const list = [...displayTenders];
    if (sortBy === 'score') {
      return list.sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
    }
    if (sortBy === 'newest') {
      const time = (t: Tender) => {
        const at = t.publish_date || t.created_at;
        return at ? new Date(at).getTime() : 0;
      };
      return list.sort((a, b) => time(b) - time(a));
    }

    // Urgency sort: soonest open deadline first, closed ones after, no deadline last.
    const rank = (t: Tender) => {
      if (!t.closing_date) return Infinity;
      const at = new Date(t.closing_date).getTime();
      return at < now ? Number.MAX_SAFE_INTEGER - (now - at) : at;
    };
    return list.sort((a, b) => rank(a) - rank(b));
  }, [displayTenders, sortBy, now]);

  const withDeadline = sorted.filter(t => t.closing_date);
  const noDeadline = sorted.filter(t => !t.closing_date);
  const ordered = sortBy === 'urgency' ? [...withDeadline, ...noDeadline] : sorted;

  const expiredTenders = useMemo(() => {
    return ordered.filter(t => t.closing_date && new Date(t.closing_date).getTime() <= now);
  }, [ordered, now]);

  const firstNoDeadlineId = sortBy === 'urgency' ? noDeadline[0]?.id : undefined;

  // Maintain active selection
  const selected = ordered.find(t => t.id === selectedId) ?? null;
  useEffect(() => {
    if (selected || ordered.length === 0) return;
    setSelectedId(ordered[0].id);
  }, [selected, ordered]);

  // Quick Action Handler (Track / Pass)
  const act = (tender: Tender, status: OpportunityStatus) => {
    const index = ordered.findIndex(t => t.id === tender.id);
    const next = ordered[index + 1] ?? ordered[index - 1] ?? null;
    setSelectedId(next ? next.id : null);
    markViewed(tender.id);

    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    setUndoItem({ tender, status });
    setUndoCountdown(6);

    countdownIntervalRef.current = setInterval(() => {
      setUndoCountdown(c => {
        if (c <= 1) {
          if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
          setUndoItem(null);
          return 0;
        }
        return c - 1;
      });
    }, 1000);

    undoTimerRef.current = setTimeout(() => {
      setUndoItem(null);
    }, 6000);

    const res = props.onStatusChange(tender.id, status);
    if (res && typeof (res as any).then === 'function') {
      void res;
    }
  };

  const handleUndo = async () => {
    if (!undoItem) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    const revertedTender = undoItem.tender;
    setUndoItem(null);

    await props.onStatusChange(revertedTender.id, 'New Opportunity');
    setSelectedId(revertedTender.id);
  };

  const handleDeleteHiddenClosed = async () => {
    if (hiddenClosedTenders.length === 0) return;
    setDeletingClosed(true);
    try {
      for (const t of hiddenClosedTenders) {
        await fetch(`/api/tenders/${t.id}`, { method: 'DELETE' });
        setDeletedIds(prev => new Set(prev).add(t.id));
      }
    } finally {
      setDeletingClosed(false);
    }
  };

  const handleArchiveExpired = async () => {
    for (const t of expiredTenders) {
      await props.onStatusChange(t.id, 'Passed');
    }
  };

  // Keyboard Navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (addingManual || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;

      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const isDown = e.key === 'ArrowDown' || e.key === 'j';
        const i = ordered.findIndex(t => t.id === selectedId);
        const next = ordered[isDown ? i + 1 : i - 1];
        if (next) {
          setSelectedId(next.id);
          markViewed(next.id);
          const rowEl = document.querySelector(`[data-tender-id="${next.id}"]`) as HTMLElement | null;
          rowEl?.scrollIntoView?.({ block: 'nearest' });
        }
        return;
      }

      if (!selected) return;

      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        act(selected, 'Under Review');
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        act(selected, 'Passed');
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        props.onToggleBookmark(selected.id);
      } else if ((e.key === 'o' || e.key === 'O') && selected.direct_url && selected.direct_url !== '#') {
        e.preventDefault();
        window.open(selected.direct_url, '_blank', 'noopener,noreferrer');
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ordered, selectedId, selected, addingManual]);

  const activeFilters =
    (selectedTrack !== 'All' ? 1 : 0) +
    (selectedPortalId !== 'All' ? 1 : 0) +
    (selectedRunwayDate !== null ? 1 : 0) +
    (bookmarkedOnly ? 1 : 0) +
    (corrigendumOnly ? 1 : 0) +
    (unreadOnly ? 1 : 0);
  const filtering = activeFilters > 0 || searchQuery.trim() !== '';

  const exportCsvUrl = useMemo(() => {
    const params = new URLSearchParams({ scope: 'inbox' });
    if (selectedTrack !== 'All') params.set('track', selectedTrack);
    if (selectedPortalId !== 'All') params.set('portal', selectedPortalId);
    if (searchQuery.trim()) params.set('search', searchQuery.trim());
    if (bookmarkedOnly) params.set('bookmarkedOnly', 'true');
    if (corrigendumOnly) params.set('corrigendumOnly', 'true');
    return `/api/export/csv?${params.toString()}`;
  }, [selectedTrack, selectedPortalId, searchQuery, bookmarkedOnly, corrigendumOnly]);

  const handleManualFilePicked = async (file: File) => {
    setManualError(null);
    try {
      const dataBase64 = await fileToBase64(file);
      const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
      setManualFile({ filename: file.name, mimeType, dataBase64 });
    } catch {
      setManualError('Failed to read selected file.');
    }
  };

  const handleAutoFillManualWithAi = async () => {
    if (!manualFile) return;
    setExtractingManualAi(true);
    setManualError(null);
    try {
      const res = await fetch('/api/ai/extract-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataBase64: manualFile.dataBase64, mimeType: manualFile.mimeType }),
      });
      const data = await res.json();
      if (res.ok && data.extracted) {
        const ext = data.extracted;
        setManualForm(prev => ({
          ...prev,
          title: ext.title || prev.title,
          organization: ext.organization || prev.organization,
          reference_no: ext.referenceNo || prev.reference_no,
          closing_date: ext.closingDate && /^\d{4}-\d{2}-\d{2}/.test(ext.closingDate) ? ext.closingDate.slice(0, 10) : prev.closing_date,
          estimated_value: ext.estimatedValue || prev.estimated_value,
          description: ext.summaryScope || prev.description,
        }));
      } else {
        setManualError(data.error || 'Could not extract fields from file.');
      }
    } catch {
      setManualError('Failed to reach AI extraction service.');
    } finally {
      setExtractingManualAi(false);
    }
  };

  const handleCreateManualTender = async () => {
    if (!manualForm.title.trim()) return;
    setCreatingManual(true);
    setManualError(null);
    try {
      const res = await fetch('/api/tenders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...manualForm,
          fileBase64: manualFile?.dataBase64,
          filename: manualFile?.filename,
          mimeType: manualFile?.mimeType,
        }),
      });
      const data = await res.json();
      if (res.ok && data.tender) {
        props.onTenderCreated?.(data.tender);
        setSelectedId(data.tender.id);
        setAddingManual(false);
        setManualFile(null);
        setManualForm({
          title: '',
          organization: '',
          reference_no: '',
          closing_date: '',
          estimated_value: '',
          portal_name: 'Manual Entry',
          direct_url: '',
          description: '',
        });
      } else {
        setManualError(data.error || 'Failed to create tender.');
      }
    } catch {
      setManualError('Failed to create tender.');
    } finally {
      setCreatingManual(false);
    }
  };

  const totalUnreadAll = portalSummary.reduce((sum, p) => sum + (p.unread_count || 0), 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      {/* 1. Top Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Inbox</h1>
        <span className="font-mono text-sm text-ink-muted">{ordered.length}</span>
        <span className="hidden text-xs text-ink-muted xl:inline" title="Keyboard shortcuts: J/K or Arrows to navigate, T to Track, P to Pass, B to Bookmark, / to Search">
          Shortcuts: <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[11px]">J/K</kbd>{' '}
          <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[11px]">T</kbd>{' '}
          <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[11px]">P</kbd>{' '}
          <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[11px]">B</kbd>{' '}
          <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[11px]">/</kbd>
        </span>

        <div className="relative ml-auto w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={e => props.onSearchChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                if (searchQuery) props.onSearchChange('');
                searchInputRef.current?.blur();
              }
            }}
            placeholder="Search tenders"
            aria-label="Search tenders"
            className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-8 placeholder:text-ink-muted"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => props.onSearchChange('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 cursor-pointer text-ink-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {expiredTenders.length > 0 && (
          <Button
            variant="ghost"
            onClick={() => void handleArchiveExpired()}
            title="Move all expired tenders in the current Inbox view to Passed"
          >
            <Archive className="h-4 w-4" />
            Archive expired ({expiredTenders.length})
          </Button>
        )}

        <a
          href={exportCsvUrl}
          download
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 text-sm font-semibold text-ink hover:bg-surface-2"
          title="Export filtered Inbox tenders to CSV"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </a>

        <Button onClick={() => { setManualError(null); setAddingManual(true); }}>
          <Plus className="h-4 w-4" />
          Add tender
        </Button>

        <Popover align="end" trigger={({ toggle }) => (
          <Button onClick={toggle}>
            <SlidersHorizontal className="h-4 w-4" />
            Filters{activeFilters > 0 && <span className="rounded-full bg-accent px-1.5 font-mono text-xs text-accent-ink">{activeFilters}</span>}
          </Button>
        )}>
          {() => (
            <div className="w-64 space-y-4 p-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-ink-muted">Domain</span>
                <select
                  value={selectedTrack}
                  onChange={e => props.onSelectTrack(e.target.value)}
                  className="h-10 w-full rounded-lg border border-line bg-surface px-2"
                >
                  <option value="All">All domains</option>
                  {tracks.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={bookmarkedOnly} onChange={props.onToggleBookmarked} className="h-4 w-4 accent-[var(--accent)]" />
                Bookmarked only
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={corrigendumOnly} onChange={props.onToggleCorrigendum} className="h-4 w-4 accent-[var(--accent)]" />
                Amended only
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={unreadOnly} onChange={() => setUnreadOnly(v => !v)} className="h-4 w-4 accent-[var(--accent)]" />
                Unread only
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={showClosedTenders} onChange={() => setShowClosedTenders(v => !v)} className="h-4 w-4 accent-[var(--accent)]" />
                Show closed tenders ({hiddenClosedTenders.length})
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-ink-muted">Sort by</span>
                <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)} className="h-10 w-full rounded-lg border border-line bg-surface px-2">
                  <option value="urgency">Closing soonest</option>
                  <option value="score">Best match</option>
                  <option value="newest">Newest</option>
                </select>
              </label>
            </div>
          )}
        </Popover>
      </div>

      {/* 2. Portal Pills Bar with Notification Badges */}
      <PortalPills
        summary={portalSummary}
        selectedPortalId={selectedPortalId}
        onSelectPortal={setSelectedPortalId}
        totalActiveCount={activeTenders.length}
        totalUnreadCount={totalUnreadAll}
      />

      {/* 3. 15-Day Closing Dates Runway Strip */}
      <div className="my-2">
        <DeadlineRunway
          tenders={activeTenders}
          selectedDate={selectedRunwayDate}
          onSelectDate={setSelectedRunwayDate}
        />
      </div>

      {/* 4. Domain Track Quick Filters */}
      {(tracks.length > 0 || filtering) && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Track quick filters">
          <button
            type="button"
            onClick={() => props.onSelectTrack('All')}
            aria-pressed={selectedTrack === 'All'}
            className={`cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              selectedTrack === 'All'
                ? 'bg-accent text-accent-ink'
                : 'border border-line bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink'
            }`}
          >
            All domains
          </button>
          {tracks.map(track => (
            <button
              key={track.id}
              type="button"
              onClick={() => props.onSelectTrack(selectedTrack === track.name ? 'All' : track.name)}
              aria-pressed={selectedTrack === track.name}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                selectedTrack === track.name
                  ? 'bg-accent text-accent-ink'
                  : 'border border-line bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink'
              }`}
            >
              {track.name}
            </button>
          ))}

          {selectedPortalId !== 'All' && (
            <button
              type="button"
              onClick={() => setSelectedPortalId('All')}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
            >
              Portal: {portalSummary.find(p => p.portal_id === selectedPortalId)?.portal_name || selectedPortalId}
              <X className="h-3 w-3" />
            </button>
          )}

          {selectedRunwayDate !== null && (
            <button
              type="button"
              onClick={() => setSelectedRunwayDate(null)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
            >
              Runway: {selectedRunwayDate}
              <X className="h-3 w-3" />
            </button>
          )}

          {bookmarkedOnly && (
            <button
              type="button"
              onClick={props.onToggleBookmarked}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
            >
              Bookmarked <X className="h-3 w-3" />
            </button>
          )}
          {corrigendumOnly && (
            <button
              type="button"
              onClick={props.onToggleCorrigendum}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-warn-soft px-2.5 py-1 text-xs font-semibold text-warn"
            >
              Amended <X className="h-3 w-3" />
            </button>
          )}
          {unreadOnly && (
            <button
              type="button"
              onClick={() => setUnreadOnly(false)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
            >
              Unread <X className="h-3 w-3" />
            </button>
          )}
          {filtering && (
            <button
              type="button"
              onClick={() => {
                setSelectedPortalId('All');
                setSelectedRunwayDate(null);
                if (selectedTrack !== 'All') props.onSelectTrack('All');
                if (bookmarkedOnly) props.onToggleBookmarked();
                if (corrigendumOnly) props.onToggleCorrigendum();
                if (unreadOnly) setUnreadOnly(false);
                if (searchQuery) props.onSearchChange('');
              }}
              className="ml-1 cursor-pointer text-xs font-semibold text-ink-muted underline hover:text-ink"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* 5. Main Triage Split Workspace */}
      {ordered.length === 0 ? (
        <Panel className="flex-1">
          <EmptyState
            icon={<Inbox className="h-8 w-8" />}
            title={filtering ? 'Nothing matches these filters' : 'Your Inbox is clear'}
            body={
              hiddenClosedTenders.length > 0 && !showClosedTenders
                ? `${hiddenClosedTenders.length} closed tender(s) are hidden because their deadline has passed.`
                : filtering
                  ? 'Try removing a filter or clearing the search.'
                  : 'New tenders from your portals will appear here after the next scan.'
            }
            action={
              hiddenClosedTenders.length > 0 && !showClosedTenders ? (
                <Button variant="ghost" onClick={() => setShowClosedTenders(true)}>
                  Show closed
                </Button>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(340px,2fr)_3fr]">
          <Panel className="overflow-y-auto lg:sticky lg:top-4 lg:h-[calc(100vh-14.5rem)]">
            {/* Auto-hidden Closed Tenders Banner */}
            {hiddenClosedTenders.length > 0 && !showClosedTenders && (
              <div className="flex items-center justify-between border-b border-line bg-surface-2 px-4 py-2 text-xs">
                <span className="text-ink-muted">
                  📁 <strong className="text-ink font-semibold">{hiddenClosedTenders.length}</strong> closed tender(s) hidden
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDeleteHiddenClosed}
                    disabled={deletingClosed}
                    className="font-semibold text-danger hover:underline cursor-pointer"
                  >
                    {deletingClosed ? 'Deleting…' : 'Delete now'}
                  </button>
                  <span className="text-line">•</span>
                  <button
                    type="button"
                    onClick={() => setShowClosedTenders(true)}
                    className="font-semibold text-accent hover:underline cursor-pointer"
                  >
                    Show closed
                  </button>
                </div>
              </div>
            )}

            {ordered.map(t => (
              <React.Fragment key={t.id}>
                {t.id === firstNoDeadlineId && (
                  <div className="border-b border-line bg-surface-2 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-ink-muted">
                    No deadline stated
                  </div>
                )}
                <TenderRow
                  tender={t}
                  selected={t.id === selected?.id}
                  unread={!isTenderViewed(t)}
                  onSelect={() => {
                    setSelectedId(t.id);
                    markViewed(t.id);
                  }}
                />
              </React.Fragment>
            ))}
          </Panel>

          <Panel className="overflow-hidden lg:sticky lg:top-4 lg:h-[calc(100vh-14.5rem)]">
            {selected && (
              <Detail
                tender={selected}
                corrigenda={corrigenda}
                onTrack={() => act(selected, 'Under Review')}
                onPass={() => act(selected, 'Passed')}
                onSetResultDate={date => {
                  props.onSaveNotes(selected.id, selected.status_notes || '');
                  fetch(`/api/tenders/${selected.id}/result-date`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date })
                  });
                }}
                onAcknowledgeCorrigendum={props.onAcknowledgeCorrigendum}
                onSaveNotes={props.onSaveNotes}
                onToggleBookmark={() => props.onToggleBookmark(selected.id)}
                onTenderUpdated={updated => {
                  props.onTenderUpdated?.(updated);
                }}
                onTenderDeleted={id => {
                  setDeletedIds(prev => new Set(prev).add(id));
                  props.onTenderDeleted?.(id);
                }}
              />
            )}
          </Panel>
        </div>
      )}

      {/* Floating 6-Second Undo Toast */}
      {undoItem && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line bg-surface px-4 py-2.5 shadow-2xl animate-in fade-in slide-in-from-bottom-4"
        >
          <span className="text-xs font-semibold text-ink">
            Moved to Passed: "{undoItem.tender.title.slice(0, 32)}..."
          </span>
          <button
            type="button"
            onClick={handleUndo}
            aria-label="Undo"
            className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs font-bold text-accent-ink hover:brightness-110 shadow-sm"
          >
            <Undo2 className="h-3 w-3" />
            Undo
          </button>
        </div>
      )}

      {/* Manual Tender Dialog */}
      <Dialog
        open={addingManual}
        onClose={() => setAddingManual(false)}
        title="Add tender"
      >
        <div className="space-y-4">
          {manualError && (
            <div className="rounded-lg bg-danger-soft p-3 text-xs text-danger">
              {manualError}
            </div>
          )}

          <div className="rounded-lg border border-dashed border-line p-4 text-center">
            <input
              type="file"
              accept="image/*,.pdf"
              id="manual-file-input"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void handleManualFilePicked(f);
                e.target.value = '';
              }}
            />
            {manualFile ? (
              <div className="flex items-center justify-between">
                <span className="truncate text-xs font-medium">{manualFile.filename}</span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void handleAutoFillManualWithAi()}
                    disabled={extractingManualAi}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {extractingManualAi ? 'Extracting…' : 'Extract with AI'}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setManualFile(null)}
                    className="cursor-pointer text-ink-muted hover:text-ink"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : (
              <label htmlFor="manual-file-input" className="cursor-pointer text-xs text-ink-muted hover:text-ink">
                Upload image or PDF to extract details with AI
              </label>
            )}
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Title *</span>
            <input
              value={manualForm.title}
              onChange={e => setManualForm({ ...manualForm, title: e.target.value })}
              placeholder="e.g. Procurement of Solar PV System for DHQ Hospital"
              className={fieldInputClass}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-muted">Organization *</span>
              <input
                value={manualForm.organization}
                onChange={e => setManualForm({ ...manualForm, organization: e.target.value })}
              placeholder="Procuring agency"
                className={fieldInputClass}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-muted">Reference No</span>
              <input
                value={manualForm.reference_no}
                onChange={e => setManualForm({ ...manualForm, reference_no: e.target.value })}
              placeholder="e.g. PPRA-2026-104"
                className={`${fieldInputClass} font-mono`}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-muted">Closing Date</span>
              <input
                type="date"
                value={manualForm.closing_date}
                onChange={e => setManualForm({ ...manualForm, closing_date: e.target.value })}
                className={`${fieldInputClass} font-mono`}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-muted">Estimated Value</span>
              <input
                value={manualForm.estimated_value}
                onChange={e => setManualForm({ ...manualForm, estimated_value: e.target.value })}
                placeholder="e.g. PKR 25,000,000"
                className={fieldInputClass}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Direct Portal URL</span>
            <input
              value={manualForm.direct_url}
              onChange={e => setManualForm({ ...manualForm, direct_url: e.target.value })}
              placeholder="https://..."
              className={fieldInputClass}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Summary / Scope</span>
            <textarea
              rows={4}
              value={manualForm.description}
              onChange={e => setManualForm({ ...manualForm, description: e.target.value })}
              placeholder="Enter tender scope, requirements…"
              className={fieldInputClass}
            />
          </label>

          <div className="flex justify-end gap-2">
            <Button onClick={() => setAddingManual(false)}>Cancel</Button>
            <Button variant="primary" disabled={creatingManual || !manualForm.title.trim()} onClick={() => void handleCreateManualTender()}>
              {creatingManual ? 'Creating…' : 'Create tender'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
