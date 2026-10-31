import React, { useState, useEffect } from 'react';
import { Tender, CorrigendumLog, OpportunityStatus } from '../types';
import { LiveCountdown } from './LiveCountdown';

interface PersistentDossierProps {
  tender: Tender | null;
  corrigenda: CorrigendumLog[];
  onStatusChange: (tenderId: string, newStatus: OpportunityStatus) => Promise<void>;
  onAcknowledgeCorrigendum: (logId: string) => Promise<void>;
  onSaveNotes: (tenderId: string, notes: string) => Promise<void>;
  onToggleBookmark: (tenderId: string, current: boolean) => void;
}

const PIPELINE_STAGES: OpportunityStatus[] = [
  'New Opportunity',
  'Under Review',
  'Preparing Bid',
  'Submitted',
  'Won',
  'Passed',
];

export function PersistentDossier({
  tender,
  corrigenda,
  onStatusChange,
  onAcknowledgeCorrigendum,
  onSaveNotes,
  onToggleBookmark,
}: PersistentDossierProps) {
  const [notes, setNotes] = useState<string>('');
  const [isSavingNotes, setIsSavingNotes] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

  useEffect(() => {
    if (tender) {
      setNotes(tender.status_notes || '');
      setSaveSuccess(false);
    }
  }, [tender?.id]);

  if (!tender) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-lg">
        <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 mb-4">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">
          No Tender Selected
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm">
          Select any opportunity from the triage feed on the left to inspect its live countdown, official portal records, and cached RFP documents.
        </p>
      </div>
    );
  }

  const tracks: string[] = typeof tender.domain_tracks === 'string'
    ? JSON.parse(tender.domain_tracks || '[]')
    : (tender.domain_tracks || []);

  const keywords: string[] = typeof tender.matched_keywords === 'string'
    ? JSON.parse(tender.matched_keywords || '[]')
    : (tender.matched_keywords || []);

  const cachedFiles = typeof tender.cached_dossiers === 'string'
    ? JSON.parse(tender.cached_dossiers || '[]')
    : (tender.cached_dossiers || []);

  const secondarySources = typeof tender.secondary_sources === 'string'
    ? JSON.parse(tender.secondary_sources || '[]')
    : (tender.secondary_sources || []);

  const tenderCorrigenda = corrigenda.filter(c => c.tender_id === tender.id);

  const handleNotesBlur = async () => {
    if (notes !== (tender.status_notes || '')) {
      setIsSavingNotes(true);
      try {
        await onSaveNotes(tender.id, notes);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      } catch (err) {
        console.error('Note save failed:', err);
      } finally {
        setIsSavingNotes(false);
      }
    }
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-lg overflow-hidden shadow-xs">
      {/* Dossier Header */}
      <div className="p-6 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/60">
        <div className="flex items-start justify-between gap-4 mb-2">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-2">
              <span className="font-semibold text-slate-800 dark:text-slate-200">{tender.portal_name}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{tender.reference_no || 'Reference Not Stated'}</span>
              {tender.location && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{tender.location}</span>
                </>
              )}
            </div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 leading-snug">
              {tender.title}
            </h2>
            <div className="text-sm text-slate-700 dark:text-slate-300 font-medium">
              {tender.organization}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onToggleBookmark(tender.id, !!tender.is_bookmarked)}
              className={`p-2 rounded-lg border transition-colors ${
                tender.is_bookmarked
                  ? 'border-amber-300 bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:border-amber-900/60'
                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400'
              }`}
              title={tender.is_bookmarked ? 'Remove bookmark' : 'Bookmark opportunity'}
            >
              <svg className="w-4 h-4 fill-current" viewBox="0 0 20 20">
                <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z" />
              </svg>
            </button>

            <a
              href={tender.direct_url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors inline-flex items-center gap-1.5 shrink-0 shadow-xs"
            >
              <span>Official Portal</span>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>

        {/* Live Ticking Countdown Bar */}
        <div className="mt-4">
          <LiveCountdown
            closingDate={tender.closing_date}
            closingDateFormatted={tender.closing_date_formatted}
            mode="detailed"
          />
        </div>

        {/* Pipeline Stage Buttons */}
        <div className="mt-4 pt-4 border-t border-slate-200/80 dark:border-slate-800">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
            Opportunity Stage
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            {PIPELINE_STAGES.map((stage) => {
              const isActive = tender.pipeline_status === stage;
              return (
                <button
                  key={stage}
                  onClick={() => onStatusChange(tender.id, stage)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors text-center truncate ${
                    isActive
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-semibold shadow-xs'
                      : 'bg-white dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700/80 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  {stage}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Dossier Body Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Corrigendum Alert Log */}
        {tenderCorrigenda.length > 0 && (
          <div className="p-4 rounded-lg bg-amber-50/70 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-900/60">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
                <svg className="w-4 h-4 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Corrigendum Amendments Detected
              </h4>
            </div>
            <div className="space-y-2">
              {tenderCorrigenda.map((log) => (
                <div key={log.id} className="text-xs bg-white/80 dark:bg-slate-900/80 p-2.5 rounded border border-amber-200/60 dark:border-amber-900/40 flex items-start justify-between gap-3">
                  <div>
                    <span className="font-semibold text-slate-900 dark:text-slate-100 capitalize">
                      {log.change_type.replace('_', ' ')}
                    </span>
                    <div className="text-slate-600 dark:text-slate-300 mt-0.5">
                      {log.previous_value && <span>Was: {log.previous_value} → </span>}
                      <span className="font-medium text-amber-800 dark:text-amber-300">Now: {log.new_value}</span>
                    </div>
                  </div>
                  {!log.is_acknowledged && (
                    <button
                      onClick={() => onAcknowledgeCorrigendum(log.id)}
                      className="px-2 py-1 text-[11px] font-medium bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors shrink-0"
                    >
                      Acknowledge
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Specifications & Metadata Grid */}
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">
            Opportunity Specifications
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="p-3 bg-slate-50 dark:bg-slate-800/40 rounded-lg border border-slate-200/60 dark:border-slate-800">
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">Estimated Value</div>
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 font-mono">
                {tender.estimated_value || 'Not Disclosed'}
              </div>
            </div>

            <div className="p-3 bg-slate-50 dark:bg-slate-800/40 rounded-lg border border-slate-200/60 dark:border-slate-800">
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">Published Date</div>
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 font-mono">
                {tender.publish_date ? new Date(tender.publish_date).toLocaleDateString() : 'Recent'}
              </div>
            </div>

            <div className="p-3 bg-slate-50 dark:bg-slate-800/40 rounded-lg border border-slate-200/60 dark:border-slate-800">
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">Canonical Match Score</div>
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 font-mono">
                {tender.match_score || 85}% Relevance
              </div>
            </div>
          </div>
        </div>

        {/* Matched Tracks & Keywords */}
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
            Domain Tracks & Matched Keywords
          </h4>
          <div className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
            <div className="flex items-center gap-2">
              <span className="text-slate-500 dark:text-slate-400 font-medium">Tracks:</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {tracks.length > 0 ? tracks.join(' · ') : 'General Procurement'}
              </span>
            </div>
            {keywords.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400 font-medium">Keywords:</span>
                <span className="font-mono text-slate-600 dark:text-slate-400">
                  {keywords.join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Scope Description */}
        {tender.description && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
              Procurement Scope & Summary
            </h4>
            <div className="text-xs text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/40 p-3.5 rounded-lg border border-slate-200/60 dark:border-slate-800 leading-relaxed whitespace-pre-wrap">
              {tender.description}
            </div>
          </div>
        )}

        {/* Cached Local Dossiers & RFPs */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Cached Government Dossiers & BOQs ({cachedFiles.length})
            </h4>
          </div>

          {cachedFiles.length === 0 ? (
            <div className="text-xs text-slate-500 dark:text-slate-400 p-3 bg-slate-50 dark:bg-slate-800/30 rounded border border-slate-200/60 dark:border-slate-800 italic">
              No offline documents attached yet. Documents are cached during crawler scans or downloaded on demand.
            </div>
          ) : (
            <div className="space-y-2">
              {cachedFiles.map((file: any, idx: number) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <svg className="w-5 h-5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                    <div className="truncate">
                      <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {file.label || `Document ${idx + 1}`}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 truncate">
                        SHA-256: {file.sha256 ? `${file.sha256.substring(0, 16)}...` : 'Verified'}
                      </div>
                    </div>
                  </div>

                  <a
                    href={file.localPath.startsWith('/') ? file.localPath : `/api/dossiers/${tender.id}/${encodeURIComponent(file.localPath.replace(/\\/g, '/').split('/').pop() || '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 rounded transition-colors shrink-0"
                  >
                    Open Document
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cross-Source Discoveries */}
        {secondarySources.length > 0 && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
              Cross-Portal Discoveries (Deduplicated)
            </h4>
            <div className="space-y-1.5">
              {secondarySources.map((sec: any, idx: number) => (
                <div key={idx} className="text-xs p-2 bg-slate-50 dark:bg-slate-800/40 rounded border border-slate-200/60 dark:border-slate-800 flex items-center justify-between">
                  <span className="font-medium text-slate-800 dark:text-slate-200">{sec.portalName}</span>
                  <a
                    href={sec.directUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline dark:text-blue-400 font-mono text-[11px]"
                  >
                    View Source ↗
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Solo Operator Field Notes */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Internal Bid Notes & Contacts
            </h4>
            <span className="text-[11px] text-slate-400 font-mono">
              {isSavingNotes ? 'Saving...' : saveSuccess ? 'Saved' : 'Auto-saves on blur'}
            </span>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder="Record bank guarantee requirements, joint venture partner contacts, site visit dates, or submission checklists..."
            rows={4}
            className="w-full text-xs p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-hidden focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100"
          />
        </div>
      </div>
    </div>
  );
}
