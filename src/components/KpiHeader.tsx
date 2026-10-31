import React from 'react';
import { Shield, Radio, RefreshCw, AlertTriangle, Moon, Sun, ExternalLink, AlertOctagon, SlidersHorizontal } from 'lucide-react';
import { CorrigendumLog, PortalHealth, ScanStatus } from '../types';

interface KpiHeaderProps {
  stats: {
    totalTracked: number;
    closingSoon: number;
    inPipeline: number;
    unackCorrigenda: number;
    totalPortals: number;
    onlinePortals: number;
    hitlRequiredCount: number;
  };
  scanStatus: ScanStatus;
  corrigenda: CorrigendumLog[];
  portals: PortalHealth[];
  isDark: boolean;
  onToggleTheme: () => void;
  onRunScan: () => void;
  onOpenPortalModal: () => void;
  onAcknowledgeCorrigendum: (id: string) => void;
  onLaunchHitl: (portalId: string) => void;
  onSelectTenderById?: (tenderId: string) => void;
  activeTab: 'tenders' | 'management';
  onTabChange: (tab: 'tenders' | 'management') => void;
}

export const KpiHeader: React.FC<KpiHeaderProps> = ({
  stats,
  scanStatus,
  corrigenda,
  portals,
  isDark,
  onToggleTheme,
  onRunScan,
  onOpenPortalModal,
  onAcknowledgeCorrigendum,
  onLaunchHitl,
  onSelectTenderById,
  activeTab,
  onTabChange
}) => {
  const hitlPortals = portals.filter(p => p.status === 'hitl_required');
  const brokenPortals = portals.filter(p => p.status === 'selector_broken' || p.status === 'error' || p.access_mode === 'offline_broken');

  return (
    <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 transition-colors">
      {/* Top Bar: Clean 3-zone contract */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex items-center justify-between gap-8">
        {/* Zone 1: Wordmark with navigation tab switch */}
        <div className="flex items-center gap-6 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-slate-900 dark:bg-slate-100 flex items-center justify-center text-white dark:text-slate-900 shadow-xs">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <div className="text-base font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
                SENTINEL
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                Pakistan Procurement Command Center
              </div>
            </div>
          </div>

          {/* Primary View Switcher: Tenders Console vs Settings & Portals */}
          <div className="hidden sm:flex items-center p-0.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/80 text-xs">
            <button
              onClick={() => onTabChange('tenders')}
              className={`px-3 py-1.5 rounded-md font-semibold transition-all cursor-pointer ${
                activeTab === 'tenders'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Tenders Pipeline
            </button>
            <button
              onClick={() => onTabChange('management')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold transition-all cursor-pointer ${
                activeTab === 'management'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Keywords &amp; Portals</span>
            </button>
          </div>
        </div>

        {/* Zone 2: Live crawler telemetry and sync status */}
        <div className="hidden md:flex items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
          <div className="flex items-center gap-1.5 font-medium">
            <Radio className={`w-3.5 h-3.5 ${scanStatus.isScanning ? 'text-amber-500 animate-pulse' : 'text-emerald-600'}`} />
            <span>
              {scanStatus.isScanning ? `Crawling: ${scanStatus.currentPortal || 'Active'}` : 'All Portals Monitored'}
            </span>
          </div>
          {scanStatus.lastScanTimestamp && (
            <span className="text-slate-400 dark:text-slate-500 font-mono text-[11px]">
              · Last Sync: {new Date(scanStatus.lastScanTimestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {/* Zone 3: Primary scan CTA + theme switch */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onRunScan}
            disabled={scanStatus.isScanning}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap shadow-xs cursor-pointer ${
              scanStatus.isScanning
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                : 'bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-slate-200 text-white dark:text-slate-900'
            }`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanStatus.isScanning ? 'animate-spin' : ''}`} />
            <span>{scanStatus.isScanning ? `Scanning (${scanStatus.progressPercent}%)` : 'Run Live Scan'}</span>
          </button>

          <button
            onClick={onToggleTheme}
            aria-label="Toggle theme"
            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Crimson HITL Alert Banner (if CAPTCHA or 2FA challenge occurs) */}
      {hitlPortals.length > 0 && (
        <div className="bg-rose-50 dark:bg-rose-950/60 border-y border-rose-200 dark:border-rose-900/60 px-4 sm:px-6 lg:px-8 py-2.5">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-rose-800 dark:text-rose-300 font-medium">
              <AlertOctagon className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
              <span>
                <strong>Action Needed:</strong> Human verification required on {hitlPortals.map(p => p.portal_name).join(', ')}.
                Background scan paused on this portal.
              </span>
            </div>
            <div className="flex items-center gap-2">
              {hitlPortals.map(portal => (
                <button
                  key={portal.portal_id}
                  onClick={() => onLaunchHitl(portal.portal_id)}
                  className="px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>Launch Browser for {portal.portal_name.split(' ')[0]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Amber Corrigendum Delta Banner */}
      {corrigenda.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/60 border-b border-amber-200 dark:border-amber-900/60 px-4 sm:px-6 lg:px-8 py-2.5">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900 dark:text-amber-200">
            <div className="flex items-center gap-2 font-medium truncate">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="truncate">
                <strong>Corrigendum Alert:</strong> {corrigenda[0].change_type === 'deadline_extension' ? 'Submission Deadline Extended' : 'Dossier BOQ Updated'} on{' '}
                <button
                  onClick={() => onSelectTenderById && onSelectTenderById(corrigenda[0].tender_id)}
                  className="font-semibold underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-100 cursor-pointer"
                >
                  "{corrigenda[0].tender_title}"
                </button>
                {corrigenda[0].previous_value && corrigenda[0].new_value && (
                  <span className="font-mono text-[11px] ml-1">
                    ({corrigenda[0].previous_value} → {corrigenda[0].new_value})
                  </span>
                )}
                {corrigenda.length > 1 && (
                  <span className="ml-2 font-semibold px-1.5 py-0.5 rounded bg-amber-200 dark:bg-amber-900 text-[10px]">
                    +{corrigenda.length - 1} more
                  </span>
                )}
              </span>
            </div>
            <button
              onClick={() => onAcknowledgeCorrigendum(corrigenda[0].id)}
              className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-medium text-xs shadow-xs transition-colors shrink-0 cursor-pointer"
            >
              Acknowledge Corrigendum
            </button>
          </div>
        </div>
      )}

      {/* Daily Broken / Outage Portal Advisement Banner */}
      {brokenPortals.length > 0 && (
        <div className="bg-amber-50/80 dark:bg-amber-950/50 border-b border-amber-300 dark:border-amber-800 px-4 sm:px-6 lg:px-8 py-2">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900 dark:text-amber-200">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>
                <strong>Daily Advisement:</strong> {brokenPortals.length} portals ({brokenPortals.map(p => p.portal_name).slice(0, 3).join(', ')}{brokenPortals.length > 3 ? ` +${brokenPortals.length - 3}` : ''}) reported domain/TLS timeouts. Routine crawl continues on healthy portals.
              </span>
            </div>
            <button
              onClick={() => onTabChange('management')}
              className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-medium text-xs shadow-xs transition-colors cursor-pointer"
            >
              Review Portals &rarr;
            </button>
          </div>
        </div>
      )}

      {/* 5-Column High-Density KPI Strip */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {/* Card 1: Total Tracked */}
          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Total Monitored
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                {stats.totalTracked}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">Opportunities</span>
            </div>
          </div>

          {/* Card 2: Closing < 72h */}
          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Closing &lt; 72 Hours
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className={`text-xl font-bold font-mono tabular-nums ${stats.closingSoon > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-white'}`}>
                {stats.closingSoon}
              </span>
              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Urgent Cutoffs</span>
            </div>
          </div>

          {/* Card 3: Active Bid Pipeline */}
          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              In Bid Pipeline
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                {stats.inPipeline}
              </span>
              <span className="text-xs text-slate-600 dark:text-slate-400 font-medium">Active Pursuits</span>
            </div>
          </div>

          {/* Card 4: Unacknowledged Corrigenda */}
          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Corrigenda Alerts
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className={`text-xl font-bold font-mono tabular-nums ${stats.unackCorrigenda > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-white'}`}>
                {stats.unackCorrigenda}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">Amendments</span>
            </div>
          </div>

          {/* Card 5: Portal Sentinel Health */}
          <button
            onClick={() => onTabChange('management')}
            className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs text-left hover:border-slate-400 dark:hover:border-slate-600 transition-colors group cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Portal Health
              </span>
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                {stats.onlinePortals}/{stats.totalPortals}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 group-hover:underline">
                Manage &rarr;
              </span>
            </div>
          </button>
        </div>
      </div>
    </header>
  );
};
