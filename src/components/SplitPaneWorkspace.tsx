import React, { useState, useMemo } from 'react';
import { Tender, CorrigendumLog, OpportunityStatus } from '../types';
import { TenderFeedItem } from './TenderFeedItem';
import { PersistentDossier } from './PersistentDossier';

interface SplitPaneWorkspaceProps {
  tenders: Tender[];
  selectedTender: Tender | null;
  onSelectTender: (tender: Tender | null) => void;
  corrigenda: CorrigendumLog[];
  onStatusChange: (tenderId: string, newStatus: OpportunityStatus) => Promise<void>;
  onAcknowledgeCorrigendum: (logId: string) => Promise<void>;
  onSaveNotes: (tenderId: string, notes: string) => Promise<void>;
  onToggleBookmark: (tenderId: string, current: boolean) => void;
}

export function SplitPaneWorkspace({
  tenders,
  selectedTender,
  onSelectTender,
  corrigenda,
  onStatusChange,
  onAcknowledgeCorrigendum,
  onSaveNotes,
  onToggleBookmark,
}: SplitPaneWorkspaceProps) {
  const [sortBy, setSortBy] = useState<'deadline' | 'score' | 'newest'>(() => {
    return (localStorage.getItem('sentinel_sortBy') as any) || 'deadline';
  });

  const handleSortChange = (newSort: 'deadline' | 'score' | 'newest') => {
    setSortBy(newSort);
    localStorage.setItem('sentinel_sortBy', newSort);
  };

  // Sorted tenders
  const sortedTenders = useMemo(() => {
    return [...tenders].sort((a, b) => {
      if (sortBy === 'deadline') {
        if (!a.closing_date) return 1;
        if (!b.closing_date) return -1;
        return new Date(a.closing_date).getTime() - new Date(b.closing_date).getTime();
      }
      if (sortBy === 'score') {
        return (b.match_score || 0) - (a.match_score || 0);
      }
      // Newest
      const aTime = a.publish_date ? new Date(a.publish_date).getTime() : 0;
      const bTime = b.publish_date ? new Date(b.publish_date).getTime() : 0;
      return bTime - aTime;
    });
  }, [tenders, sortBy]);

  // Keyboard navigation (ArrowUp / ArrowDown) across triage feed
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const currentIndex = sortedTenders.findIndex(t => t.id === selectedTender?.id);
        if (currentIndex < sortedTenders.length - 1) {
          onSelectTender(sortedTenders[currentIndex + 1]);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const currentIndex = sortedTenders.findIndex(t => t.id === selectedTender?.id);
        if (currentIndex > 0) {
          onSelectTender(sortedTenders[currentIndex - 1]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sortedTenders, selectedTender, onSelectTender]);

  // If no tender is selected but list has items, auto-select the first one for instantaneous preview
  React.useEffect(() => {
    if (!selectedTender && sortedTenders.length > 0) {
      onSelectTender(sortedTenders[0]);
    }
  }, [selectedTender, sortedTenders, onSelectTender]);

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-[calc(100vh-260px)] min-h-[550px]">
      {/* Left Pane: Triage Feed (45% on desktop) */}
      <div className="w-full lg:w-[45%] xl:w-[42%] flex flex-col bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-lg overflow-hidden shadow-xs">
        {/* Triage Feed Header */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 flex items-center justify-between gap-3">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            Triage Queue
            <span className="ml-1.5 font-mono text-slate-400 font-normal">
              ({sortedTenders.length})
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => handleSortChange(e.target.value as any)}
              className="text-xs py-1 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100"
            >
              <option value="deadline">Urgent Cutoff</option>
              <option value="score">Relevance Score</option>
              <option value="newest">Latest Published</option>
            </select>
          </div>
        </div>

        {/* Triage Feed Scrollable List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
          {sortedTenders.length === 0 ? (
            <div className="p-8 text-center text-slate-500 dark:text-slate-400">
              <svg className="w-10 h-10 mx-auto mb-2 text-slate-300 dark:text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <p className="text-xs font-medium">No opportunities match current filters</p>
              <p className="text-[11px] text-slate-400 mt-1">Try switching domain tracks or clearing search terms.</p>
            </div>
          ) : (
            sortedTenders.map((tender) => (
              <TenderFeedItem
                key={tender.id}
                tender={tender}
                isSelected={selectedTender?.id === tender.id}
                onSelect={onSelectTender}
                onToggleBookmark={(id, cur, e) => {
                  e.stopPropagation();
                  onToggleBookmark(id, cur);
                }}
              />
            ))
          )}
        </div>
      </div>

      {/* Right Pane: Persistent Reading Dossier (55% on desktop) */}
      <div className="w-full lg:w-[55%] xl:w-[58%] h-full">
        <PersistentDossier
          tender={selectedTender}
          corrigenda={corrigenda}
          onStatusChange={onStatusChange}
          onAcknowledgeCorrigendum={onAcknowledgeCorrigendum}
          onSaveNotes={onSaveNotes}
          onToggleBookmark={onToggleBookmark}
        />
      </div>
    </div>
  );
}
