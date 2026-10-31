import React from 'react';
import { Tender } from '../types';
import { LiveCountdown } from './LiveCountdown';

interface TenderFeedItemProps {
  tender: Tender;
  isSelected: boolean;
  onSelect: (tender: Tender) => void;
  onToggleBookmark: (tenderId: string, current: boolean, e: React.MouseEvent) => void;
}

export function TenderFeedItem({
  tender,
  isSelected,
  onSelect,
  onToggleBookmark,
}: TenderFeedItemProps) {
  const tracks: string[] = typeof tender.domain_tracks === 'string'
    ? JSON.parse(tender.domain_tracks || '[]')
    : (tender.domain_tracks || []);

  const cachedFiles = typeof tender.cached_dossiers === 'string'
    ? JSON.parse(tender.cached_dossiers || '[]')
    : (tender.cached_dossiers || []);

  return (
    <div
      onClick={() => onSelect(tender)}
      className={`group relative p-4 transition-all cursor-pointer border-b border-slate-200/80 dark:border-slate-800 ${
        isSelected
          ? 'bg-slate-50/90 dark:bg-slate-800/70 border-l-3 border-l-slate-900 dark:border-l-slate-100'
          : 'bg-white dark:bg-slate-900/40 hover:bg-slate-50/50 dark:hover:bg-slate-800/30'
      }`}
    >
      {/* Top Metadata Row: Zero-pill typographic metadata */}
      <div className="flex items-center justify-between gap-2 mb-1.5 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-1.5 truncate">
          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
            {tender.portal_name}
          </span>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">·</span>
          <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400 truncate">
            {tender.reference_no || 'No Ref #'}
          </span>
          {tender.location && (
            <>
              <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">·</span>
              <span className="truncate">{tender.location}</span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={(e) => onToggleBookmark(tender.id, !!tender.is_bookmarked, e)}
          className={`shrink-0 p-1 rounded hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors ${
            tender.is_bookmarked
              ? 'text-amber-500'
              : 'text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400'
          }`}
          title={tender.is_bookmarked ? 'Remove bookmark' : 'Bookmark opportunity'}
          aria-label={tender.is_bookmarked ? 'Bookmarked' : 'Not bookmarked'}
        >
          <svg className="w-4 h-4 fill-current" viewBox="0 0 20 20">
            <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z" />
          </svg>
        </button>
      </div>

      {/* Tender Title */}
      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 line-clamp-2 leading-snug mb-1">
        {tender.title}
      </h4>

      {/* Procuring Organization */}
      <p className="text-xs text-slate-600 dark:text-slate-300 truncate mb-2.5">
        {tender.organization}
      </p>

      {/* Corrigendum Alert Notice (if any) */}
      {Boolean(tender.has_corrigendum) && (
        <div className="mb-2 py-1 px-2 text-[11px] font-medium bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-900/50 dark:text-amber-300 rounded flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>Corrigendum Amendment Logged</span>
        </div>
      )}

      {/* Bottom Row: Domain Tracks, Cached Dossier Count, Countdown */}
      <div className="flex items-center justify-between gap-3 text-xs pt-1 border-t border-slate-100 dark:border-slate-800/80">
        <div className="flex items-center gap-2 truncate text-slate-500 dark:text-slate-400">
          {tracks.length > 0 ? (
            <span className="font-medium text-slate-700 dark:text-slate-300 truncate">
              {tracks.join(' · ')}
            </span>
          ) : (
            <span className="text-slate-400 dark:text-slate-500 italic">General Track</span>
          )}

          {cachedFiles.length > 0 && (
            <>
              <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">·</span>
              <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 font-mono text-[11px]">
                <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                {cachedFiles.length} {cachedFiles.length === 1 ? 'doc' : 'docs'}
              </span>
            </>
          )}
        </div>

        {/* Live Ticking Countdown */}
        <div className="shrink-0 text-right">
          <LiveCountdown
            closingDate={tender.closing_date}
            closingDateFormatted={tender.closing_date_formatted}
            mode="compact"
          />
        </div>
      </div>
    </div>
  );
}
