import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../../src/components/AppShell.js';
import type { ScanStatus } from '../../src/types.js';

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
});
