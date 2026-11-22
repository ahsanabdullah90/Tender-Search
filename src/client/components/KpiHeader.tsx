import React from 'react';
import { AlertTriangle, ExternalLink, AlertOctagon } from 'lucide-react';
import { CorrigendumLog, PortalHealth, KpiStats } from '../../shared/types';
import { isPortalOffline } from '../utils/format';

/*
  Alert banners and the KPI strip. Navigation, scan and theme controls now
  live in the sidebar (AppShell).
*/
interface KpiHeaderProps {
  stats: KpiStats;
  corrigenda: CorrigendumLog[];
  portals: PortalHealth[];
  onAcknowledgeCorrigendum: (id: string) => void;
  onLaunchHitl: (portalId: string) => void;
  onSelectTenderById?: (tenderId: string) => void;
  onOpenSources: () => void;
}

export const KpiHeader: React.FC<KpiHeaderProps> = ({
  stats,
  corrigenda,
  portals,
  onAcknowledgeCorrigendum,
  onLaunchHitl,
  onSelectTenderById,
  onOpenSources,
}) => {
  const hitlPortals = portals.filter(p => p.status === 'hitl_required');
  const brokenPortals = portals.filter(isPortalOffline);

  return (
    <header className="border-b border-line bg-surface">
      {/* Human verification banner */}
      {hitlPortals.length > 0 && (
        <div className="border-b border-danger/30 bg-danger-soft px-4 py-2.5 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-danger">
              <AlertOctagon className="h-4 w-4 shrink-0" />
              <span>
                <strong>Action needed:</strong> Human verification required on {hitlPortals.map(p => p.portal_name).join(', ')}.
                Background scan paused on this portal.
              </span>
            </div>
            <div className="flex items-center gap-2">
              {hitlPortals.map(portal => (
                <button
                  key={portal.portal_id}
                  onClick={() => onLaunchHitl(portal.portal_id)}
                  className="flex cursor-pointer items-center gap-1.5 rounded bg-danger px-3 py-1 text-xs font-semibold text-accent-ink shadow-xs"
                >
                  <ExternalLink className="h-3 w-3" />
                  <span>Launch browser for {portal.portal_name.split(' ')[0]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Corrigendum banner */}
      {corrigenda.length > 0 && (
        <div className="border-b border-warn/30 bg-warn-soft px-4 py-2.5 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-warn">
            <div className="flex min-w-0 items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="truncate">
                <strong>Corrigendum:</strong> {corrigenda[0].change_type === 'deadline_extension' ? 'Submission deadline extended' : 'Dossier BOQ updated'} on{' '}
                <button
                  onClick={() => onSelectTenderById && onSelectTenderById(corrigenda[0].tender_id)}
                  className="cursor-pointer font-semibold underline underline-offset-2"
                >
                  "{corrigenda[0].tender_title}"
                </button>
                {corrigenda[0].previous_value && corrigenda[0].new_value && (
                  <span className="ml-1 font-mono text-[11px]">
                    ({corrigenda[0].previous_value} → {corrigenda[0].new_value})
                  </span>
                )}
                {corrigenda.length > 1 && <span className="ml-2 font-semibold">+{corrigenda.length - 1} more</span>}
              </span>
            </div>
            <button
              onClick={() => onAcknowledgeCorrigendum(corrigenda[0].id)}
              className="shrink-0 cursor-pointer rounded bg-warn px-2.5 py-1 text-xs font-semibold text-accent-ink"
            >
              Acknowledge
            </button>
          </div>
        </div>
      )}

      {/* Portal outage banner */}
      {brokenPortals.length > 0 && (
        <div className="border-b border-warn/30 bg-warn-soft/60 px-4 py-2 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-warn">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                <strong>{brokenPortals.length} portals</strong> ({brokenPortals.map(p => p.portal_name).slice(0, 3).join(', ')}
                {brokenPortals.length > 3 ? ` +${brokenPortals.length - 3}` : ''}) are not responding. Routine crawl continues on healthy portals.
              </span>
            </div>
            <button
              onClick={() => onOpenSources()}
              className="shrink-0 cursor-pointer rounded bg-warn px-2.5 py-1 text-xs font-semibold text-accent-ink"
            >
              Review portals →
            </button>
          </div>
        </div>
      )}

      {/* KPI strip */}
      <div className="px-4 py-3 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="text-xs font-semibold text-ink-muted">Total monitored</div>
            <div className="mt-1 font-mono text-xl font-bold">{stats.totalTracked}</div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="text-xs font-semibold text-ink-muted">Closing in 72 hours</div>
            <div className={`mt-1 font-mono text-xl font-bold ${stats.closingSoon > 0 ? 'text-danger' : ''}`}>{stats.closingSoon}</div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="text-xs font-semibold text-ink-muted">In pipeline</div>
            <div className="mt-1 font-mono text-xl font-bold">{stats.inPipeline}</div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="text-xs font-semibold text-ink-muted">Amendments to review</div>
            <div className={`mt-1 font-mono text-xl font-bold ${stats.unackCorrigenda > 0 ? 'text-warn' : ''}`}>{stats.unackCorrigenda}</div>
          </div>
          <button
            onClick={() => onOpenSources()}
            className="cursor-pointer rounded-lg border border-line bg-surface p-3 text-left hover:bg-surface-2"
          >
            <div className="text-xs font-semibold text-ink-muted">Portals online</div>
            <div className="mt-1 font-mono text-xl font-bold">
              {stats.onlinePortals}/{stats.totalPortals}
            </div>
          </button>
        </div>
      </div>
    </header>
  );
};
