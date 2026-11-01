import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, ExternalLink, FileText, Inbox, Pencil, Plus, RotateCw, Search, SlidersHorizontal, Sparkles, TriangleAlert, Upload } from 'lucide-react';
import { Tender, DomainTrack, CorrigendumLog, OpportunityStatus } from '../types';
import { Button, Chip, DeadlineChip, Dialog, EmptyState, Panel, Popover } from '../ui';

type SortBy = 'urgency' | 'score' | 'newest';

interface InboxScreenProps {
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
  /** Tender to select when the screen opens, for example from an alert banner. */
  focusId?: string | null;
  onTenderUpdated?: (tender: Tender) => void;
  onTenderCreated?: (tender: Tender) => void;
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

function TenderRow({ tender, selected, onSelect }: { tender: Tender; selected: boolean; onSelect: () => void }) {
  const tracks = asList<string>(tender.domain_tracks);
  return (
    <button
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`block w-full cursor-pointer border-b border-line px-4 py-3 text-left ${
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <DeadlineChip closingDate={tender.closing_date} />
        <span className="flex items-center gap-2">
          {Boolean(tender.has_corrigendum) && <TriangleAlert className="h-4 w-4 text-warn" aria-label="Amended" />}
          {Boolean(tender.is_bookmarked) && <Bookmark className="h-4 w-4 fill-current text-accent" aria-label="Bookmarked" />}
        </span>
      </div>
      <div className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">{tender.title}</div>
      <div className="mt-1 truncate text-[13px] text-ink-muted">
        {tender.organization} · {tender.portal_name}
      </div>
      {tracks.length > 0 && <div className="mt-1 truncate text-xs text-ink-muted">{tracks.join(' · ')}</div>}
    </button>
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

/** Shared by the Inbox and the Pipeline slide-over. `stageActions` replaces the Track / Pass buttons. */
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
}) {
  useTick(1000);
  const [currentTender, setCurrentTender] = useState<Tender>(tender);
  const [notes, setNotes] = useState(tender.status_notes || '');
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [aiStatusMessage, setAiStatusMessage] = useState<{ text: string; isError?: boolean } | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [previewPdfIndex, setPreviewPdfIndex] = useState<number | null>(null);
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
    setNoteState('idle');
    setAiStatusMessage(null);
    setEditingDetails(false);
    setPreviewPdfIndex(null);
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
  const files = asList<{ label?: string; localPath: string; mimeType?: string }>(currentTender.cached_dossiers);
  const otherSources = asList<{ portalName: string; directUrl: string }>(currentTender.secondary_sources);
  const amendments = corrigenda.filter(c => c.tender_id === currentTender.id);
  const countdown = formatCountdown(currentTender.closing_date);
  const urgent = currentTender.closing_date ? new Date(currentTender.closing_date).getTime() - Date.now() < 86_400_000 : false;

  const hasCleanDescription = Boolean(
    currentTender.description &&
      currentTender.description.trim() !== '' &&
      currentTender.description.trim().toLowerCase() !== currentTender.title.trim().toLowerCase()
  );

  const saveNotes = async () => {
    if (notes === (currentTender.status_notes || '')) return;
    setNoteState('saving');
    try {
      await onSaveNotes(currentTender.id, notes);
      setNoteState('saved');
    } catch {
      setNoteState('failed');
    }
  };

  const handleAnalyzeWithAi = async () => {
    setAnalyzing(true);
    setAiStatusMessage(null);
    try {
      const res = await fetch(`/api/tenders/${currentTender.id}/analyze`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.tender) {
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
      if (res.ok && data.tender) {
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
          {countdown && (
            <div>
              <div className="text-xs text-ink-muted">Time left</div>
              <div className={`font-mono text-sm font-semibold ${urgent ? 'text-danger' : ''}`}>{countdown}</div>
            </div>
          )}
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
              <Button variant="primary" onClick={onTrack}>Track this bid</Button>
              <Button onClick={onPass}>Pass</Button>
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
          ) : hasCleanDescription ? (
            <p className="whitespace-pre-wrap leading-relaxed">{currentTender.description}</p>
          ) : (
            <div className="rounded-lg border border-dashed border-line bg-surface-2 px-4 py-3 text-sm text-ink-muted">
              No detailed scope was provided on the portal listing page. Click <span className="font-semibold text-ink">Extract with AI</span> to analyze the portal page, or upload a tender notice image/PDF below.
            </div>
          )}
        </div>

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
                      </a>
                      {isPdf && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPreviewPdfIndex(previewPdfIndex === i ? null : i)}
                        >
                          {previewPdfIndex === i ? 'Hide preview' : 'Preview PDF'}
                        </Button>
                      )}
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
              {noteState === 'saving' ? 'Saving…' : noteState === 'saved' ? 'Saved' : noteState === 'failed' ? 'Could not save' : 'Saves when you click away'}
            </span>
          </div>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onBlur={saveNotes}
            rows={4}
            placeholder="Bank guarantee, partner contacts, site visit dates…"
            className="w-full rounded-lg border border-line bg-surface p-3 text-sm placeholder:text-ink-muted"
          />
        </div>
      </div>
    </div>
  );
}

export function InboxScreen(props: InboxScreenProps) {
  const { tenders, tracks, corrigenda, selectedTrack, searchQuery, bookmarkedOnly, corrigendumOnly } = props;
  const [sortBy, setSortBy] = useState<SortBy>('urgency');
  const [selectedId, setSelectedId] = useState<string | null>(props.focusId ?? null);
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
  useTick(60_000);

  const sorted = useMemo(() => {
    const list = [...tenders];
    if (sortBy === 'score') return list.sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
    if (sortBy === 'newest') {
      const time = (t: Tender) => (t.publish_date ? new Date(t.publish_date).getTime() : 0);
      return list.sort((a, b) => time(b) - time(a));
    }
    // Urgency: soonest open deadline first, closed ones after, no deadline last.
    const now = Date.now();
    const rank = (t: Tender) => {
      if (!t.closing_date) return Infinity;
      const at = new Date(t.closing_date).getTime();
      return at < now ? Number.MAX_SAFE_INTEGER - (now - at) : at;
    };
    return list.sort((a, b) => rank(a) - rank(b));
  }, [tenders, sortBy]);

  const withDeadline = sorted.filter(t => t.closing_date);
  const noDeadline = sorted.filter(t => !t.closing_date);
  const ordered = sortBy === 'urgency' ? [...withDeadline, ...noDeadline] : sorted;

  // Keep a selection. When the selected tender leaves the list, move to its neighbour.
  const selected = ordered.find(t => t.id === selectedId) ?? null;
  useEffect(() => {
    if (selected || ordered.length === 0) return;
    setSelectedId(ordered[0].id);
  }, [selected, ordered]);

  const act = (tender: Tender, status: OpportunityStatus) => {
    const index = ordered.findIndex(t => t.id === tender.id);
    const next = ordered[index + 1] ?? ordered[index - 1] ?? null;
    setSelectedId(next ? next.id : null);
    void props.onStatusChange(tender.id, status);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = ordered.findIndex(t => t.id === selectedId);
      const next = ordered[e.key === 'ArrowDown' ? i + 1 : i - 1];
      if (next) setSelectedId(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ordered, selectedId]);

  const activeFilters = (selectedTrack !== 'All' ? 1 : 0) + (bookmarkedOnly ? 1 : 0) + (corrigendumOnly ? 1 : 0);
  const filtering = activeFilters > 0 || searchQuery.trim() !== '';

  const firstNoDeadlineId = sortBy === 'urgency' ? noDeadline[0]?.id : undefined;

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

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Inbox</h1>
        <span className="font-mono text-sm text-ink-muted">{ordered.length}</span>

        <div className="relative ml-auto w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={searchQuery}
            onChange={e => props.onSearchChange(e.target.value)}
            placeholder="Search tenders"
            aria-label="Search tenders"
            className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 placeholder:text-ink-muted"
          />
        </div>

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

      {ordered.length === 0 ? (
        <Panel className="flex-1">
          <EmptyState
            icon={<Inbox className="h-8 w-8" />}
            title={filtering ? 'Nothing matches these filters' : 'Your Inbox is clear'}
            body={filtering ? 'Try removing a filter or clearing the search.' : 'New tenders from your portals will appear here after the next scan.'}
          />
        </Panel>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(340px,2fr)_3fr]">
          <Panel className="overflow-y-auto lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]">
            {ordered.map(t => (
              <React.Fragment key={t.id}>
                {t.id === firstNoDeadlineId && (
                  <div className="border-b border-line bg-surface-2 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-ink-muted">
                    No deadline stated
                  </div>
                )}
                <TenderRow tender={t} selected={t.id === selected?.id} onSelect={() => setSelectedId(t.id)} />
              </React.Fragment>
            ))}
          </Panel>
          <Panel className="overflow-hidden lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]">
            {selected && (
              <Detail
                tender={selected}
                corrigenda={corrigenda}
                onTrack={() => act(selected, 'Under Review')}
                onPass={() => act(selected, 'Passed')}
                onAcknowledgeCorrigendum={props.onAcknowledgeCorrigendum}
                onSaveNotes={props.onSaveNotes}
                onToggleBookmark={() => props.onToggleBookmark(selected.id)}
                onTenderUpdated={props.onTenderUpdated}
              />
            )}
          </Panel>
        </div>
      )}

      <Dialog
        open={addingManual}
        onClose={() => setAddingManual(false)}
        title="Add tender manually"
        footer={
          <>
            <Button onClick={() => setAddingManual(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={creatingManual || !manualForm.title.trim()}
              onClick={() => void handleCreateManualTender()}
            >
              {creatingManual ? 'Saving…' : 'Create tender'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {manualError && (
            <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
              {manualError}
            </div>
          )}

          <div className="rounded-lg border border-dashed border-line bg-surface-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="cursor-pointer text-xs font-semibold text-accent hover:underline">
                <input
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) void handleManualFilePicked(f);
                  }}
                />
                {manualFile ? `Attached: ${manualFile.filename}` : 'Attach tender notice image or PDF (optional)'}
              </label>
              {manualFile && (
                <Button size="sm" onClick={() => void handleAutoFillManualWithAi()} disabled={extractingManualAi}>
                  <Sparkles className="h-3.5 w-3.5" />
                  {extractingManualAi ? 'Extracting…' : 'Auto-fill with AI'}
                </Button>
              )}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Tender title *</span>
            <input
              value={manualForm.title}
              onChange={e => setManualForm({ ...manualForm, title: e.target.value })}
              placeholder="e.g. Procurement of Solar PV System for DHQ Hospital"
              className={fieldInputClass}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-muted">Organization</span>
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
                placeholder="e.g. PKR 15,000,000"
                className={fieldInputClass}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Summary / Scope</span>
            <textarea
              rows={3}
              value={manualForm.description}
              onChange={e => setManualForm({ ...manualForm, description: e.target.value })}
              placeholder="Key deliverables, eligibility criteria, bid security…"
              className={fieldInputClass}
            />
          </label>
        </div>
      </Dialog>
    </div>
  );
}
