import React, { useState, useEffect } from 'react';
import { X, ExternalLink, Download, FileText, CheckCircle2, Clock, MapPin, DollarSign, AlertTriangle, Layers, Save } from 'lucide-react';
import { OpportunityStatus, Tender } from '../types';

interface TenderDrawerProps {
  tender: Tender | null;
  onClose: () => void;
  onUpdateStatus: (tenderId: string, newStatus: OpportunityStatus) => void;
  onSaveNotes: (tenderId: string, notes: string) => void;
}

export const TenderDrawer: React.FC<TenderDrawerProps> = ({
  tender,
  onClose,
  onUpdateStatus,
  onSaveNotes
}) => {
  const [notes, setNotes] = useState('');
  const [notesSaved, setNotesSaved] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tender) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tender, onClose]);

  useEffect(() => {
    if (tender) {
      setNotes(tender.status_notes || '');
      setNotesSaved(false);
    }
  }, [tender]);

  if (!tender) return null;

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNotes(e.target.value);
    setNotesSaved(false);
  };

  const handleSaveNotesClick = () => {
    onSaveNotes(tender.id, notes);
    setNotesSaved(true);
    setTimeout(() => setNotesSaved(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs transition-opacity" onClick={onClose}>
      <div 
        className="w-full max-w-xl h-full bg-white dark:bg-slate-900 shadow-2xl flex flex-col border-l border-slate-200 dark:border-slate-800 transition-colors"
        onClick={e => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-blue-600 dark:text-blue-400 font-semibold">
                {tender.reference_no || 'Tender Reference Unassigned'}
              </span>
              {tender.has_corrigendum === 1 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/60 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-800">
                  <AlertTriangle className="w-3 h-3 text-amber-500" />
                  Corrigendum Active
                </span>
              )}
            </div>
            <h2 className="mt-1 text-sm font-bold text-slate-900 dark:text-white leading-snug">
              {tender.title}
            </h2>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {tender.organization} · <span className="font-medium text-slate-600 dark:text-slate-300">{tender.portal_name}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {/* Status Progression Bar */}
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
            <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2">
              Opportunity Pipeline Status
            </label>
            <div className="flex items-center gap-2">
              <select
                value={tender.pipeline_status}
                onChange={e => onUpdateStatus(tender.id, e.target.value as OpportunityStatus)}
                className="flex-1 text-xs font-semibold py-1.5 px-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="New Opportunity">New Opportunity</option>
                <option value="Under Review">Under Review</option>
                <option value="Preparing Bid">Preparing Bid</option>
                <option value="Submitted">Submitted</option>
                <option value="Won">Won (Contract Awarded)</option>
                <option value="Passed">Passed (Not Pursuing)</option>
              </select>
            </div>
          </div>

          {/* Quick Specifications Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-medium">
                <Clock className="w-3.5 h-3.5" />
                <span>Closing Deadline</span>
              </div>
              <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-white">
                {tender.closing_date_formatted}
              </div>
            </div>

            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-medium">
                <DollarSign className="w-3.5 h-3.5" />
                <span>Estimated Value</span>
              </div>
              <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-white">
                {tender.estimated_value || 'Not Disclosed'}
              </div>
            </div>

            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-medium">
                <MapPin className="w-3.5 h-3.5" />
                <span>Location / Jurisdiction</span>
              </div>
              <div className="mt-1 font-medium text-slate-900 dark:text-white">
                {tender.location || 'Pakistan'}
              </div>
            </div>

            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />
                <span>Domain Match</span>
              </div>
              <div className="mt-1 font-medium text-slate-900 dark:text-white">
                {tender.match_score}% Score
              </div>
            </div>
          </div>

          {/* Matched Keywords */}
          <div>
            <h4 className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              Matched Domain Tracks &amp; Terms
            </h4>
            <div className="text-xs text-slate-700 dark:text-slate-300">
              <span className="font-semibold">{tender.domain_tracks.join(' / ')}</span>
              <span className="text-slate-400 mx-2">·</span>
              <span>Matched on: {tender.matched_keywords.join(' · ')}</span>
            </div>
          </div>

          {/* Scope & Description */}
          <div>
            <h4 className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              Procurement Scope &amp; Summary
            </h4>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-line">
              {tender.description}
            </div>
          </div>

          {/* Offline-Safe Local Dossiers & RFP Attachments */}
          <div>
            <h4 className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              Bidding Dossiers &amp; RFP Documents
            </h4>
            <div className="space-y-2">
              {tender.cached_dossiers && tender.cached_dossiers.length > 0 ? (
                tender.cached_dossiers.map((doc, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-800 flex items-center justify-between gap-3 shadow-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                      <div>
                        <div className="font-medium text-slate-900 dark:text-white">{doc.label}</div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          SHA-256: {doc.sha256.slice(0, 12)}... · Offline Cached
                        </div>
                      </div>
                    </div>
                    <a
                      href={doc.localPath.startsWith('/') ? doc.localPath : `/api/dossiers/${tender.id}/${encodeURIComponent(doc.localPath.replace(/\\/g, '/').split('/').pop() || '')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2.5 py-1 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900 text-blue-700 dark:text-blue-300 rounded font-medium flex items-center gap-1 transition-colors"
                    >
                      <Download className="w-3 h-3" />
                      <span>Open Local File</span>
                    </a>
                  </div>
                ))
              ) : (
                <div className="p-3 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-slate-500 text-center">
                  <span>Dossier available directly on issuing authority portal</span>
                </div>
              )}

              <a
                href={tender.direct_url}
                target="_blank"
                rel="noreferrer"
                className="w-full py-2 px-3 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium flex items-center justify-center gap-2 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open Official Government Notice ({tender.portal_name})</span>
              </a>
            </div>
          </div>

          {/* Secondary Sources (Deduplication Trail) */}
          {tender.secondary_sources && tender.secondary_sources.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-blue-500" />
                <span>Cross-Source Deduplication Trail</span>
              </h4>
              <div className="space-y-1 text-slate-600 dark:text-slate-400 text-[11px]">
                {tender.secondary_sources.map((s, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <span>Also discovered on: <strong className="text-slate-800 dark:text-slate-200">{s.portalName}</strong></span>
                    <a href={s.directUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                      View Source
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Solo Operator Internal Notes */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Operator Bid Preparation Notes
              </h4>
              <button
                onClick={handleSaveNotesClick}
                className="text-[11px] text-blue-600 dark:text-blue-400 font-semibold flex items-center gap-1 hover:underline cursor-pointer"
              >
                <Save className="w-3 h-3" />
                <span>{notesSaved ? 'Saved!' : 'Save Notes'}</span>
              </button>
            </div>
            <textarea
              rows={4}
              value={notes}
              onChange={handleNotesChange}
              placeholder="Record your bid evaluation notes, pricing strategy, subcontractor quotes, or submission checklist..."
              className="w-full p-2.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
