import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Download,
  Inbox,
  Plus,
  Search,
  SlidersHorizontal,
  Undo2,
  X
} from 'lucide-react';
import { Tender, DomainTrack, CorrigendumLog, OpportunityStatus, PortalHealth, DocumentQueueStatus } from '../../shared/types';
import { getPktDateKey } from '../../shared/pktDate';
import { Button, EmptyState, Panel, Popover } from '../ui';
import { DeadlineRunway, PortalPills, PortalSummaryItem, Detail, TenderRow, AddTenderModal, useTick } from './inbox';
import { formatRelativeAge } from '../utils/format';

export {
  Detail,
  getTenderDocProcessingState,
  deadlineProvenance,
  humanReviewReason,
  asList,
  useTick
} from './inbox';

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
  portals?: PortalHealth[];
  docQueue?: DocumentQueueStatus;
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
  const [urgent48hOnly, setUrgent48hOnly] = useState(false);
  const [viewedIds, setViewedIds] = useState<Set<string>>(() => new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [deletingClosed, setDeletingClosed] = useState(false);

  // Undo Toast state
  const [undoItem, setUndoItem] = useState<{ tender: Tender; status: OpportunityStatus } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Manual Tender Modal state
  const [addingManual, setAddingManual] = useState(false);

  const now = useTick(30_000);

  useEffect(() => {
    if (props.focusId) {
      setSelectedId(props.focusId);
    }
  }, [props.focusId]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
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
  // Closed = deadline passed, or undated and first published/seen over 90 days ago. Bookmarked
  // tenders are never treated as closed. Closed tenders are always hidden unless the operator
  // turns on "Show closed" (previously they were shown as normal whenever no open tender
  // remained, so an all-expired Inbox looked active).
  const isClosedUntracked = (t: Tender) => {
    // Flagged tenders stay visible until the operator confirms or passes them (decision 1).
    if (t.is_bookmarked || t.needs_review) return false;
    if (t.closing_date && new Date(t.closing_date).getTime() < now) return true;
    const seenAt = (t.publish_date_source === 'upload_folder' ? t.created_at : t.publish_date) || t.created_at;
    if (!t.closing_date && seenAt && now - new Date(seenAt).getTime() > 90 * 86400000) return true;
    return false;
  };

  const portalNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of props.portals || []) {
      map.set(p.portal_id, p.portal_name);
    }
    return map;
  }, [props.portals]);

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
          portal_name: portalNameById.get(pid) || t.portal_name || pid,
          total_count: 1,
          unread_count: isUnread ? 1 : 0
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.unread_count - a.unread_count || b.total_count - a.total_count);
  }, [activeTenders, showClosedTenders, viewedIds, portalNameById]);

  useEffect(() => {
    if (selectedPortalId !== 'All' && !computedPortalSummary.some(p => p.portal_id === selectedPortalId)) {
      setSelectedPortalId('All');
    }
  }, [selectedPortalId, computedPortalSummary]);

  const portalSummary = computedPortalSummary;

  // Tenders closing within 48 hours (proactive urgent triage queue)
  const urgent48hCount = useMemo(() => {
    const cutoff = now + 48 * 3600000;
    return activeTenders.filter(t => {
      if (!t.closing_date) return false;
      const ms = new Date(t.closing_date).getTime();
      return !Number.isNaN(ms) && ms > now && ms <= cutoff;
    }).length;
  }, [activeTenders, now]);

  // Tenders matching active category filters
  const filteredTenders = useMemo(() => {
    const urgentCutoff = now + 48 * 3600000;
    return activeTenders.filter(t => {
      // 1. Unread filter
      if (unreadOnly && isTenderViewed(t)) return false;

      // 1b. Closing <= 48h urgent filter
      if (urgent48hOnly) {
        if (!t.closing_date) return false;
        const ms = new Date(t.closing_date).getTime();
        if (Number.isNaN(ms) || ms <= now || ms > urgentCutoff) return false;
      }

      // 2. Portal filter
      if (selectedPortalId !== 'All' && t.portal_id !== selectedPortalId) {
        return false;
      }

      // 3. Runway date filter (PKT calendar day)
      if (selectedRunwayDate !== null && (!t.closing_date || getPktDateKey(t.closing_date) !== selectedRunwayDate)) {
        return false;
      }

      return true;
    });
  }, [activeTenders, unreadOnly, urgent48hOnly, now, viewedIds, selectedPortalId, selectedRunwayDate]);

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

  // Tenders flagged for review (e.g. a corrigendum moved the deadline earlier) always come first.
  const { ordered, firstNoDeadlineId } = useMemo(() => {
    const withDeadline = sorted.filter(t => t.closing_date);
    const noDeadline = sorted.filter(t => !t.closing_date);
    const orderedBase = sortBy === 'urgency' ? [...withDeadline, ...noDeadline] : sorted;
    return {
      ordered: [...orderedBase.filter(t => t.needs_review), ...orderedBase.filter(t => !t.needs_review)],
      firstNoDeadlineId: sortBy === 'urgency' ? noDeadline[0]?.id : undefined
    };
  }, [sorted, sortBy]);

  const expiredTenders = useMemo(() => {
    return ordered.filter(t => t.closing_date && new Date(t.closing_date).getTime() <= now);
  }, [ordered, now]);

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

    setUndoItem({ tender, status });
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
    (unreadOnly ? 1 : 0) +
    (urgent48hOnly ? 1 : 0);
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

  const totalUnreadAll = portalSummary.reduce((sum, p) => sum + (p.unread_count || 0), 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      {/* 1. Top Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Inbox</h1>
        <span className="font-mono text-sm text-ink-muted">{ordered.length}</span>
        {props.portals && props.portals.length > 0 && (
          <span className="text-xs text-ink-muted" data-testid="sources-checked-summary">
            ({props.portals.filter(p => p.status === 'online').length} of {props.portals.length} sources checked successfully
            {(() => {
              const latestSuccess = props.portals.map(p => p.last_success_at).filter(Boolean).sort().reverse()[0];
              if (!latestSuccess) return '';
              return ` · last success ${formatRelativeAge(latestSuccess, { compactHours: true })}`;
            })()})
          </span>
        )}
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

        <Button onClick={() => setAddingManual(true)}>
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

          {(urgent48hCount > 0 || urgent48hOnly) && (
            <button
              type="button"
              onClick={() => setUrgent48hOnly(v => !v)}
              aria-pressed={urgent48hOnly}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                urgent48hOnly
                  ? 'bg-danger text-white'
                  : 'border border-danger/30 bg-danger-soft text-danger hover:opacity-90'
              }`}
              title="Filter opportunities closing within the next 48 hours"
            >
              Closing ≤48h ({urgent48hCount})
            </button>
          )}

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
                if (urgent48hOnly) setUrgent48hOnly(false);
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
              <Fragment key={t.id}>
                {t.id === firstNoDeadlineId && (
                  <div className="border-b border-line bg-surface-2 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-ink-muted">
                    No deadline stated
                  </div>
                )}
                <TenderRow
                  tender={t}
                  docQueue={props.docQueue}
                  selected={t.id === selected?.id}
                  unread={!isTenderViewed(t)}
                  onSelect={() => {
                    setSelectedId(t.id);
                    markViewed(t.id);
                  }}
                />
              </Fragment>
            ))}
          </Panel>

          <Panel className="overflow-hidden lg:sticky lg:top-4 lg:h-[calc(100vh-14.5rem)]">
            {selected && (
              <Detail
                tender={selected}
                corrigenda={corrigenda}
                docQueue={props.docQueue}
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
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line bg-surface px-4 py-2.5 shadow-2xl"
        >
          <span className="text-xs font-semibold text-ink">
            Moved to {undoItem.status}: "{undoItem.tender.title.slice(0, 32)}..."
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

      {/* Manual Tender Modal */}
      <AddTenderModal
        open={addingManual}
        onClose={() => setAddingManual(false)}
        onTenderCreated={tender => {
          props.onTenderCreated?.(tender);
          setSelectedId(tender.id);
        }}
      />
    </div>
  );
}
