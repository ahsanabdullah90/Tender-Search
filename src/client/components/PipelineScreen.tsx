import { useMemo, useState } from 'react';
import { Archive, ExternalLink, Paperclip, RotateCw, TriangleAlert } from 'lucide-react';
import { Tender, CorrigendumLog, OpportunityStatus, DocumentQueueStatus } from '../../shared/types';
import { Button, Chip, DeadlineChip, EmptyState, Panel, SlideOver, Tabs } from '../ui';
import { Detail, deadlineProvenance, getTenderDocProcessingState, useTick } from './InboxScreen';
import { PassConfirmModal } from './pipeline/PassConfirmModal';

type View = 'board' | 'gantt';

interface PipelineScreenProps {
  tenders: Tender[];
  corrigenda: CorrigendumLog[];
  docQueue?: DocumentQueueStatus;
  onStatusChange: (tenderId: string, status: OpportunityStatus) => Promise<void>;
  onAcknowledgeCorrigendum: (logId: string) => Promise<void>;
  onSaveNotes: (tenderId: string, notes: string) => Promise<void>;
  onToggleBookmark: (tenderId: string) => void;
  onSetResultDate: (tenderId: string, date: string | null) => void;
  onTenderUpdated?: (tender: Tender) => void;
  focusId?: string | null;
}

const STAGES: { status: OpportunityStatus; label: string; bar: string }[] = [
  { status: 'Under Review', label: 'Reviewing', bar: 'bg-ink-muted' },
  { status: 'Preparing Bid', label: 'Preparing bid', bar: 'bg-accent' },
  { status: 'Submitted', label: 'Submitted', bar: 'bg-warn' },
  { status: 'Won', label: 'Won', bar: 'bg-ok' },
];

const DAY = 86_400_000;
const stageOf = (s: OpportunityStatus) => STAGES.find(x => x.status === s);

/** Time between publish (or first seen) and closing, as a share already used. */
function elapsedShare(t: Tender) {
  if (!t.closing_date) return null;
  const end = new Date(t.closing_date).getTime();
  const start = new Date(t.publish_date || t.created_at).getTime();
  if (Number.isNaN(end) || Number.isNaN(start) || end <= start) return null;
  return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
}

function Card({ tender, docQueue, onOpen }: { tender: Tender; docQueue?: DocumentQueueStatus; onOpen: () => void }) {
  const share = elapsedShare(tender);
  const urgent = tender.closing_date ? new Date(tender.closing_date).getTime() - Date.now() < DAY : false;
  const open = tender.pipeline_status === 'Under Review' || tender.pipeline_status === 'Preparing Bid';
  const provenance = deadlineProvenance(tender);
  const docState = getTenderDocProcessingState(tender, docQueue);
  return (
    <button onClick={onOpen} className="block w-full cursor-pointer rounded-lg border border-line bg-surface p-3 text-left hover:border-accent">
      <div className="line-clamp-2 text-sm font-semibold leading-snug">{tender.title}</div>
      <div className="mt-1 truncate text-[13px] text-ink-muted">{tender.organization}</div>
      {open && share !== null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-chip" aria-hidden="true">
          <div className={`h-full rounded-full ${urgent ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {tender.pipeline_status === 'Won' ? <Chip tone="ok">Won</Chip> : <DeadlineChip closingDate={tender.closing_date} />}
          {Boolean(tender.needs_review) && <Chip tone="danger">Review</Chip>}
          {(docState.kind === 'processing' || docState.kind === 'queued' || docState.kind === 'failed') && (
            <span
              data-testid="card-doc-status"
              title={docState.bannerTitle}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                docState.kind === 'processing'
                  ? 'bg-accent-soft text-accent'
                  : docState.kind === 'failed'
                    ? 'bg-warn-soft text-warn'
                    : 'bg-surface-2 text-ink-muted'
              }`}
            >
              {docState.kind === 'processing' && <RotateCw aria-hidden="true" className="h-3 w-3 motion-safe:animate-spin" />}
              {docState.shortLabel}
            </span>
          )}
          {provenance.tone !== 'neutral' && (
            <span title={provenance.title}>
              <Chip tone={provenance.tone}>{provenance.label}</Chip>
            </span>
          )}
        </div>
        <span className="flex items-center gap-1.5">
          {docState.savedCount > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono text-xs text-ink-muted" title={`${docState.savedCount} saved document(s)`}>
              <Paperclip className="h-3.5 w-3.5" />
              {docState.savedCount}
            </span>
          )}
          {Boolean(tender.has_corrigendum) && <TriangleAlert className="h-4 w-4 text-warn" aria-label="Amended" />}
        </span>
      </div>
    </button>
  );
}

function Board({ tenders, docQueue, onOpen }: { tenders: Tender[]; docQueue?: DocumentQueueStatus; onOpen: (t: Tender) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {STAGES.map(stage => {
        const list = tenders
          .filter(t => t.pipeline_status === stage.status)
          .sort((a, b) => {
            if (Boolean(a.needs_review) !== Boolean(b.needs_review)) {
              return a.needs_review ? -1 : 1;
            }
            return (a.closing_date ? new Date(a.closing_date).getTime() : Infinity) - (b.closing_date ? new Date(b.closing_date).getTime() : Infinity);
          });
        return (
          <div key={stage.status} className="flex flex-col gap-3 rounded-xl bg-surface-2 p-3">
            <div className="flex items-center gap-2 px-1">
              <span className={`h-2 w-2 rounded-full ${stage.bar}`} />
              <h2 className="text-sm font-bold">{stage.label}</h2>
              <span className="font-mono text-xs text-ink-muted">{list.length}</span>
            </div>
            {list.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line px-3 py-8 text-center text-ink-muted">Nothing here</div>
            ) : (
              list.map(t => <Card key={t.id} tender={t} docQueue={docQueue} onOpen={() => onOpen(t)} />)
            )}
          </div>
        );
      })}
    </div>
  );
}

function Gantt({ tenders, onOpen }: { tenders: Tender[]; onOpen: (t: Tender) => void }) {
  // Five weeks, starting on the Monday of the current week.
  const { start, weeks } = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return { start: d.getTime(), weeks: 5 };
  }, []);
  const span = weeks * 7 * DAY;
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - start) / span) * 100));
  const inAxis = (ms: number) => ms >= start && ms <= start + span;
  const today = pct(Date.now());

  const active = tenders.filter(t => stageOf(t.pipeline_status));
  const dated = active.filter(t => t.closing_date).sort((a, b) => new Date(a.closing_date!).getTime() - new Date(b.closing_date!).getTime());
  const undated = active.filter(t => !t.closing_date);

  const label = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  const Row = ({ t }: { t: Tender }) => {
    const stage = stageOf(t.pipeline_status)!;
    const from = new Date(t.publish_date || t.created_at).getTime();
    const resultAt = t.result_expected_date ? new Date(t.result_expected_date).getTime() : null;
    const closeAt = t.closing_date ? new Date(t.closing_date).getTime() : null;
    return (
      <div className="grid grid-cols-[240px_1fr] items-center border-b border-line last:border-b-0">
        <button onClick={() => onOpen(t)} className="cursor-pointer px-4 py-3 text-left hover:bg-surface-2">
          <div className="truncate text-sm font-semibold">{t.title}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
            <span className={`h-2 w-2 rounded-full ${stage.bar}`} />
            {stage.label}
          </div>
        </button>
        <div className="relative h-12 border-l border-line">
          {resultAt !== null && !Number.isNaN(resultAt) && resultAt >= from ? (
            <div
              className={`absolute top-1/2 h-3 -translate-y-1/2 rounded-full ${stage.bar} opacity-80`}
              style={{ left: `${pct(from)}%`, width: `${Math.max(1, pct(resultAt) - pct(from))}%` }}
              title={`${label(from)} to ${label(resultAt)}`}
            />
          ) : (
            t.pipeline_status !== 'Won' && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-muted">Result date not set</span>
            )
          )}
          {closeAt !== null && inAxis(closeAt) && (
            <span
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-surface bg-danger"
              style={{ left: `${pct(closeAt)}%` }}
              title={`Closes ${label(closeAt)}`}
            />
          )}
        </div>
      </div>
    );
  };

  if (active.length === 0) {
    return <Panel><EmptyState title="Nothing to chart yet" body="Tenders you track from the Inbox will show up here." /></Panel>;
  }

  return (
    <Panel className="overflow-hidden">
      <div className="grid grid-cols-[240px_1fr] border-b border-line bg-surface-2 text-xs font-semibold text-ink-muted">
        <div className="px-4 py-2">Tender</div>
        <div className="relative h-8">
          {Array.from({ length: weeks }, (_, i) => (
            <span key={i} className="absolute top-2 -translate-x-0 pl-2" style={{ left: `${(i / weeks) * 100}%` }}>
              {label(start + i * 7 * DAY)}
            </span>
          ))}
        </div>
      </div>
      <div className="relative">
        {/* Today line, drawn over the timeline column only. */}
        <div className="pointer-events-none absolute inset-y-0 left-[240px] right-0 z-10" aria-hidden="true">
          <div className="absolute inset-y-0 w-px bg-accent" style={{ left: `${today}%` }}>
            <span className="absolute -top-0 left-1 rounded bg-accent px-1 text-[11px] font-semibold text-accent-ink">Today</span>
          </div>
        </div>
        {dated.map(t => <Row key={t.id} t={t} />)}
        {undated.length > 0 && (
          <>
            <div className="border-b border-line bg-surface-2 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-ink-muted">No deadline stated</div>
            {undated.map(t => <Row key={t.id} t={t} />)}
          </>
        )}
      </div>
      <div className="flex gap-5 border-t border-line px-4 py-2 text-xs text-ink-muted">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rotate-45 bg-danger" /> Closing date</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-full bg-accent opacity-80" /> Start to expected result</span>
      </div>
    </Panel>
  );
}

export function PipelineScreen(props: PipelineScreenProps) {
  const { tenders, corrigenda } = props;
  const [view, setView] = useState<View>('board');
  const [openId, setOpenId] = useState<string | null>(props.focusId ?? null);
  const [showArchive, setShowArchive] = useState(false);
  const [passTarget, setPassTarget] = useState<Tender | null>(null);
  useTick(60_000);

  const working = tenders.filter(t => stageOf(t.pipeline_status));
  const passed = tenders.filter(t => t.pipeline_status === 'Passed');
  const open = tenders.find(t => t.id === openId) ?? null;

  const stageButtons = open && (
    <>
      {STAGES.map(s => (
        <Button
          key={s.status}
          size="sm"
          variant={open.pipeline_status === s.status ? 'primary' : 'secondary'}
          aria-pressed={open.pipeline_status === s.status}
          onClick={() => void props.onStatusChange(open.id, s.status)}
        >
          {s.label}
        </Button>
      ))}
      <Button size="sm" variant="danger" onClick={() => setPassTarget(open)}>
        Pass
      </Button>
    </>
  );

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Pipeline</h1>
        <span className="font-mono text-sm text-ink-muted">{working.length}</span>
        <button
          onClick={() => setShowArchive(s => !s)}
          className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-accent hover:bg-accent-soft"
        >
          <Archive className="h-4 w-4" /> Passed and archived ({passed.length})
        </button>
      </div>

      <Tabs
        label="Pipeline view"
        value={view}
        onChange={setView}
        items={[{ id: 'board', label: 'Board' }, { id: 'gantt', label: 'Gantt' }]}
      />

      {working.length === 0 && view === 'board' ? (
        <Panel><EmptyState title="No tenders in your pipeline" body="Choose Track this bid on a tender in the Inbox and it will appear here." /></Panel>
      ) : view === 'board' ? (
        <Board tenders={working} docQueue={props.docQueue} onOpen={t => setOpenId(t.id)} />
      ) : (
        <Gantt tenders={working} onOpen={t => setOpenId(t.id)} />
      )}

      {showArchive && (
        <Panel>
          {passed.length === 0 ? (
            <EmptyState title="Nothing archived" />
          ) : (
            passed.map(t => (
              <div key={t.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{t.title}</div>
                  <div className="flex items-center gap-2 truncate text-[13px] text-ink-muted">
                    <span>{t.organization}</span>
                    <span>•</span>
                    <span>{t.portal_name}</span>
                    {t.reference_no && (
                      <>
                        <span>•</span>
                        <span className="font-mono">{t.reference_no}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {t.direct_url && t.direct_url !== '#' && (
                    <a
                      href={t.direct_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent-soft"
                    >
                      Open <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  <Button size="sm" onClick={() => void props.onStatusChange(t.id, 'New Opportunity')}>
                    Reopen
                  </Button>
                </div>
              </div>
            ))
          )}
        </Panel>
      )}

      <SlideOver open={Boolean(open)} onClose={() => setOpenId(null)} title={open?.title ?? ''}>
        {open && (
          <div className="-mx-5 -my-4">
            <Detail
              tender={open}
              corrigenda={corrigenda}
              docQueue={props.docQueue}
              stageActions={stageButtons}
              onPass={() => setPassTarget(open)}
              onSetResultDate={date => props.onSetResultDate(open.id, date)}
              onAcknowledgeCorrigendum={props.onAcknowledgeCorrigendum}
              onSaveNotes={props.onSaveNotes}
              onToggleBookmark={() => props.onToggleBookmark(open.id)}
              onTenderUpdated={props.onTenderUpdated}
            />
          </div>
        )}
      </SlideOver>

      {passTarget && (
        <PassConfirmModal
          tender={passTarget}
          isOpen={Boolean(passTarget)}
          onClose={() => setPassTarget(null)}
          onConfirmPass={async (tenderId) => {
            await props.onStatusChange(tenderId, 'Passed');
            setOpenId(null);
            setPassTarget(null);
          }}
        />
      )}
    </div>
  );
}
