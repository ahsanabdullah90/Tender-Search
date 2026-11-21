import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../../src/client/components/AppShell.js';
import type { ScanStatus, NetworkStatus } from '../../src/shared/types.js';

describe('AppShell component', () => {
  const idleScan: ScanStatus = {
    isScanning: false,
    currentPortal: null,
    progressPercent: 0,
    completedPortals: 0,
    totalPortals: 18,
    newTendersFound: 0,
    corrigendaFound: 0,
    lastScanTimestamp: '2026-05-10T14:30:00+05:00'
  };

  it('renders application branding as "Tender Tracker" and not sentinel', () => {
    render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByText('Tender Tracker')).toBeInTheDocument();
    expect(screen.queryByText(/sentinel/i)).not.toBeInTheDocument();
  });

  it('navigates between main sections (Inbox, Pipeline, Sources & Keywords)', async () => {
    const user = userEvent.setup();
    const handleNavigate = vi.fn();

    render(
      <AppShell
        section="inbox"
        onNavigate={handleNavigate}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    const pipelineBtn = screen.getByRole('button', { name: /Pipeline/ });
    await user.click(pipelineBtn);
    expect(handleNavigate).toHaveBeenCalledWith('pipeline');

    const sourcesBtn = screen.getByRole('button', { name: /Sources & Keywords/ });
    await user.click(sourcesBtn);
    expect(handleNavigate).toHaveBeenCalledWith('sources');
  });

  it('switches themes between System, Light, and Dark', async () => {
    const user = userEvent.setup();
    const handleThemePref = vi.fn();

    render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={handleThemePref}
      >
        <div>Content</div>
      </AppShell>
    );

    const darkBtn = screen.getByRole('radio', { name: 'Dark' });
    await user.click(darkBtn);
    expect(handleThemePref).toHaveBeenCalledWith('dark');
  });

  it('displays active scanning status and disables scan button while running', () => {
    const activeScan: ScanStatus = {
      isScanning: true,
      currentPortal: 'Punjab PPRA',
      progressPercent: 45,
      completedPortals: 4,
      totalPortals: 18,
      newTendersFound: 2,
      corrigendaFound: 0,
      lastScanTimestamp: null
    };

    render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={activeScan}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByText(/Scanning Punjab PPRA \(45%\)/)).toBeInTheDocument();
    const runScanBtn = screen.getByRole('button', { name: /Scanning/ });
    expect(runScanBtn).toBeDisabled();
  });

  it('handles scanning when currentPortal is null and handles not synced yet state', async () => {
    const user = userEvent.setup();
    const handleRunScan = vi.fn();
    const handleThemePref = vi.fn();

    const notSyncedScan: ScanStatus = {
      isScanning: false,
      currentPortal: null,
      progressPercent: 0,
      completedPortals: 0,
      totalPortals: 18,
      newTendersFound: 0,
      corrigendaFound: 0,
      lastScanTimestamp: null
    };

    const { rerender } = render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={notSyncedScan}
        onRunScan={handleRunScan}
        themePref="system"
        onThemePref={handleThemePref}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByText('Not synced yet')).toBeInTheDocument();

    // Trigger run scan
    const scanBtn = screen.getByRole('button', { name: /Scan now/i });
    await user.click(scanBtn);
    expect(handleRunScan).toHaveBeenCalledTimes(1);

    // Click light theme radio
    const lightRadio = screen.getByRole('radio', { name: 'Light' });
    await user.click(lightRadio);
    expect(handleThemePref).toHaveBeenCalledWith('light');

    // Scanning with null currentPortal
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{
          ...notSyncedScan,
          isScanning: true,
          progressPercent: 20
        }}
        onRunScan={handleRunScan}
        themePref="system"
        onThemePref={handleThemePref}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByText(/Scanning \(20%\)/)).toBeInTheDocument();
  });

  it('OPS-5 / F6: warns with bg-danger indicator when full scan is more than 24 hours old', () => {
    const staleScanTimestamp = new Date(Date.now() - 25 * 3600000).toISOString();
    const { container } = render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{
          ...idleScan,
          lastFullScanTimestamp: staleScanTimestamp,
          lastScanTimestamp: staleScanTimestamp
        }}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    // Indicator dot should carry bg-danger for stale scans (>= 24h)
    const dangerDot = container.querySelector('.bg-danger');
    expect(dangerDot).toBeInTheDocument();
  });

  it('Plan C & D: triggers deep scan and displays active parallel worker portals', async () => {
    const user = userEvent.setup();
    const handleRunDeepScan = vi.fn();

    const { rerender } = render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        onRunDeepScan={handleRunDeepScan}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    const deepBtn = screen.getByRole('button', { name: /Run deep multi-page scan/i });
    await user.click(deepBtn);
    expect(handleRunDeepScan).toHaveBeenCalledTimes(1);

    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{
          ...idleScan,
          isScanning: true,
          currentPortal: 'Punjab PPRA',
          activePortals: ['punjab_eproc', 'epads', 'kp_ppra'],
          progressPercent: 35
        }}
        onRunScan={vi.fn()}
        onRunDeepScan={handleRunDeepScan}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('active-workers')).toHaveTextContent('Workers (3): punjab_eproc, epads, kp_ppra');
    expect(screen.getByRole('button', { name: /Run deep multi-page scan/i })).toBeDisabled();
  });

  it('displays healthy network indicator and triggers manual recheck callback', async () => {
    const user = userEvent.setup();
    const handleRecheck = vi.fn();
    const onlineNet: NetworkStatus = {
      state: 'online',
      latencyMs: 42,
      checkedAt: '2026-11-19T10:00:00Z',
      reason: 'Healthy',
      heavyTasksPaused: false,
      deferredHeavyTasks: { deepScanPending: false, pendingDocumentJobs: 0 },
    };

    render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        onRunDeepScan={vi.fn()}
        networkStatus={onlineNet}
        onRecheckNetwork={handleRecheck}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('network-status-indicator')).toHaveTextContent('Network: Healthy (42ms)');
    expect(screen.getByRole('button', { name: /Scan now/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Run deep multi-page scan/i })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Recheck network connectivity/i }));
    expect(handleRecheck).toHaveBeenCalledTimes(1);
  });

  it('keeps quick scan enabled while disabling deep scan on degraded slow network', () => {
    const degradedNet: NetworkStatus = {
      state: 'degraded',
      latencyMs: 2200,
      checkedAt: '2026-11-19T10:00:00Z',
      reason: 'High RTT latency',
      heavyTasksPaused: true,
      deferredHeavyTasks: { deepScanPending: true, pendingDocumentJobs: 3 },
    };

    render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        onRunDeepScan={vi.fn()}
        networkStatus={degradedNet}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('network-status-indicator')).toHaveTextContent('Network: Slow');
    expect(screen.getByTestId('network-status-detail')).toHaveTextContent(
      'Heavy tasks paused · Deep scan held · 3 doc(s) queued'
    );
    expect(screen.getByRole('button', { name: /Scan now/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Run deep multi-page scan/i })).toBeDisabled();
  });

  it('disables both quick and deep scans when network is offline', () => {
    const offlineNet: NetworkStatus = {
      state: 'offline',
      latencyMs: null,
      checkedAt: '2026-11-19T10:00:00Z',
      reason: 'No internet connection',
      heavyTasksPaused: true,
      deferredHeavyTasks: { deepScanPending: false, pendingDocumentJobs: 0 },
    };

    render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        onRunDeepScan={vi.fn()}
        networkStatus={offlineNet}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('network-status-indicator')).toHaveTextContent('Network: Offline');
    expect(screen.getByTestId('network-status-detail')).toHaveTextContent('Scans & downloads paused');
    expect(screen.getByRole('button', { name: /Scan now/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Run deep multi-page scan/i })).toBeDisabled();
  });

  it('renders scan pausedReason only when not actively scanning', () => {
    const pausedReason = 'Slow network detected — deep scan held until connection is healthy';
    const { rerender } = render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{ ...idleScan, pausedReason }}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('scan-paused-reason')).toHaveTextContent(pausedReason);

    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{ ...idleScan, isScanning: true, progressPercent: 10, pausedReason }}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.queryByTestId('scan-paused-reason')).not.toBeInTheDocument();
  });

  it('manages centralized polite and assertive live-region announcements without poll spam', () => {
    const onlineNet: NetworkStatus = {
      state: 'online',
      latencyMs: 42,
      checkedAt: '2026-11-19T10:00:00Z',
      reason: 'Healthy',
      heavyTasksPaused: false,
      deferredHeavyTasks: { deepScanPending: false, pendingDocumentJobs: 0 },
    };
    const degradedNet: NetworkStatus = {
      state: 'degraded',
      latencyMs: 1900,
      checkedAt: '2026-11-19T10:01:00Z',
      reason: 'High latency',
      heavyTasksPaused: true,
      deferredHeavyTasks: { deepScanPending: true, pendingDocumentJobs: 2 },
    };
    const offlineNet: NetworkStatus = {
      state: 'offline',
      latencyMs: null,
      checkedAt: '2026-11-19T10:02:00Z',
      reason: 'No internet connection',
      heavyTasksPaused: true,
      deferredHeavyTasks: { deepScanPending: false, pendingDocumentJobs: 0 },
    };

    const { rerender } = render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        networkStatus={onlineNet}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    const statusAnnouncer = screen.getByTestId('status-announcer');
    const alertAnnouncer = screen.getByTestId('alert-announcer');
    expect(statusAnnouncer).toHaveAttribute('role', 'status');
    expect(statusAnnouncer).not.toHaveAttribute('aria-live');
    expect(alertAnnouncer).toHaveAttribute('role', 'alert');
    expect(alertAnnouncer).not.toHaveAttribute('aria-live');
    expect(statusAnnouncer).toHaveTextContent('');
    expect(alertAnnouncer).toHaveTextContent('');

    // Background 60s poll latency fluctuations stay silent
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        networkStatus={{ ...onlineNet, latencyMs: 38 }}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(statusAnnouncer).toHaveTextContent('');
    expect(alertAnnouncer).toHaveTextContent('');

    // Degraded state announces politely
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        networkStatus={degradedNet}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(statusAnnouncer).toHaveTextContent(
      'Network slow. Heavy tasks paused · Deep scan held · 2 doc(s) queued.'
    );
    expect(alertAnnouncer).toHaveTextContent('');

    // Offline drop announces assertively via role="alert"
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        networkStatus={offlineNet}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(alertAnnouncer).toHaveTextContent('Network offline. Scans & downloads paused.');
    expect(statusAnnouncer).toHaveTextContent('');

    // Recovery announces politely
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        networkStatus={onlineNet}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(statusAnnouncer).toHaveTextContent('Network restored. Connection is healthy.');
    expect(alertAnnouncer).toHaveTextContent('');

    // Interstitial checking state clears announcements without noisy "Checking..." speech
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        networkStatus={onlineNet}
        checkingNetwork={true}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(statusAnnouncer).toHaveTextContent('');
    expect(alertAnnouncer).toHaveTextContent('');

    // Completed manual recheck announces confirmed state
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        networkStatus={onlineNet}
        checkingNetwork={false}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(statusAnnouncer).toHaveTextContent('Network healthy.');

    // Scan pausedReason announces politely when idle
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{ ...idleScan, pausedReason: 'Slow network detected — deep scan held' }}
        onRunScan={vi.fn()}
        networkStatus={onlineNet}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(statusAnnouncer).toHaveTextContent('Slow network detected — deep scan held');
  });

  it('keeps interactive controls outside live regions with accessible target size, motion-safe classes, and forced-colors borders', () => {
    const degradedNet: NetworkStatus = {
      state: 'degraded',
      latencyMs: 2200,
      checkedAt: '2026-11-19T10:00:00Z',
      reason: 'High latency',
      heavyTasksPaused: true,
      deferredHeavyTasks: { deepScanPending: true, pendingDocumentJobs: 1 },
    };
    const offlineNet: NetworkStatus = {
      state: 'offline',
      latencyMs: null,
      checkedAt: '2026-11-19T10:01:00Z',
      reason: 'No internet connection',
      heavyTasksPaused: true,
      deferredHeavyTasks: { deepScanPending: false, pendingDocumentJobs: 0 },
    };

    const { rerender } = render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        onRunDeepScan={vi.fn()}
        networkStatus={degradedNet}
        checkingNetwork={true}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    const indicator = screen.getByTestId('network-status-indicator');
    expect(indicator).not.toHaveAttribute('role');
    expect(indicator).not.toHaveAttribute('aria-live');
    expect(indicator.className).toContain('forced-colors:border');
    expect(indicator.innerHTML).not.toContain('animate-pulse');

    const recheckBtn = screen.getByRole('button', { name: /Recheck network connectivity/i });
    expect(recheckBtn.closest('[role="status"], [role="alert"]')).toBeNull();
    expect(recheckBtn.className).toContain('min-h-6');
    expect(recheckBtn.className).toContain('min-w-6');
    expect(recheckBtn).toHaveAccessibleDescription(/Network: Slow.*Heavy tasks paused/);

    const svgs = indicator.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    svgs.forEach(svg => expect(svg).toHaveAttribute('aria-hidden', 'true'));
    const recheckIcon = recheckBtn.querySelector('svg');
    expect(recheckIcon?.getAttribute('class')).toContain('motion-safe:animate-spin');

    expect(screen.getByRole('button', { name: /Run deep multi-page scan/i })).toHaveAccessibleDescription(
      /Heavy tasks paused/
    );

    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={idleScan}
        onRunScan={vi.fn()}
        onRunDeepScan={vi.fn()}
        networkStatus={offlineNet}
        checkingNetwork={false}
        onRecheckNetwork={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('network-status-indicator').className).toContain('forced-colors:border');
    expect(screen.getByRole('button', { name: /Scan now/i })).toHaveAccessibleDescription(/Scans & downloads paused/);
  });

  it('displays live sidebar document queue status across fetching Inbox, checking unmatched, and idle queued states', () => {
    const { rerender } = render(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{
          ...idleScan,
          docQueue: { isFetching: true, readyPending: 5, awaitingScopePending: 12, totalPending: 17, completedInRun: 3 }
        }}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    const indicator = screen.getByTestId('doc-queue-indicator');
    expect(indicator).toHaveTextContent('Downloading Inbox docs (5 left)');
    expect(indicator.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(indicator.querySelector('svg')?.getAttribute('class')).toContain('motion-safe:animate-spin');
    expect(indicator.querySelector('progress')).toHaveAttribute('aria-label', 'Downloading Inbox documents');

    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{
          ...idleScan,
          docQueue: { isFetching: true, readyPending: 0, awaitingScopePending: 12, totalPending: 12, completedInRun: 8 }
        }}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(screen.getByTestId('doc-queue-indicator')).toHaveTextContent('Checking unmatched listings (12 left)');

    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{
          ...idleScan,
          docQueue: { isFetching: false, readyPending: 3, awaitingScopePending: 0, totalPending: 3, completedInRun: 0 }
        }}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(screen.getByTestId('doc-queue-indicator')).toHaveTextContent('Inbox docs queued (3)');

    // Rich tender + file + active processing + scope-queue visibility even when readyPending === 0
    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{
          ...idleScan,
          heldForScope: 72,
          docQueue: {
            isFetching: true,
            readyPending: 5,
            readyTenders: 3,
            awaitingScopePending: 12,
            awaitingScopeTenders: 4,
            totalPending: 17,
            processing: 2,
            processingTenders: 2,
            activeTenderIds: ['t-1', 't-2'],
            completedInRun: 4
          }
        }}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );

    const activeCard = screen.getByTestId('doc-queue-indicator');
    expect(activeCard).toHaveTextContent('Active now: 2 tenders · 2 files');
    expect(activeCard).toHaveTextContent('Inbox queue: 5 files · 3 tenders');
    expect(activeCard).toHaveTextContent('Scope queue: 12 files · 4 listings');
    expect(screen.queryByTestId('scan-deferred')).not.toBeInTheDocument();

    rerender(
      <AppShell
        section="inbox"
        onNavigate={vi.fn()}
        scanStatus={{
          ...idleScan,
          docQueue: {
            isFetching: false,
            readyPending: 0,
            readyTenders: 0,
            awaitingScopePending: 387,
            awaitingScopeTenders: 200,
            totalPending: 387,
            processing: 0,
            processingTenders: 0,
            completedInRun: 0
          }
        }}
        onRunScan={vi.fn()}
        themePref="system"
        onThemePref={vi.fn()}
      >
        <div>Content</div>
      </AppShell>
    );
    expect(screen.getByTestId('doc-queue-indicator')).toHaveTextContent('Scope check queued (387 files)');
    expect(screen.getByTestId('doc-queue-indicator')).toHaveTextContent('Scope queue: 387 files · 200 listings');
  });
});
