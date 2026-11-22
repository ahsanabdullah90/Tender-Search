import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Globe, Search, Check, X } from 'lucide-react';

export interface PortalSummaryItem {
  portal_id: string;
  portal_name: string;
  total_count: number;
  unread_count: number;
}

interface PortalPillsProps {
  summary: PortalSummaryItem[];
  selectedPortalId: string; // 'All' or specific portal_id
  onSelectPortal: (portalId: string) => void;
  totalActiveCount: number;
  totalUnreadCount: number;
}

export function PortalPills({
  summary,
  selectedPortalId,
  onSelectPortal,
  totalActiveCount,
  totalUnreadCount
}: PortalPillsProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

  // Top 5 busiest portals sorted by total_count descending
  const sortedSummary = [...summary].sort((a, b) => b.total_count - a.total_count);
  const top5 = sortedSummary.slice(0, 5);
  const remaining = sortedSummary.slice(5);

  // Check if currently selected portal is in the "remaining" list
  const selectedInRemaining = remaining.find(p => p.portal_id === selectedPortalId);

  const filteredRemaining = remaining.filter(p =>
    p.portal_name.toLowerCase().includes(searchFilter.toLowerCase()) ||
    p.portal_id.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3 pt-1">
      {/* All Portals Pill */}
      <button
        type="button"
        onClick={() => onSelectPortal('All')}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-semibold transition ${
          selectedPortalId === 'All'
            ? 'bg-accent text-accent-ink shadow-sm'
            : 'bg-surface border border-line text-ink hover:bg-surface-2'
        }`}
      >
        <Globe className="h-3.5 w-3.5" />
        <span>All Portals</span>
        {totalUnreadCount > 0 ? (
          <span
            className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
              selectedPortalId === 'All'
                ? 'bg-accent-ink/20 text-accent-ink'
                : 'bg-accent text-accent-ink'
            }`}
          >
            {totalUnreadCount}
          </span>
        ) : (
          <span className="ml-1 opacity-70">({totalActiveCount})</span>
        )}
      </button>

      {/* Top 5 Portals */}
      {top5.map((p) => {
        const isSelected = selectedPortalId === p.portal_id;
        return (
          <button
            key={p.portal_id}
            type="button"
            onClick={() => onSelectPortal(isSelected ? 'All' : p.portal_id)}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${
              isSelected
                ? 'bg-accent text-accent-ink shadow-sm'
                : 'bg-surface border border-line text-ink hover:bg-surface-2'
            }`}
          >
            <span className="truncate max-w-[140px]">{p.portal_name.replace(/\(.*?\)/g, '').trim()}</span>
            {p.unread_count > 0 ? (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  isSelected
                    ? 'bg-accent-ink/20 text-accent-ink'
                    : 'bg-accent text-accent-ink'
                }`}
              >
                {p.unread_count}
              </span>
            ) : (
              <span className="opacity-60 text-[11px]">({p.total_count})</span>
            )}
          </button>
        );
      })}

      {/* More Portals Dropdown / Selected Other Portal */}
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${
            selectedInRemaining
              ? 'bg-accent text-accent-ink shadow-sm'
              : 'bg-surface border border-line text-ink-muted hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {selectedInRemaining ? (
            <>
              <span className="truncate max-w-[130px]">{selectedInRemaining.portal_name}</span>
              {selectedInRemaining.unread_count > 0 && (
                <span className="rounded-full bg-accent-ink/20 px-1.5 text-[10px] text-accent-ink">
                  {selectedInRemaining.unread_count}
                </span>
              )}
            </>
          ) : (
            <>
              <span>More portals</span>
              {remaining.reduce((sum, p) => sum + p.unread_count, 0) > 0 && (
                <span className="rounded-full bg-accent text-accent-ink px-1.5 text-[10px]">
                  {remaining.reduce((sum, p) => sum + p.unread_count, 0)}
                </span>
              )}
            </>
          )}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>

        {/* Dropdown Menu */}
        {dropdownOpen && (
          <div className="absolute left-0 top-full z-30 mt-1.5 w-72 rounded-xl border border-line bg-surface p-2 shadow-lg">
            {/* Search filter in popover */}
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-muted" />
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Find portal..."
                className="w-full rounded-lg border border-line bg-surface-2 py-1.5 pl-8 pr-2 text-xs text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none"
                autoFocus
              />
            </div>

            {/* Portal list */}
            <div className="max-h-60 overflow-y-auto space-y-0.5">
              {filteredRemaining.length === 0 ? (
                <div className="py-3 text-center text-xs text-ink-muted">No portals found</div>
              ) : (
                filteredRemaining.map((p) => {
                  const isCurrent = selectedPortalId === p.portal_id;
                  return (
                    <button
                      key={p.portal_id}
                      type="button"
                      onClick={() => {
                        onSelectPortal(p.portal_id);
                        setDropdownOpen(false);
                      }}
                      className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-left transition ${
                        isCurrent
                          ? 'bg-accent-soft font-semibold text-accent'
                          : 'text-ink hover:bg-surface-2'
                      }`}
                    >
                      <span className="truncate pr-2">{p.portal_name}</span>
                      <div className="flex items-center gap-1.5 flex-shrink-0 font-mono">
                        {p.unread_count > 0 && (
                          <span className="rounded-full bg-accent text-accent-ink px-1.5 py-0.5 text-[10px] font-bold">
                            {p.unread_count}
                          </span>
                        )}
                        <span className="text-[11px] text-ink-muted">({p.total_count})</span>
                        {isCurrent && <Check className="h-3.5 w-3.5 text-accent" />}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {selectedInRemaining && (
              <div className="mt-2 border-t border-line pt-1.5">
                <button
                  type="button"
                  onClick={() => {
                    onSelectPortal('All');
                    setDropdownOpen(false);
                  }}
                  className="flex w-full cursor-pointer items-center justify-center gap-1 py-1 text-xs font-semibold text-danger hover:bg-danger-soft rounded-lg"
                >
                  <X className="h-3 w-3" />
                  Clear portal filter
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
