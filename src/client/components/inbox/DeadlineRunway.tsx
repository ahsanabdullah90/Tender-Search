import { useMemo } from 'react';
import { Calendar, X } from 'lucide-react';
import { Tender } from '../../../shared/types';

interface DeadlineRunwayProps {
  tenders: Tender[];
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
}

interface DayBucket {
  dateStr: string; // YYYY-MM-DD
  dayLabel: string; // 'Today', 'Tomorrow', 'Fri 07', etc.
  dayNum: string;
  isToday: boolean;
  tenders: Tender[];
  urgentCount: number; // < 24 hours
  warningCount: number; // 1 - 3 days
  normalCount: number; // > 3 days
}

export function DeadlineRunway({ tenders, selectedDate, onSelectDate }: DeadlineRunwayProps) {
  const runwayDays = useMemo(() => {
    const now = new Date();
    const days: DayBucket[] = [];

    for (let i = 0; i < 15; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      let dayLabel = '';
      if (i === 0) dayLabel = 'Today';
      else if (i === 1) dayLabel = 'Tomorrow';
      else {
        dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
      }

      days.push({
        dateStr,
        dayLabel,
        dayNum: String(d.getDate()),
        isToday: i === 0,
        tenders: [],
        urgentCount: 0,
        warningCount: 0,
        normalCount: 0
      });
    }

    // Populate tenders into buckets
    const nowMs = Date.now();
    for (const tender of tenders) {
      if (!tender.closing_date) continue;
      // Extract YYYY-MM-DD
      const tenderDateStr = tender.closing_date.slice(0, 10);
      const bucket = days.find(b => b.dateStr === tenderDateStr);
      if (bucket) {
        bucket.tenders.push(tender);
        const diffHours = (new Date(tender.closing_date).getTime() - nowMs) / 3600000;
        if (diffHours <= 24) {
          bucket.urgentCount++;
        } else if (diffHours <= 72) {
          bucket.warningCount++;
        } else {
          bucket.normalCount++;
        }
      }
    }

    return days;
  }, [tenders]);

  const totalRunwayTenders = useMemo(() => {
    return runwayDays.reduce((acc, d) => acc + d.tenders.length, 0);
  }, [runwayDays]);

  return (
    <div className="rounded-xl border border-line bg-surface p-3 transition">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-accent" />
          <span className="text-xs font-bold uppercase tracking-wider text-ink-muted">
            Closing Dates Runway (Next 15 Days)
          </span>
          <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">
            {totalRunwayTenders} active deadlines
          </span>
        </div>

        {selectedDate && (
          <button
            type="button"
            onClick={() => onSelectDate(null)}
            className="flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-3 w-3" />
            Clear runway filter ({selectedDate})
          </button>
        )}
      </div>

      {/* 15-day runway grid */}
      <div className="grid grid-cols-15 gap-1.5 overflow-x-auto pb-1 text-center" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr))' }}>
        {runwayDays.map((bucket) => {
          const isSelected = selectedDate === bucket.dateStr;
          const hasTenders = bucket.tenders.length > 0;

          return (
            <button
              key={bucket.dateStr}
              type="button"
              onClick={() => onSelectDate(isSelected ? null : bucket.dateStr)}
              title={`${bucket.dayLabel}: ${bucket.tenders.length} tender(s) closing`}
              className={`group flex cursor-pointer flex-col items-center rounded-lg border p-1.5 transition text-left ${
                isSelected
                  ? 'border-accent bg-accent-soft text-ink ring-2 ring-accent'
                  : bucket.isToday
                  ? 'border-line bg-surface-2 hover:border-accent'
                  : 'border-line/60 bg-surface hover:border-line hover:bg-surface-2'
              }`}
            >
              <div className="text-[11px] font-bold leading-tight">
                {bucket.isToday ? (
                  <span className="text-accent">Today</span>
                ) : (
                  <span className="text-ink-muted group-hover:text-ink">{bucket.dayLabel}</span>
                )}
              </div>

              {/* Day dot indicators */}
              <div className="mt-1.5 flex h-4 items-center justify-center gap-1">
                {hasTenders ? (
                  <>
                    {bucket.urgentCount > 0 && (
                      <span
                        className="h-2 w-2 rounded-full bg-danger"
                        title={`${bucket.urgentCount} closing within 24h`}
                      />
                    )}
                    {bucket.warningCount > 0 && (
                      <span
                        className="h-2 w-2 rounded-full bg-warn"
                        title={`${bucket.warningCount} closing within 3 days`}
                      />
                    )}
                    {bucket.normalCount > 0 && (
                      <span
                        className="h-2 w-2 rounded-full bg-accent"
                        title={`${bucket.normalCount} closing later`}
                      />
                    )}
                  </>
                ) : (
                  <span className="h-1 w-2 rounded-full bg-line" />
                )}
              </div>

              {/* Tender count pill */}
              <div className="mt-1 text-[11px] font-mono">
                {hasTenders ? (
                  <span
                    className={`font-semibold ${
                      bucket.urgentCount > 0
                        ? 'text-danger'
                        : bucket.warningCount > 0
                        ? 'text-warn'
                        : 'text-ink-muted'
                    }`}
                  >
                    {bucket.tenders.length}
                  </span>
                ) : (
                  <span className="text-ink-muted/40">-</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
