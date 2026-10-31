import React from 'react';
import { AlertTriangle, Star } from 'lucide-react';
import { OpportunityStatus, Tender } from '../types';
import { LiveCountdown } from './LiveCountdown';

interface TenderKanbanProps {
  tenders: Tender[];
  onSelectTender: (tender: Tender) => void;
  onUpdateStatus: (tenderId: string, newStatus: OpportunityStatus) => void;
  onToggleBookmark: (tenderId: string) => void;
}

const COLUMNS: { status: OpportunityStatus; label: string; headerColor: string }[] = [
  { status: 'New Opportunity', label: 'New Opportunities', headerColor: 'border-slate-400 dark:border-slate-600' },
  { status: 'Under Review', label: 'Under Review', headerColor: 'border-amber-500' },
  { status: 'Preparing Bid', label: 'Preparing Bid', headerColor: 'border-blue-500' },
  { status: 'Submitted', label: 'Submitted', headerColor: 'border-purple-500' },
  { status: 'Won', label: 'Won', headerColor: 'border-emerald-500' },
  { status: 'Passed', label: 'Passed / Archived', headerColor: 'border-slate-300 dark:border-slate-700' }
];

export const TenderKanban: React.FC<TenderKanbanProps> = ({
  tenders,
  onSelectTender,
  onUpdateStatus,
  onToggleBookmark
}) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 p-4">
      {COLUMNS.map(col => {
        const columnTenders = tenders.filter(t => t.pipeline_status === col.status);

        return (
          <div
            key={col.status}
            className="flex flex-col bg-slate-50/60 dark:bg-slate-900/40 rounded-xl border border-slate-200 dark:border-slate-800 min-h-[500px]"
          >
            {/* Column Header */}
            <div className={`p-3 border-b-2 ${col.headerColor} flex items-center justify-between`}>
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                {col.label}
              </span>
              <span className="text-[11px] font-mono tabular-nums px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold">
                {columnTenders.length}
              </span>
            </div>

            {/* Cards List */}
            <div className="p-2 space-y-2.5 overflow-y-auto flex-1">
              {columnTenders.length === 0 ? (
                <div className="py-12 text-center text-[11px] text-slate-400 dark:text-slate-500 italic">
                  No tenders
                </div>
              ) : (
                columnTenders.map(t => (
                  <div
                    key={t.id}
                    onClick={() => onSelectTender(t)}
                    className="p-3 bg-white dark:bg-slate-800/90 rounded-lg border border-slate-200/80 dark:border-slate-700/70 shadow-xs hover:border-slate-400 dark:hover:border-slate-500 transition-all cursor-pointer group"
                  >
                    {/* Top Row: Ref & Bookmark */}
                    <div className="flex items-center justify-between gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                      <span className="font-mono">{t.reference_no || t.portal_name.split(' ')[0]}</span>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          onToggleBookmark(t.id);
                        }}
                        className="hover:text-amber-500 text-slate-300 dark:text-slate-600"
                      >
                        <Star className={`w-3.5 h-3.5 ${t.is_bookmarked ? 'fill-amber-400 text-amber-500' : ''}`} />
                      </button>
                    </div>

                    {/* Title */}
                    <h4 className="mt-1 text-xs font-semibold text-slate-900 dark:text-white line-clamp-2 leading-tight group-hover:text-slate-700 dark:group-hover:text-slate-200 transition-colors">
                      {t.title}
                    </h4>

                    {/* Organization */}
                    <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1">
                      {t.organization}
                    </div>

                    {/* Live Deadline Countdown & Badges */}
                    <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-700/60 flex items-center justify-between gap-1 text-[10px]">
                      <div className="truncate">
                        <LiveCountdown
                          closingDate={t.closing_date}
                          closingDateFormatted={t.closing_date_formatted}
                          mode="compact"
                        />
                      </div>

                      {Boolean(t.has_corrigendum) && (
                        <span title="Corrigendum active" className="text-amber-500 shrink-0">
                          <AlertTriangle className="w-3.5 h-3.5" />
                        </span>
                      )}
                    </div>

                    {/* Quick Move Action Buttons */}
                    <div
                      className="mt-2 pt-2 border-t border-dashed border-slate-100 dark:border-slate-700 flex items-center justify-between text-[10px]"
                      onClick={e => e.stopPropagation()}
                    >
                      {col.status === 'New Opportunity' && (
                        <button
                          onClick={() => onUpdateStatus(t.id, 'Under Review')}
                          className="w-full py-1 text-center font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 rounded transition-colors"
                        >
                          Move to Review &rarr;
                        </button>
                      )}
                      {col.status === 'Under Review' && (
                        <div className="w-full flex items-center justify-between gap-1">
                          <button
                            onClick={() => onUpdateStatus(t.id, 'Preparing Bid')}
                            className="flex-1 py-1 text-center font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded transition-colors"
                          >
                            Prepare Bid
                          </button>
                          <button
                            onClick={() => onUpdateStatus(t.id, 'Passed')}
                            className="px-2 py-1 font-medium text-slate-400 hover:text-slate-600 rounded transition-colors"
                          >
                            Pass
                          </button>
                        </div>
                      )}
                      {col.status === 'Preparing Bid' && (
                        <button
                          onClick={() => onUpdateStatus(t.id, 'Submitted')}
                          className="w-full py-1 text-center font-medium text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/40 rounded transition-colors"
                        >
                          Mark Submitted &rarr;
                        </button>
                      )}
                      {col.status === 'Submitted' && (
                        <div className="w-full flex items-center justify-between gap-1">
                          <button
                            onClick={() => onUpdateStatus(t.id, 'Won')}
                            className="flex-1 py-1 text-center font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded transition-colors"
                          >
                            Won Contract &check;
                          </button>
                          <button
                            onClick={() => onUpdateStatus(t.id, 'Passed')}
                            className="px-2 py-1 font-medium text-slate-400 hover:text-slate-600 rounded transition-colors"
                          >
                            Lost
                          </button>
                        </div>
                      )}
                      {(col.status === 'Won' || col.status === 'Passed') && (
                        <button
                          onClick={() => onUpdateStatus(t.id, 'Preparing Bid')}
                          className="w-full py-0.5 text-center text-slate-400 hover:text-slate-600 transition-colors"
                        >
                          Reopen &rarr;
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
