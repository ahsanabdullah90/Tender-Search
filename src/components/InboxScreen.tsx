import React, { useEffect, useMemo, useState } from 'react';
import { Bookmark, ExternalLink, FileText, Inbox, Search, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { Tender, DomainTrack, CorrigendumLog, OpportunityStatus } from '../types';
import { Button, Chip, DeadlineChip, EmptyState, Panel, Popover } from '../ui';

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
}) {
  useTick(1000);
  const [notes, setNotes] = useState(tender.status_notes || '');
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    setNotes(tender.status_notes || '');
    setNoteState('idle');
  }, [tender.id]);

  const keywords = asList<string>(tender.matched_keywords);
  const files = asList<{ label?: string; localPath: string }>(tender.cached_dossiers);
  const otherSources = asList<{ portalName: string; directUrl: string }>(tender.secondary_sources);
  const amendments = corrigenda.filter(c => c.tender_id === tender.id);
  const countdown = formatCountdown(tender.closing_date);
  const urgent = tender.closing_date ? new Date(tender.closing_date).getTime() - Date.now() < 86_400_000 : false;

  const saveNotes = async () => {
    if (notes === (tender.status_notes || '')) return;
    setNoteState('saving');
    try {
      await onSaveNotes(tender.id, notes);
      setNoteState('saved');
    } catch {
      setNoteState('failed');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-6">
        <div className="text-[13px] text-ink-muted">
          {tender.portal_name} · <span className="font-mono">{tender.reference_no || 'No reference'}</span>
          {tender.location && <> · {tender.location}</>}
        </div>
        <h2 className="mt-1 text-lg font-bold leading-snug">{tender.title}</h2>
        <div className="mt-1 text-sm text-ink-muted">{tender.organization}</div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-xs text-ink-muted">Closes</div>
            <div className="text-sm font-semibold">{tender.closing_date_formatted || 'No deadline stated'}</div>
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
                value={tender.result_expected_date?.slice(0, 10) ?? ''}
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
            aria-pressed={Boolean(tender.is_bookmarked)}
            aria-label={tender.is_bookmarked ? 'Remove bookmark' : 'Bookmark'}
            className="px-3"
          >
            <Bookmark className={`h-4 w-4 ${tender.is_bookmarked ? 'fill-current text-accent' : ''}`} />
          </Button>
          <a
            href={tender.direct_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-accent hover:bg-accent-soft"
          >
            Open on portal <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-6">
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
          <Fact label="Estimated value" value={tender.estimated_value || 'Not disclosed'} mono />
          <Fact label="Published" value={tender.publish_date ? new Date(tender.publish_date).toLocaleDateString('en-GB') : 'Not stated'} mono />
          <Fact label="Match" value={`${tender.match_score || 0}%`} mono />
        </div>

        <div>
          <SectionTitle>Why it matched</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {asList<string>(tender.domain_tracks).map(t => <Chip key={t} tone="accent">{t}</Chip>)}
            {keywords.map(k => <Chip key={k}>{k}</Chip>)}
          </div>
        </div>

        {tender.description && (
          <div>
            <SectionTitle>Summary</SectionTitle>
            <p className="whitespace-pre-wrap leading-relaxed">{tender.description}</p>
          </div>
        )}

        <div>
          <SectionTitle>Saved documents ({files.length})</SectionTitle>
          {files.length === 0 ? (
            <p className="text-ink-muted">No documents saved yet. They are fetched during scans.</p>
          ) : (
            <div className="space-y-2">
              {files.map((file, i) => (
                <a
                  key={i}
                  href={file.localPath.startsWith('/') ? file.localPath : `/api/dossiers/${tender.id}/${encodeURIComponent(file.localPath.replace(/\\/g, '/').split('/').pop() || '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-lg border border-line p-3 hover:bg-surface-2"
                >
                  <FileText className="h-4 w-4 shrink-0 text-ink-muted" />
                  <span className="truncate font-semibold">{file.label || `Document ${i + 1}`}</span>
                </a>
              ))}
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
              />
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
