import React, { useEffect, useId, useRef, useState } from 'react';
import { Inbox, Kanban, SlidersHorizontal, RefreshCw, Monitor, Sun, Moon, Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import { ScanStatus, NetworkStatus, NetworkState } from '../../shared/types';
import { ThemePref } from '../theme';
import { Button } from '../ui';

export type Section = 'inbox' | 'pipeline' | 'sources';

interface AppShellProps {
  section: Section;
  onNavigate: (section: Section) => void;
  scanStatus: ScanStatus;
  onRunScan: () => void;
  onRunDeepScan?: () => void;
  networkStatus?: NetworkStatus | null;
  checkingNetwork?: boolean;
  onRecheckNetwork?: () => void;
  themePref: ThemePref;
  onThemePref: (pref: ThemePref) => void;
  children: React.ReactNode;
}

const navItems = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'pipeline', label: 'Pipeline', icon: Kanban },
  { id: 'sources', label: 'Sources & Keywords', icon: SlidersHorizontal },
] as const;

const themeOptions: { id: ThemePref; label: string; icon: typeof Monitor }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

function ThemeSwitch({ value, onChange }: { value: ThemePref; onChange: (p: ThemePref) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {themeOptions.map(opt => {
        const on = value === opt.id;
        const Icon = opt.icon;
        return (
          <button
            key={opt.id}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(opt.id)}
            className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold ${
              on ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function AppShell({
  section,
  onNavigate,
  scanStatus,
  onRunScan,
  onRunDeepScan,
  networkStatus,
  checkingNetwork,
  onRecheckNetwork,
  themePref,
  onThemePref,
  children,
}: AppShellProps) {
  const scanning = scanStatus.isScanning;
  const lastSync = scanStatus.lastScanTimestamp
    ? new Date(scanStatus.lastScanTimestamp).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Karachi',
      })
    : null;

  const syncText = scanning
    ? `Scanning ${scanStatus.currentPortal ?? ''} (${scanStatus.progressPercent}%)`.replace('  ', ' ')
    : lastSync
      ? `Synced ${lastSync}`
      : 'Not synced yet';

  const fullScanTime = scanStatus.lastFullScanTimestamp || scanStatus.lastScanTimestamp;
  const fullScanAgeHours = fullScanTime
    ? (Date.now() - new Date(fullScanTime).getTime()) / (1000 * 60 * 60)
    : null;
  const isFullScanStale = fullScanAgeHours !== null && fullScanAgeHours >= 24;

  const netLabelId = useId();
  const netDetailId = useId();

  const netState = networkStatus?.state ?? null;
  const isOffline = netState === 'offline';
  const isDegraded = netState === 'degraded';
  const deepPaused = Boolean(networkStatus?.heavyTasksPaused);

  const netContainerClass = isOffline
    ? 'rounded-lg bg-danger-soft px-2 py-1.5 text-danger forced-colors:border forced-colors:border-[CanvasText]'
    : isDegraded
      ? 'rounded-lg bg-warn-soft px-2 py-1.5 text-warn forced-colors:border forced-colors:border-[CanvasText]'
      : 'rounded-lg px-2 py-1.5 text-ink-muted';

  const NetIcon = isOffline ? WifiOff : isDegraded ? AlertTriangle : Wifi;
  const netIconClass = isOffline ? 'text-danger' : isDegraded ? 'text-warn' : 'text-ok';

  const netLabel = isOffline
    ? 'Network: Offline'
    : isDegraded
      ? 'Network: Slow'
      : networkStatus?.latencyMs != null
        ? `Network: Healthy (${networkStatus.latencyMs}ms)`
        : 'Network: Healthy';

  const netSubtitle =
    networkStatus && netState !== 'online'
      ? [
          isOffline ? 'Scans & downloads paused' : isDegraded ? 'Heavy tasks paused' : null,
          networkStatus.deferredHeavyTasks?.deepScanPending ? 'Deep scan held' : null,
          (networkStatus.deferredHeavyTasks?.pendingDocumentJobs ?? 0) > 0
            ? `${networkStatus.deferredHeavyTasks.pendingDocumentJobs} doc(s) queued`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';

  const [politeAnnouncement, setPoliteAnnouncement] = useState('');
  const [assertiveAnnouncement, setAssertiveAnnouncement] = useState('');
  const prevNetStateRef = useRef<NetworkState | null>(null);
  const wasCheckingRef = useRef(false);
  const prevPausedReasonRef = useRef<string | null>(null);

  useEffect(() => {
    if (checkingNetwork) {
      wasCheckingRef.current = true;
      setPoliteAnnouncement('');
      setAssertiveAnnouncement('');
      return;
    }
    const completedRecheck = wasCheckingRef.current;
    wasCheckingRef.current = false;
    if (!netState) return;

    const prevState = prevNetStateRef.current;
    prevNetStateRef.current = netState;

    const stateChanged = prevState !== null && prevState !== netState;
    const initialAbnormal = prevState === null && netState !== 'online';
    if (!stateChanged && !initialAbnormal && !completedRecheck) return;

    if (netState === 'offline') {
      setPoliteAnnouncement('');
      setAssertiveAnnouncement(netSubtitle ? `Network offline. ${netSubtitle}.` : 'Network offline.');
    } else if (netState === 'degraded') {
      setAssertiveAnnouncement('');
      setPoliteAnnouncement(netSubtitle ? `Network slow. ${netSubtitle}.` : 'Network slow.');
    } else {
      setAssertiveAnnouncement('');
      setPoliteAnnouncement(
        prevState && prevState !== 'online' ? 'Network restored. Connection is healthy.' : 'Network healthy.'
      );
    }
  }, [netState, checkingNetwork, netSubtitle]);

  const visiblePausedReason = !scanning && scanStatus.pausedReason ? scanStatus.pausedReason : null;
  useEffect(() => {
    if (visiblePausedReason && visiblePausedReason !== prevPausedReasonRef.current) {
      setPoliteAnnouncement(visiblePausedReason);
    }
    prevPausedReasonRef.current = visiblePausedReason;
  }, [visiblePausedReason]);

  return (
    <div className="flex min-h-screen bg-bg text-ink">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-6 border-r border-line bg-surface p-4">
        <div className="flex items-center gap-2.5 px-2">
          <img src="/icon.png" alt="Tender Tracker" className="h-7 w-7 shrink-0 object-contain" />
          <span className="text-sm font-bold tracking-tight">Tender Tracker</span>
        </div>

        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {navItems.map(({ id, label, icon: Icon }) => {
            const on = section === id;
            return (
              <button
                key={id}
                onClick={() => onNavigate(id)}
                aria-current={on ? 'page' : undefined}
                className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium ${
                  on ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-3">
          <div role="status" className="sr-only" data-testid="status-announcer">
            {politeAnnouncement}
          </div>
          <div role="alert" className="sr-only" data-testid="alert-announcer">
            {assertiveAnnouncement}
          </div>
          {networkStatus && (
            <div
              data-testid="network-status-indicator"
              title={networkStatus.reason || undefined}
              className={`flex flex-col gap-0.5 ${netContainerClass}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
                  <NetIcon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${netIconClass}`} />
                  <span id={netLabelId} className="truncate">{netLabel}</span>
                </div>
                {onRecheckNetwork && (
                  <button
                    type="button"
                    onClick={onRecheckNetwork}
                    disabled={checkingNetwork}
                    aria-label="Recheck network connectivity"
                    aria-describedby={netSubtitle ? `${netLabelId} ${netDetailId}` : netLabelId}
                    title="Recheck network connectivity"
                    className="inline-flex min-h-6 min-w-6 shrink-0 cursor-pointer items-center justify-center rounded p-1 opacity-80 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className={`h-3.5 w-3.5 ${checkingNetwork ? 'motion-safe:animate-spin' : ''}`}
                    />
                  </button>
                )}
              </div>
              {netSubtitle && (
                <div id={netDetailId} className="pl-5 text-[11px] leading-snug opacity-90" data-testid="network-status-detail">
                  {netSubtitle}
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 px-2 text-xs text-ink-muted">
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${scanning ? 'motion-safe:animate-pulse bg-warn' : isFullScanStale ? 'bg-danger' : 'bg-ok'}`}
            />
            <span>{syncText}</span>
          </div>
          {scanning && scanStatus.activePortals && scanStatus.activePortals.length > 1 && (
            <div
              data-testid="active-workers"
              className="truncate px-2 text-[11px] text-ink-muted"
              title={scanStatus.activePortals.join(', ')}
            >
              Workers ({scanStatus.activePortals.length}): {scanStatus.activePortals.join(', ')}
            </div>
          )}
          {fullScanAgeHours !== null && (
            <div className={`px-2 text-[11px] leading-snug ${isFullScanStale ? 'font-semibold text-danger' : 'text-ink-muted'}`} data-testid="last-full-scan-indicator">
              {isFullScanStale
                ? `⚠️ Last full scan: ${Math.round(fullScanAgeHours)}h ago`
                : `Last full scan: ${fullScanAgeHours < 1 ? 'just now' : `${Math.round(fullScanAgeHours)}h ago`}`}
            </div>
          )}
          {(() => {
            const dq = scanStatus.docQueue;
            const hasLiveDocQueue = !scanning && Boolean(dq && (dq.isFetching || dq.totalPending > 0 || (dq.processing ?? 0) > 0));
            const deferredLines = [
              (scanStatus.documentsDeferred ?? 0) > 0 && !hasLiveDocQueue && `${scanStatus.documentsDeferred} document(s) moved to background`,
              (scanStatus.visionDeferred ?? 0) > 0 && `${scanStatus.visionDeferred} scanned notice(s) waiting for Vision`,
              (scanStatus.heldForScope ?? 0) > 0 && !hasLiveDocQueue && `${scanStatus.heldForScope} listing(s) held for document scope`
            ].filter(Boolean);
            return deferredLines.length > 0 ? (
              <div className="px-2 text-[11px] leading-snug text-ink-muted" data-testid="scan-deferred">
                {deferredLines.join(' · ')}
              </div>
            ) : null;
          })()}
          {!scanning &&
            scanStatus.docQueue &&
            (scanStatus.docQueue.isFetching ||
              scanStatus.docQueue.totalPending > 0 ||
              (scanStatus.docQueue.processing ?? 0) > 0) && (() => {
              const dq = scanStatus.docQueue!;
              const processingFiles = dq.processing ?? 0;
              const processingTenders = dq.processingTenders ?? 0;
              const isActivelyProcessing = dq.isFetching || processingFiles > 0;
              const headline = isActivelyProcessing && dq.readyPending > 0
                ? `Downloading Inbox docs (${dq.readyPending} left)`
                : isActivelyProcessing && dq.awaitingScopePending > 0
                  ? `Checking unmatched listings (${dq.awaitingScopePending} left)`
                  : isActivelyProcessing
                    ? 'Processing tender documents…'
                    : dq.readyPending > 0
                      ? `Inbox docs queued (${dq.readyPending})`
                      : `Scope check queued (${dq.awaitingScopePending} files)`;

              return (
                <div
                  className="flex flex-col gap-1 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[11px] leading-snug text-ink-muted forced-colors:border"
                  data-testid="doc-queue-indicator"
                >
                  <div className="flex items-center gap-1.5 font-medium text-ink">
                    {isActivelyProcessing && (
                      <>
                        <RefreshCw aria-hidden="true" className="h-3 w-3 shrink-0 motion-safe:animate-spin text-accent" />
                        <progress
                          className="sr-only"
                          aria-label={
                            dq.readyPending > 0
                              ? 'Downloading Inbox documents'
                              : dq.awaitingScopePending > 0
                                ? 'Checking unmatched listings'
                                : 'Processing tender documents'
                          }
                        />
                      </>
                    )}
                    <span>{headline}</span>
                  </div>
                  {(processingFiles > 0 || dq.readyPending > 0 || dq.awaitingScopePending > 0) && (
                    <div className="flex flex-col gap-0.5 pl-0.5 text-[10px] text-ink-muted">
                      {processingFiles > 0 && (
                        <div className="font-medium text-accent">
                          Active now: {processingTenders || 1} {(processingTenders || 1) === 1 ? 'tender' : 'tenders'} · {processingFiles} {processingFiles === 1 ? 'file' : 'files'}
                        </div>
                      )}
                      {dq.readyPending > 0 && (
                        <div>
                          Inbox queue: {dq.readyPending} {dq.readyPending === 1 ? 'file' : 'files'}
                          {dq.readyTenders ? ` · ${dq.readyTenders} ${dq.readyTenders === 1 ? 'tender' : 'tenders'}` : ''}
                        </div>
                      )}
                      {dq.awaitingScopePending > 0 && (
                        <div>
                          Scope queue: {dq.awaitingScopePending} {dq.awaitingScopePending === 1 ? 'file' : 'files'}
                          {dq.awaitingScopeTenders ? ` · ${dq.awaitingScopeTenders} ${dq.awaitingScopeTenders === 1 ? 'listing' : 'listings'}` : ''}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          {visiblePausedReason && (
            <div
              data-testid="scan-paused-reason"
              className="px-2 text-[11px] leading-snug text-warn"
            >
              {visiblePausedReason}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Button
              onClick={onRunScan}
              disabled={scanning || isOffline}
              aria-describedby={isOffline && netSubtitle ? netDetailId : undefined}
              title={isOffline ? 'Scan paused while offline' : isDegraded ? 'Quick scan (serial mode on slow network)' : 'Run quick scan'}
              className="flex-1"
            >
              <RefreshCw aria-hidden="true" className={`h-4 w-4 ${scanning ? 'motion-safe:animate-spin' : ''}`} />
              {scanning ? 'Scanning…' : 'Scan now'}
            </Button>
            {onRunDeepScan && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onRunDeepScan}
                disabled={scanning || deepPaused}
                aria-label="Run deep multi-page scan"
                aria-describedby={deepPaused && netSubtitle ? netDetailId : undefined}
                title={deepPaused ? 'Deep scan held until network connection is healthy' : 'Deep scan (scans deeper archive pages per portal)'}
                className="shrink-0"
              >
                Deep
              </Button>
            )}
          </div>
          <ThemeSwitch value={themePref} onChange={onThemePref} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
