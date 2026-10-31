import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourcesScreen } from '../../src/components/SourcesScreen.js';
import type { PortalHealth, DomainTrack } from '../../src/types.js';

describe('SourcesScreen component', () => {
  const samplePortals: PortalHealth[] = [
    {
      portal_id: 'punjab_eproc',
      portal_name: 'Punjab PPRA (eproc.punjab.gov.pk)',
      category: 'Regulatory',
      tier: 'http',
      base_url: 'https://ppra.punjab.gov.pk',
      tenders_url: 'http://eproc.punjab.gov.pk/ActiveTenders.aspx',
      status: 'online',
      last_scan_at: '2026-05-01T10:00:00+05:00',
      last_items_found: 15,
      consecutive_zero_yields: 0,
      last_error_message: null,
      access_mode: 'public',
      verified_status: 'Working'
    },
    {
      portal_id: 'tender_services',
      portal_name: 'Tender Services Pakistan',
      category: 'Aggregator',
      tier: 'http',
      base_url: 'https://tenderservice.pk',
      tenders_url: 'https://tenderservice.pk/tenders',
      login_url: 'https://tenderservice.pk/permits/login.php',
      status: 'hitl_required',
      last_scan_at: null,
      last_items_found: 0,
      consecutive_zero_yields: 0,
      last_error_message: null,
      access_mode: 'login_required',
      verified_status: 'Login required'
    }
  ];

  const sampleTracks: DomainTrack[] = [
    {
      id: 'track-solar',
      name: 'Solar & Clean Energy',
      positive_keywords: ['solar', 'photovoltaic'],
      negative_keywords: ['janitorial'],
      is_active: 1
    }
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders subtabs and switches to Portals tab', async () => {
    const user = userEvent.setup();

    render(
      <SourcesScreen
        portals={samplePortals}
        tracks={sampleTracks}
        onSaveTrack={vi.fn()}
        onDeleteTrack={vi.fn()}
        onClearInbox={vi.fn()}
        onEraseAll={vi.fn()}
        onUpdatePortal={vi.fn()}
        onLaunchHitl={vi.fn()}
        onVerifyHitl={vi.fn()}
        onScanSinglePortal={vi.fn()}
      />
    );

    expect(screen.getByRole('tab', { name: /Portals/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Keywords/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Data/ })).toBeInTheDocument();

    const portalsTab = screen.getByRole('tab', { name: /Portals/ });
    await user.click(portalsTab);

    expect(screen.getByText('Punjab PPRA (eproc.punjab.gov.pk)')).toBeInTheDocument();
    expect(screen.getByText('Tender Services Pakistan')).toBeInTheDocument();
  });

  it('switches to Keywords tab and shows tracks', async () => {
    const user = userEvent.setup();

    render(
      <SourcesScreen
        portals={samplePortals}
        tracks={sampleTracks}
        onSaveTrack={vi.fn()}
        onDeleteTrack={vi.fn()}
        onClearInbox={vi.fn()}
        onEraseAll={vi.fn()}
        onUpdatePortal={vi.fn()}
        onLaunchHitl={vi.fn()}
        onVerifyHitl={vi.fn()}
        onScanSinglePortal={vi.fn()}
      />
    );

    const tracksTab = screen.getByRole('tab', { name: /Keywords/ });
    await user.click(tracksTab);

    expect(screen.getByText('Solar & Clean Energy')).toBeInTheDocument();
    expect(screen.getByText('solar')).toBeInTheDocument();
  });

  it('switches to Data tab and renders Danger zone with accurate B12 wording', async () => {
    const user = userEvent.setup();

    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => []
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total_bytes: 5000000,
          passed_bytes: 2000000,
          passed_tenders: 3,
          tenders_with_documents: 8
        })
      } as any);

    render(
      <SourcesScreen
        portals={samplePortals}
        tracks={sampleTracks}
        onSaveTrack={vi.fn()}
        onDeleteTrack={vi.fn()}
        onClearInbox={vi.fn()}
        onEraseAll={vi.fn()}
        onUpdatePortal={vi.fn()}
        onLaunchHitl={vi.fn()}
        onVerifyHitl={vi.fn()}
        onScanSinglePortal={vi.fn()}
      />
    );

    const dataTab = screen.getByRole('tab', { name: /Data/ });
    await user.click(dataTab);

    // Verify Bug B12 fix: mentions unreviewed opportunities and preserved pipeline/bookmarks
    await waitFor(() => {
      expect(screen.getByText(/Removes unreviewed opportunities from the inbox/i)).toBeInTheDocument();
      expect(screen.getByText(/Active bid pursuits, bookmarks, and pipeline records are preserved/i)).toBeInTheDocument();
    });
  });

  it('opens and confirms Clear Inbox dialog (Bug B12)', async () => {
    const user = userEvent.setup();
    const handleClearInbox = vi.fn();

    vi.spyOn(global, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => []
      } as any);

    render(
      <SourcesScreen
        portals={samplePortals}
        tracks={sampleTracks}
        onSaveTrack={vi.fn()}
        onDeleteTrack={vi.fn()}
        onClearInbox={handleClearInbox}
        onEraseAll={vi.fn()}
        onUpdatePortal={vi.fn()}
        onLaunchHitl={vi.fn()}
        onVerifyHitl={vi.fn()}
        onScanSinglePortal={vi.fn()}
      />
    );

    const dataTab = screen.getByRole('tab', { name: /Data/ });
    await user.click(dataTab);

    const clearInboxBtn = await screen.findByRole('button', { name: 'Clear Inbox' });
    await user.click(clearInboxBtn);

    const dialog = screen.getByRole('dialog', { name: 'Clear the Inbox?' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Unreviewed opportunities in the inbox will be cleared/i)).toBeInTheDocument();

    // Confirm dialog button
    const confirmBtn = within(dialog).getByRole('button', { name: 'Clear Inbox' });
    await user.click(confirmBtn);

    expect(handleClearInbox).toHaveBeenCalledTimes(1);
  });
});
