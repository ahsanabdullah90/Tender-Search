import React from 'react';
import { Star, FileText, AlertTriangle, ExternalLink, Layers } from 'lucide-react';
import { OpportunityStatus, Tender } from '../types';
import { LiveCountdown } from './LiveCountdown';

interface TenderTableProps {
  tenders: Tender[];
  onSelectTender: (tender: Tender) => void;
  onUpdateStatus: (tenderId: string, newStatus: OpportunityStatus) => void;
  onToggleBookmark: (tenderId: string) => void;
}

export const TenderTable: React.FC<TenderTableProps> = ({
  tenders,
  onSelectTender,
  onUpdateStatus,
  onToggleBookmark
}) => {
  if (tenders.length === 0) {
    return (
      <div className="p-12 text-center text-slate-500 dark:text-slate-400">
        <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">No matching tenders found</h3>
        <p className="text-xs mt-1">Try switching domain tracks or clearing your search filters.</p>
      </div>
    );
  }

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'New Opportunity':
        return 'bg-slate-50 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700';
      case 'Under Review':
        return 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800';
      case 'Preparing Bid':
        return 'bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-800';
      case 'Submitted':
        return 'bg-purple-50 dark:bg-purple-950/40 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-800';
      case 'Won':
        return 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
      case 'Passed':
        return 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200';
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs border-collapse">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/75 dark:bg-slate-900/80 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            <th className="py-2.5 px-3 w-8"></th>
            <th className="py-2.5 px-3 w-32">Ref #</th>
            <th className="py-2.5 px-3 min-w-[280px]">Tender &amp; Issuing Authority</th>
            <th className="py-2.5 px-3 min-w-[170px]">Domain &amp; Keywords</th>
            <th className="py-2.5 px-3 w-44">Closing Deadline</th>
            <th className="py-2.5 px-3 w-36">Pipeline Status</th>
            <th className="py-2.5 px-3 w-16 text-center">Portal</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
          {tenders.map(t => {
            const tracks: string[] = typeof t.domain_tracks === 'string'
              ? JSON.parse(t.domain_tracks || '[]')
              : (t.domain_tracks || []);

            const keywords: string[] = typeof t.matched_keywords === 'string'
              ? JSON.parse(t.matched_keywords || '[]')
              : (t.matched_keywords || []);

            const secondarySources = typeof t.secondary_sources === 'string'
              ? JSON.parse(t.secondary_sources || '[]')
              : (t.secondary_sources || []);

            return (
              <tr
                key={t.id}
                onClick={() => onSelectTender(t)}
                className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer group h-[44px]"
              >
                {/* 1. Bookmark Star */}
                <td className="py-2 px-3 text-center" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => onToggleBookmark(t.id)}
                    className="text-slate-300 dark:text-slate-600 hover:text-amber-500 dark:hover:text-amber-400 transition-colors"
                  >
                    <Star className={`w-3.5 h-3.5 ${t.is_bookmarked ? 'fill-amber-400 text-amber-500' : ''}`} />
                  </button>
                </td>

                {/* 2. Reference Number */}
                <td className="py-2 px-3 font-mono text-[11px] text-slate-600 dark:text-slate-300 whitespace-nowrap">
                  {t.reference_no || <span className="text-slate-400 italic">Unassigned</span>}
                </td>

                {/* 3. Title & Issuing Entity */}
                <td className="py-2 px-3">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-900 dark:text-white line-clamp-1 group-hover:text-slate-700 dark:group-hover:text-slate-200 transition-colors">
                      {t.title}
                    </span>
                    {Boolean(t.has_corrigendum) && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/60 px-1.5 py-0.2 rounded border border-amber-200 dark:border-amber-800">
                        <AlertTriangle className="w-2.5 h-2.5 text-amber-500" />
                        Corrigendum
                      </span>
                    )}
                    {secondarySources.length > 0 && (
                      <span
                        title={`Also published on: ${secondarySources.map((s: any) => s.portalName).join(', ')}`}
                        className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-1 py-0.2 rounded"
                      >
                        <Layers className="w-2.5 h-2.5" />
                        +{secondarySources.length} source
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1">
                    {t.organization} · <span className="font-medium text-slate-600 dark:text-slate-300">{t.portal_name}</span>
                  </div>
                </td>

                {/* 4. Domain & Matched Keywords */}
                <td className="py-2 px-3">
                  <div className="text-[11px] font-medium text-slate-800 dark:text-slate-200 line-clamp-1">
                    {tracks.join(' / ') || 'General'}
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1 font-mono">
                    {keywords.slice(0, 3).join(' · ')}
                    {keywords.length > 3 && ` +${keywords.length - 3}`}
                  </div>
                </td>

                {/* 5. Closing Deadline Countdown */}
                <td className="py-2 px-3 whitespace-nowrap">
                  <LiveCountdown
                    closingDate={t.closing_date}
                    closingDateFormatted={t.closing_date_formatted}
                    mode="compact"
                  />
                </td>

                {/* 6. Inline Pipeline Status Selector */}
                <td className="py-2 px-3" onClick={e => e.stopPropagation()}>
                  <select
                    value={t.pipeline_status}
                    onChange={e => onUpdateStatus(t.id, e.target.value as OpportunityStatus)}
                    className={`w-full text-[11px] font-semibold py-1 px-2 rounded border focus:outline-hidden focus:ring-1 cursor-pointer transition-colors ${getStatusBadgeClass(
                      t.pipeline_status
                    )}`}
                  >
                    <option value="New Opportunity">New Opportunity</option>
                    <option value="Under Review">Under Review</option>
                    <option value="Preparing Bid">Preparing Bid</option>
                    <option value="Submitted">Submitted</option>
                    <option value="Won">Won</option>
                    <option value="Passed">Passed</option>
                  </select>
                </td>

                {/* 7. Portal Direct Link */}
                <td className="py-2 px-3 text-center" onClick={e => e.stopPropagation()}>
                  <a
                    href={t.direct_url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open official procurement notice"
                    className="inline-flex p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
