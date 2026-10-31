import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KpiHeader } from '../../src/components/KpiHeader.js';
import type { CorrigendumLog, PortalHealth } from '../../src/types.js';

describe('KpiHeader component', () => {
  const baseStats = {
    totalTracked: 150,
    closingSoon: 5,
    inPipeline: 12,
    unackCorrigenda: 2,
    totalPortals: 18,
    onlinePortals: 14,
    hitlRequiredCount: 1
  };

  const sampleCorrigenda: (CorrigendumLog & { tender_title: string; portal_name: string })[] = [
    {
      id: 'corr-1',
      tender_id: 'tender-1',
      change_type: 'deadline_extension',
      previous_value: '20-05-2026',
      new_value: '30-05-2026',
      is_acknowledged: 0,
      detected_at: '2026-05-10',
      tender_title: 'Solar Panels in District Schools',
      portal_name: 'Punjab PPRA'
    }
  ];

  const samplePortals: PortalHealth[] = [
    {
      portal_id: 'epads',
      portal_name: 'Federal PPRA (EPADS)',
      category: 'Regulatory',
      tier: 'playwright',
      base_url: 'https://ppra.gov.pk',
      tenders_url: 'https://epms.ppra.gov.pk',
      status: 'hitl_required',
      last_scan_at: null,
      last_items_found: 0,
      consecutive_zero_yields: 0,
      last_error_message: null,
      access_mode: 'login_required',
      verified_status: 'Challenge detected'
    },
    {
      portal_id: 'kppra',
      portal_name: 'KPK KPPRA',
      category: 'Regulatory',
      tier: 'http',
      base_url: 'https://kppra.gov.pk',
      tenders_url: 'https://kppra.gov.pk',
      status: 'error',
      last_scan_at: null,
      last_items_found: 0,
      consecutive_zero_yields: 3,
      last_error_message: 'Domain unreachable',
      access_mode: 'offline_broken',
      verified_status: 'Domain unreachable'
    }
  ];

  it('renders all KPI counters accurately', () => {
    render(
      <KpiHeader
        stats={baseStats}
        corrigenda={[]}
        portals={[]}
        onAcknowledgeCorrigendum={vi.fn()}
        onLaunchHitl={vi.fn()}
        onOpenSources={vi.fn()}
      />
    );

    expect(screen.getByText('Total monitored')).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();

    expect(screen.getByText('Closing in 72 hours')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();

    expect(screen.getByText('In pipeline')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();

    expect(screen.getByText('Amendments to review')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders human verification banner and launches HITL browser', async () => {
    const user = userEvent.setup();
    const handleLaunchHitl = vi.fn();

    render(
      <KpiHeader
        stats={baseStats}
        corrigenda={[]}
        portals={samplePortals}
        onAcknowledgeCorrigendum={vi.fn()}
        onLaunchHitl={handleLaunchHitl}
        onOpenSources={vi.fn()}
      />
    );

    expect(screen.getByText(/Human verification required on Federal PPRA/)).toBeInTheDocument();
    const launchBtn = screen.getByRole('button', { name: /Launch browser for Federal/ });
    await user.click(launchBtn);
    expect(handleLaunchHitl).toHaveBeenCalledWith('epads');
  });

  it('renders corrigendum banner and acknowledges amendment', async () => {
    const user = userEvent.setup();
    const handleAck = vi.fn();

    render(
      <KpiHeader
        stats={baseStats}
        corrigenda={sampleCorrigenda as any}
        portals={[]}
        onAcknowledgeCorrigendum={handleAck}
        onLaunchHitl={vi.fn()}
        onOpenSources={vi.fn()}
      />
    );

    expect(screen.getByText(/Submission deadline extended/)).toBeInTheDocument();
    expect(screen.getByText('"Solar Panels in District Schools"')).toBeInTheDocument();

    const ackBtn = screen.getByRole('button', { name: 'Acknowledge' });
    await user.click(ackBtn);
    expect(handleAck).toHaveBeenCalledWith('corr-1');
  });

  it('renders portal outage banner and navigates to sources', async () => {
    const user = userEvent.setup();
    const handleOpenSources = vi.fn();

    render(
      <KpiHeader
        stats={baseStats}
        corrigenda={[]}
        portals={samplePortals}
        onAcknowledgeCorrigendum={vi.fn()}
        onLaunchHitl={vi.fn()}
        onOpenSources={handleOpenSources}
      />
    );

    expect(screen.getByText(/1 portals/)).toBeInTheDocument();
    const reviewBtn = screen.getByRole('button', { name: /Review portals/ });
    await user.click(reviewBtn);
    expect(handleOpenSources).toHaveBeenCalledTimes(1);
  });
});
