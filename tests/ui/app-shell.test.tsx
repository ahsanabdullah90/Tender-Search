import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../../src/client/components/AppShell.js';
import type { ScanStatus } from '../../src/shared/types.js';

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
});
