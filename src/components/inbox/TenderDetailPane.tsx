import React, { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  Calendar,
  Check,
  Clock,
  Coins,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Paperclip,
  Pencil,
  RefreshCw,
  Sparkles,
  Target,
  Trash2,
  TriangleAlert,
  Upload,
  X
} from 'lucide-react';
import { Tender, CorrigendumLog, OpportunityStatus, CachedDossier } from '../../types';
import { Button, Chip, DeadlineChip } from '../../ui';
import { HighlightedDescription } from './HighlightedDescription';
import { DeleteTenderModal } from './DeleteTenderModal';

interface TenderDetailPaneProps {
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

export function TenderDetailPane({
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
}: TenderDetailPaneProps) {
  const [currentTender, setCurrentTender] = useState<Tender>(tender);
  const [notes, setNotes] = useState(tender.status_notes || '');
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const lastSavedNotesRef = useRef(tender.status_notes || '');
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchingDocs, setFetchingDocs] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError?: boolean } | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<CachedDossier | null>(null);
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
    setStatusMessage(null);
    setEditingDetails(false);
    setPreviewDoc(null);
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

  // Notes auto-save
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

  const dossiers: CachedDossier[] = Array.isArray(currentTender.cached_dossiers) ? currentTender.cached_dossiers : [];
  const tracks: string[] = Array.isArray(currentTender.domain_tracks) ? currentTender.domain_tracks : [];
  const keywords: string[] = Array.isArray(currentTender.matched_keywords) ? currentTender.matched_keywords : [];
  const amendments = corrigenda.filter(c => c.tender_id === currentTender.id);

  // Closing countdown
  const countdown = formatCountdown(currentTender.closing_date);
  const diffHours = currentTender.closing_date
    ? (new Date(currentTender.closing_date).getTime() - Date.now()) / 3600000
    : null;
  const isUrgent = diffHours !== null && diffHours > 0 && diffHours <= 24;
  const isWarning = diffHours !== null && diffHours > 24 && diffHours <= 72;
  const isClosed = diffHours !== null && diffHours <= 0;

  // On-demand fetch documents from portal
  const handleFetchDocuments = async () => {
    setFetchingDocs(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/tenders/${currentTender.id}/fetch-documents`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setStatusMessage({ text: data.message || `Fetched ${data.newlyFetched} document(s) from portal.` });
      } else {
        setStatusMessage({ text: data.error || 'Failed to fetch documents from portal.', isError: true });
      }
    } catch {
      setStatusMessage({ text: 'Error connecting to document fetch service.', isError: true });
    } finally {
      setFetchingDocs(false);
    }
  };

  const handleRefreshTender = async () => {
    setRefreshing(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/tenders/${currentTender.id}/refresh`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setStatusMessage({ text: data.message || 'Tender information refreshed from portal.' });
      } else {
        setStatusMessage({ text: data.error || 'Could not refresh tender from portal.', isError: true });
      }
    } catch {
      setStatusMessage({ text: 'Failed to refresh tender from portal.', isError: true });
    } finally {
      setRefreshing(false);
    }
  };

  const handleAnalyzeWithAi = async () => {
    setAnalyzing(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/tenders/${currentTender.id}/analyze`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.tender) {
        setCurrentTender(data.tender);
        onTenderUpdated?.(data.tender);
        setStatusMessage({ text: data.message || 'Tender scope summarized with Google AI.' });
      } else {
        setStatusMessage({ text: data.error || 'Could not analyze tender with AI.', isError: true });
      }
    } catch {
      setStatusMessage({ text: 'Failed to reach AI extraction service.', isError: true });
    } finally {
      setAnalyzing(false);
    }
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

  const handleFileUpload = async (file: File) => {
    setUploadingFile(true);
    setStatusMessage(null);
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
        setStatusMessage({
          text: data.aiExtracted
            ? 'Document saved and summarized with Google AI.'
            : 'Document saved to dossier.',
        });
      } else {
        setStatusMessage({ text: data.error || 'Failed to upload file.', isError: true });
      }
    } catch {
      setStatusMessage({ text: 'Failed to upload file.', isError: true });
    } finally {
      setUploadingFile(false);
    }
  };

  const handleSaveDetails = async () => {
    setSavingDetails(true);
    setStatusMessage(null);
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
        setStatusMessage({ text: 'Tender details updated.' });
      } else {
        setStatusMessage({ text: data.error || 'Could not save details.', isError: true });
      }
    } catch {
      setStatusMessage({ text: 'Could not save details.', isError: true });
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
    <div className="flex h-full flex-col bg-surface">
      {/* 1. Header Section */}
      <div className="border-b border-line p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-md bg-accent-soft px-2 py-0.5 font-bold uppercase tracking-wider text-accent">
              {currentTender.portal_name}
            </span>
            {currentTender.reference_no && (
              <span className="font-mono text-ink-muted bg-surface-2 px-2 py-0.5 rounded border border-line/60">
                Ref: {currentTender.reference_no}
              </span>
            )}
            {currentTender.location && (
              <span className="text-ink-muted">· {currentTender.location}</span>
            )}
            {Boolean(currentTender.is_bookmarked) && (
              <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-2 py-0.5 font-semibold text-accent">
                <Bookmark className="h-3 w-3 fill-current" />
                Bookmarked
              </span>
            )}
          </div>

          {currentTender.direct_url && currentTender.direct_url !== '#' && (
            <a
              href={currentTender.direct_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-accent hover:bg-surface-2 hover:underline"
              title="Open tender directly on government portal"
            >
              Open on portal <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>

        <h1 className="mt-2 text-base font-bold leading-snug text-ink sm:text-lg">
          {currentTender.title}
        </h1>
        <div className="mt-1 text-xs font-medium text-ink-muted">
          {currentTender.organization}
        </div>

        {/* 2. Executive 4-Card Fact Strip */}
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {/* Card 1: Closing date & countdown */}
          <div className={`rounded-xl border p-2.5 transition ${
            isUrgent
              ? 'border-danger/40 bg-danger-soft'
              : isWarning
              ? 'border-warn/40 bg-warn-soft'
              : 'border-line bg-surface-2/60'
          }`}>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
              <Clock className={`h-3.5 w-3.5 ${isUrgent ? 'text-danger' : isWarning ? 'text-warn' : 'text-accent'}`} />
              <span>CLOSING DATE</span>
            </div>
            <div className="mt-1 text-xs font-bold text-ink">
              {currentTender.closing_date_formatted || 'No deadline'}
            </div>
            {countdown && (
              <div className={`mt-0.5 font-mono text-[11px] font-semibold ${
                isUrgent ? 'text-danger' : isWarning ? 'text-warn' : 'text-accent'
              }`}>
                {countdown}
              </div>
            )}
          </div>

          {/* Card 2: Published date */}
          <div className="rounded-xl border border-line bg-surface-2/60 p-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
              <Calendar className="h-3.5 w-3.5 text-accent" />
              <span>PUBLISHED</span>
            </div>
            <div className="mt-1 font-mono text-xs font-bold text-ink">
              {currentTender.publish_date
                ? new Date(currentTender.publish_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                : 'Not stated'}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-muted">
              Portal post
            </div>
          </div>

          {/* Card 3: Estimated value */}
          <div className="rounded-xl border border-line bg-surface-2/60 p-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
              <Coins className="h-3.5 w-3.5 text-accent" />
              <span>ESTIMATED BUDGET</span>
            </div>
            <div className="mt-1 font-mono text-xs font-bold text-ink truncate">
              {currentTender.estimated_value || 'Not Disclosed'}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-muted">
              Tender value
            </div>
          </div>

          {/* Card 4: Match score & domain */}
          <div className="rounded-xl border border-line bg-surface-2/60 p-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
              <Target className="h-3.5 w-3.5 text-accent" />
              <span>MATCH SCORE</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="font-mono text-xs font-bold text-accent">
                {currentTender.match_score || 0}%
              </span>
              {tracks.length > 0 && (
                <span className="truncate rounded bg-accent-soft px-1.5 py-0.2 text-[10px] font-semibold text-accent">
                  {tracks[0]}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-muted truncate">
              {tracks.slice(1).join(', ') || 'Domain matched'}
            </div>
          </div>
        </div>

        {/* 3. Action Toolbar */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
          {stageActions ?? (
            <>
              <Button variant="primary" onClick={onTrack} className="gap-1.5 shadow-sm">
                <Target className="h-4 w-4" />
                Track this bid
              </Button>
              <Button onClick={onPass} className="gap-1.5">
                <X className="h-4 w-4" />
                Pass
              </Button>
            </>
          )}

          <Button
            variant="ghost"
            onClick={onToggleBookmark}
            aria-pressed={Boolean(currentTender.is_bookmarked)}
            aria-label={currentTender.is_bookmarked ? 'Remove bookmark' : 'Bookmark (Still deciding)'}
            title={currentTender.is_bookmarked ? 'Remove bookmark' : 'Bookmark — Keep in inbox even if deadline passes'}
            className="px-3"
          >
            <Bookmark className={`h-4 w-4 ${currentTender.is_bookmarked ? 'fill-current text-accent' : ''}`} />
          </Button>

          {/* One-click On-Demand Document Fetch */}
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
            onClick={handleRefreshTender}
            disabled={refreshing}
            className="gap-1.5"
            title="Re-query portal and refresh tender info"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-accent' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh info'}
          </Button>

          <Button
            variant="ghost"
            onClick={handleCopySummary}
            className="gap-1.5"
            title="Copy brief to clipboard"
          >
            {copiedSummary ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
            {copiedSummary ? 'Copied' : 'Copy'}
          </Button>

          {/* Delete Tender button */}
          <Button
            variant="ghost"
            onClick={() => setDeleteModalOpen(true)}
            className="ml-auto text-ink-muted hover:text-danger hover:bg-danger-soft px-2.5"
            title="Permanently delete this tender and its dossier files"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 4. Scrollable Body: Scope, Documents, Notes */}
      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        {statusMessage && (
          <div
            role="status"
            className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-xs font-medium ${
              statusMessage.isError ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent'
            }`}
          >
            <span>{statusMessage.text}</span>
            <button
              type="button"
              onClick={() => setStatusMessage(null)}
              className="ml-3 cursor-pointer font-semibold underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {amendments.length > 0 && (
          <div className="rounded-xl border border-warn/30 bg-warn-soft p-3.5">
            <div className="mb-2 flex items-center gap-2 text-xs font-bold text-warn uppercase tracking-wider">
              <TriangleAlert className="h-4 w-4" /> Corrigendum / Amendment Notice
            </div>
            <div className="space-y-2">
              {amendments.map(log => (
                <div key={log.id} className="flex items-start justify-between gap-3 rounded-lg bg-surface p-2.5 text-xs">
                  <div>
                    <div className="font-semibold capitalize text-ink">{log.change_type.replace(/_/g, ' ')}</div>
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

        {/* Scope / Summary Section with Keyword Highlighting */}
        <div>
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-ink-muted">Tender Scope & Summary</h2>
              {keywords.length > 0 && (
                <span className="rounded-full bg-surface-2 px-2 py-0.2 text-[10px] font-semibold text-ink-muted">
                  {keywords.length} matched terms
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" onClick={handleAnalyzeWithAi} disabled={analyzing} className="gap-1 text-xs">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                {analyzing ? 'Analyzing…' : 'Extract with AI'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditingDetails(v => !v)}
                className="gap-1 text-xs"
              >
                <Pencil className="h-3 w-3" />
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
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Organization</span>
                  <input
                    value={editForm.organization}
                    onChange={e => setEditForm({ ...editForm, organization: e.target.value })}
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Reference No</span>
                  <input
                    value={editForm.reference_no}
                    onChange={e => setEditForm({ ...editForm, reference_no: e.target.value })}
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Closing Date</span>
                  <input
                    type="date"
                    value={editForm.closing_date}
                    onChange={e => setEditForm({ ...editForm, closing_date: e.target.value })}
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-muted">Estimated Value</span>
                  <input
                    value={editForm.estimated_value}
                    onChange={e => setEditForm({ ...editForm, estimated_value: e.target.value })}
                    placeholder="e.g. PKR 25,000,000"
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-ink-muted">Scope / Description</span>
                <textarea
                  rows={4}
                  value={editForm.description}
                  onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                  className="w-full rounded-lg border border-line bg-surface p-3 text-xs"
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => setEditingDetails(false)}>Cancel</Button>
                <Button size="sm" variant="primary" disabled={savingDetails} onClick={handleSaveDetails}>
                  {savingDetails ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          ) : currentTender.description && currentTender.description.trim() ? (
            <div className="rounded-xl border border-line bg-surface-2/40 p-4 text-xs leading-relaxed">
              <HighlightedDescription text={currentTender.description} keywords={keywords} />
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-line bg-surface-2/40 p-4 text-center text-xs text-ink-muted">
              No description text available. Use <strong className="text-ink">Fetch Documents</strong> or <strong className="text-ink">Extract with AI</strong> to gather scope details.
            </div>
          )}
        </div>

        {/* 5. Documents / Dossiers Section */}
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
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-ink-muted">
                Dossier Attachments ({dossiers.length})
              </h2>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,.docx,.xlsx,.zip"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                  e.target.value = '';
                }}
              />
              <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile}>
                <Upload className="h-3 w-3" />
                {uploadingFile ? 'Uploading…' : 'Upload document'}
              </Button>
            </div>
          </div>

          {dossiers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-ink-muted">
              No documents downloaded yet. Click <strong>Fetch Documents</strong> above to scan the portal page.
            </div>
          ) : (
            <div className="space-y-2">
              {dossiers.map((doc, idx) => {
                const filename = decodeURIComponent(doc.localPath.split('/').pop() || `document-${idx + 1}`);
                const downloadUrl = `${doc.localPath}${doc.localPath.includes('?') ? '&' : '?'}download=1`;
                const isPdf = doc.mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
                const isImage = doc.mimeType?.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(filename);
                const sizeKB = doc.sizeBytes ? `${(doc.sizeBytes / 1024).toFixed(0)} KB` : null;

                return (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 transition hover:border-accent/40"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-muted">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs font-semibold text-ink" title={doc.label || filename}>
                            {doc.label || filename}
                          </span>
                          {doc.docType && (
                            <span className="rounded bg-chip px-1.5 py-0.2 text-[10px] font-bold uppercase text-ink-muted">
                              {doc.docType}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
                          <span className="truncate max-w-[200px]" title={filename}>{filename}</span>
                          {sizeKB && <span>• {sizeKB}</span>}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {(isPdf || isImage) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPreviewDoc(previewDoc === doc ? null : doc)}
                          title="Preview in modal"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          Preview
                        </Button>
                      )}
                      <a
                        href={downloadUrl}
                        download={filename}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-2"
                        title="Download to computer"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Preview Modal */}
          {previewDoc && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
              <div className="flex h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-line bg-surface shadow-2xl">
                <div className="flex items-center justify-between border-b border-line p-4">
                  <div className="font-semibold text-ink truncate pr-4">
                    {previewDoc.label || 'Document Preview'}
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={`${previewDoc.localPath}?download=1`}
                      download
                      className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                    <button
                      type="button"
                      onClick={() => setPreviewDoc(null)}
                      className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink cursor-pointer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-4 bg-surface-2">
                  {previewDoc.mimeType === 'application/pdf' || previewDoc.localPath.endsWith('.pdf') ? (
                    <iframe
                      src={previewDoc.localPath}
                      title="PDF Preview"
                      className="h-full w-full rounded-xl border border-line bg-surface"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <img
                        src={previewDoc.localPath}
                        alt="Preview"
                        className="max-h-full max-w-full rounded-xl object-contain shadow-sm"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 6. Result Expected & Operator Notes */}
        <div className="border-t border-line/60 pt-4 space-y-4">
          {onSetResultDate && (
            <div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-ink-muted">
                  Result Expected Date
                </span>
                <input
                  type="date"
                  value={currentTender.result_expected_date?.slice(0, 10) ?? ''}
                  onChange={e => onSetResultDate(e.target.value || null)}
                  className="h-9 rounded-lg border border-line bg-surface px-3 font-mono text-xs text-ink"
                />
              </label>
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-ink-muted">
                Private Operator Notes
              </span>
              <span className={`text-xs ${noteState === 'failed' ? 'text-danger' : 'text-ink-muted'}`}>
                {noteState === 'saving'
                  ? 'Saving…'
                  : noteState === 'saved'
                  ? 'Saved'
                  : noteState === 'failed'
                  ? 'Could not save'
                  : 'Auto-saves as you type'}
              </span>
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              onBlur={() => void saveNotes()}
              rows={3}
              placeholder="Private bidding notes, partner consortiums, earnest money, site visits…"
              className="w-full rounded-xl border border-line bg-surface p-3 text-xs leading-relaxed text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <DeleteTenderModal
        tender={currentTender}
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirmDelete={confirmDeleteTender}
      />
    </div>
  );
}
