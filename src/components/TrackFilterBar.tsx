import React from 'react';
import { Search, LayoutGrid, List, SlidersHorizontal, Download, Bookmark, AlertTriangle, Columns } from 'lucide-react';
import { DomainTrack } from '../types';

interface TrackFilterBarProps {
  tracks: DomainTrack[];
  selectedTrack: string;
  onSelectTrack: (trackName: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedStatus: string;
  onStatusChange: (status: string) => void;
  bookmarkedOnly: boolean;
  onToggleBookmarked: () => void;
  corrigendumOnly: boolean;
  onToggleCorrigendum: () => void;
  currentView: 'split' | 'table' | 'kanban';
  onViewChange: (view: 'split' | 'table' | 'kanban') => void;
  onOpenTrackModal: () => void;
  onExportCsv: () => void;
  onClearDatabase?: () => void;
}

export const TrackFilterBar: React.FC<TrackFilterBarProps> = ({
  tracks,
  selectedTrack,
  onSelectTrack,
  searchQuery,
  onSearchChange,
  selectedStatus,
  onStatusChange,
  bookmarkedOnly,
  onToggleBookmarked,
  corrigendumOnly,
  onToggleCorrigendum,
  currentView,
  onViewChange,
  onOpenTrackModal,
  onExportCsv,
  onClearDatabase
}) => {
  return (
    <div className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 sm:px-6 lg:px-8 py-3 transition-colors">
      <div className="max-w-7xl mx-auto flex flex-col gap-3">
        {/* Row 1: Dynamic Domain Track Segmented Buttons */}
        <div className="flex items-center justify-between gap-3 overflow-x-auto pb-1 scrollbar-none">
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => onSelectTrack('All')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                selectedTrack === 'All'
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 shadow-xs'
                  : 'bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              All Domains
            </button>
            {tracks.map(track => {
              const isSelected = selectedTrack === track.name;
              return (
                <button
                  key={track.id}
                  onClick={() => onSelectTrack(track.name)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-semibold shadow-xs'
                      : 'bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {track.name}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onClearDatabase && (
              <button
                onClick={onClearDatabase}
                title="Wipe database to start 100% clean with live data only"
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-red-600 hover:border-red-300 dark:hover:border-red-800 text-xs font-medium transition-colors cursor-pointer"
              >
                Clear Slate
              </button>
            )}
            <button
              onClick={onOpenTrackModal}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Edit Tracks</span>
            </button>
            <button
              onClick={onExportCsv}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Row 2: Search Box + Filters + View Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative flex-1 min-w-[260px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => onSearchChange(e.target.value)}
              placeholder="Search by tender title, organization, or ref #..."
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100 transition-colors shadow-xs"
            />
          </div>

          {/* Filter Dropdown & Toggles */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Status Dropdown */}
            <select
              value={selectedStatus}
              onChange={e => onStatusChange(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-1 focus:ring-slate-900 font-medium cursor-pointer shadow-xs"
            >
              <option value="All">All Statuses</option>
              <option value="New Opportunity">New Opportunity</option>
              <option value="Under Review">Under Review</option>
              <option value="Preparing Bid">Preparing Bid</option>
              <option value="Submitted">Submitted</option>
              <option value="Won">Won</option>
              <option value="Passed">Passed</option>
            </select>

            {/* Bookmarked Filter */}
            <button
              onClick={onToggleBookmarked}
              className={`px-2.5 py-1.5 text-xs rounded-lg border flex items-center gap-1.5 font-medium transition-colors cursor-pointer shadow-xs ${
                bookmarkedOnly
                  ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Bookmark className={`w-3.5 h-3.5 ${bookmarkedOnly ? 'fill-amber-500 text-amber-500' : ''}`} />
              <span>Bookmarked</span>
            </button>

            {/* Corrigendum Only Filter */}
            <button
              onClick={onToggleCorrigendum}
              className={`px-2.5 py-1.5 text-xs rounded-lg border flex items-center gap-1.5 font-medium transition-colors cursor-pointer shadow-xs ${
                corrigendumOnly
                  ? 'border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              <span>Corrigenda</span>
            </button>

            {/* View Switcher: Split-Pane (Default) vs Table vs Kanban */}
            <div className="flex items-center p-0.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/80 ml-1">
              <button
                onClick={() => onViewChange('split')}
                title="Split-Pane Command Center"
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  currentView === 'split'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Columns className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Split</span>
              </button>
              <button
                onClick={() => onViewChange('table')}
                title="High-Density Table View"
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  currentView === 'table'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <List className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Table</span>
              </button>
              <button
                onClick={() => onViewChange('kanban')}
                title="Kanban Pipeline Board"
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  currentView === 'kanban'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Kanban</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
