import { Paperclip, TriangleAlert, Bookmark } from 'lucide-react';
import { Tender } from '../../../shared/types';
import { Chip, DeadlineChip } from '../../ui';

function asList<T>(value: unknown): T[] {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value || '[]');
    } catch {
      return [];
    }
  }
  return (value as T[]) || [];
}

export interface TenderRowProps {
  tender: Tender;
  selected: boolean;
  unread: boolean;
  onSelect: () => void;
}

export function TenderRow({
  tender,
  selected,
  unread,
  onSelect,
}: TenderRowProps) {
  const tracks = asList<string>(tender.domain_tracks);
  const keywords = asList<string>(tender.matched_keywords);
  const files = asList<{ label?: string; localPath: string }>(tender.cached_dossiers);
  const isSemanticMatch = keywords.some(k => k.startsWith('✨'));

  return (
    <button
      onClick={onSelect}
      data-tender-id={tender.id}
      aria-current={selected ? 'true' : undefined}
      className={`block w-full cursor-pointer border-b border-line px-4 py-3 text-left transition-colors ${
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {unread && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-accent"
              title="Unread tender"
              aria-label="Unread tender"
            />
          )}
          {Boolean(tender.needs_review) && <Chip tone="danger">Review</Chip>}
          <DeadlineChip closingDate={tender.closing_date} />
          {tender.match_score > 0 && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-muted">
              {tender.match_score}%
            </span>
          )}
          {isSemanticMatch && (
            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold text-accent">
              ✨ Semantic
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {files.length > 0 && (
            <span
              className="inline-flex items-center gap-0.5 font-mono text-xs text-ink-muted"
              title={`${files.length} attached document(s)`}
              aria-label={`${files.length} attached document(s)`}
            >
              <Paperclip className="h-3.5 w-3.5" />
              {files.length}
            </span>
          )}
          {Boolean(tender.has_corrigendum) && <TriangleAlert className="h-4 w-4 text-warn" aria-label="Amended" />}
          {Boolean(tender.is_bookmarked) && <Bookmark className="h-4 w-4 fill-current text-accent" aria-label="Bookmarked" />}
        </span>
      </div>
      <div className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">{tender.title}</div>
      <div className="mt-1 truncate text-[13px] text-ink-muted">
        {tender.organization} · {tender.portal_name}
      </div>
      {(tracks.length > 0 || tender.estimated_value) && (
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-ink-muted">
          <span className="truncate">{tracks.join(' · ')}</span>
          {tender.estimated_value && (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink">
              {tender.estimated_value}
            </span>
          )}
        </div>
      )}
    </button>
  );
}
