import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourcesScreen } from '../../src/client/components/SourcesScreen.js';
import type { PortalHealth, DomainTrack } from '../../src/shared/types.js';

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

  it('handles adding, editing, and deleting domain tracks', async () => {
    const user = userEvent.setup();
    const handleSaveTrack = vi.fn();
    const handleDeleteTrack = vi.fn();

    render(
      <SourcesScreen
        portals={samplePortals}
        tracks={sampleTracks}
        onSaveTrack={handleSaveTrack}
        onDeleteTrack={handleDeleteTrack}
        onClearInbox={vi.fn()}
        onEraseAll={vi.fn()}
        onUpdatePortal={vi.fn()}
        onLaunchHitl={vi.fn()}
        onVerifyHitl={vi.fn()}
        onScanSinglePortal={vi.fn()}
      />
    );

    // 1. Add domain dialog
    const addDomainBtn = screen.getByRole('button', { name: /Add domain/i });
    await user.click(addDomainBtn);

    const addDialog = screen.getByRole('dialog', { name: 'Add domain' });
    expect(addDialog).toBeInTheDocument();

    const nameInput = within(addDialog).getByLabelText(/Domain name/i);
    await user.type(nameInput, 'Information Technology');

    const posInput = within(addDialog).getByLabelText(/Words to look for/i);
    await user.type(posInput, 'software, cloud');

    const saveBtn = within(addDialog).getByRole('button', { name: 'Save' });
    await user.click(saveBtn);

    expect(handleSaveTrack).toHaveBeenCalledWith({
      id: undefined,
      name: 'Information Technology',
      positive_keywords: ['software', 'cloud'],
      negative_keywords: []
    });

    // 2. Edit domain dialog
    const editBtn = screen.getByRole('button', { name: 'Edit Solar & Clean Energy' });
    await user.click(editBtn);

    const editDialog = screen.getByRole('dialog', { name: 'Edit domain' });
    const editSaveBtn = within(editDialog).getByRole('button', { name: 'Save' });
    await user.click(editSaveBtn);
    expect(handleSaveTrack).toHaveBeenCalled();

    // 3. Delete domain dialog
    const deleteBtn = screen.getByRole('button', { name: 'Delete Solar & Clean Energy' });
    await user.click(deleteBtn);

    const delDialog = screen.getByRole('dialog', { name: 'Delete this domain?' });
    const delConfirmBtn = within(delDialog).getByRole('button', { name: 'Delete' });
    await user.click(delConfirmBtn);
    expect(handleDeleteTrack).toHaveBeenCalledWith('track-solar');
  });

  it('handles HITL verification flow, retry, and portal editing in Portals tab', async () => {
    const user = userEvent.setup();
    const handleLaunchHitl = vi.fn();
    const handleVerifyHitl = vi.fn();
    const handleScanSinglePortal = vi.fn();
    const handleUpdatePortal = vi.fn();

    const portalsWithOffline: PortalHealth[] = [
      ...samplePortals,
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
        last_error_message: 'Offline',
        access_mode: 'offline_broken'
      }
    ];

    render(
      <SourcesScreen
        portals={portalsWithOffline}
        tracks={sampleTracks}
        onSaveTrack={vi.fn()}
        onDeleteTrack={vi.fn()}
        onClearInbox={vi.fn()}
        onEraseAll={vi.fn()}
        onUpdatePortal={handleUpdatePortal}
        onLaunchHitl={handleLaunchHitl}
        onVerifyHitl={handleVerifyHitl}
        onScanSinglePortal={handleScanSinglePortal}
      />
    );

    const portalsTab = screen.getByRole('tab', { name: /Portals/ });
    await user.click(portalsTab);

    // Verify now button for Tender Services (needs verification)
    const verifyNowBtn = screen.getByRole('button', { name: 'Verify now' });
    await user.click(verifyNowBtn);
    expect(handleLaunchHitl).toHaveBeenCalledWith('tender_services');

    // Click "I've finished" button
    const finishedBtn = screen.getByRole('button', { name: "I've finished" });
    await user.click(finishedBtn);
    expect(handleVerifyHitl).toHaveBeenCalledWith('tender_services');

    // Click Retry button on offline portal
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    await user.click(retryBtn);
    expect(handleScanSinglePortal).toHaveBeenCalledWith('kppra');

    // Edit portal details
    const editPortalBtn = screen.getByRole('button', { name: 'Edit Punjab PPRA (eproc.punjab.gov.pk)' });
    await user.click(editPortalBtn);

    const editDialog = screen.getByRole('dialog', { name: /Edit Punjab PPRA/ });

    // Edit name, tenders page address, and website address inputs
    const nameInput = within(editDialog).getByLabelText(/Portal name|Name/);
    await user.clear(nameInput);
    await user.type(nameInput, 'Punjab PPRA eProcurement');

    const webAddrInput = within(editDialog).getByLabelText('Website address');
    await user.clear(webAddrInput);
    await user.type(webAddrInput, 'https://eproc.punjab.gov.pk/home');

    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: '', loginUrl: '', hasPassword: false })
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true })
      } as any);

    const loginDetailsBtn = within(editDialog).getByRole('button', { name: /Login details/i });
    await user.click(loginDetailsBtn);

    // In credentials modal, submit or trigger success
    const credHeading = await screen.findByRole('heading', { name: 'Portal Credentials' });
    expect(credHeading).toBeInTheDocument();
    const userField = await screen.findByLabelText(/Username \/ Email|Email \/ Username/i);
    await user.type(userField, 'operator@domain.com');
    const passField = screen.getByLabelText(/Password/i);
    await user.type(passField, 'SecretPass123!');

    const verifyBtn = screen.getByRole('button', { name: /Save & Log In/i });
    await user.click(verifyBtn);

    await waitFor(() => {
      expect(handleUpdatePortal).toHaveBeenCalledWith('punjab_eproc', { status: 'online' });
    }, { timeout: 3000 });

    // Reopen edit dialog to test save
    await user.click(editPortalBtn);
    const editDialog2 = screen.getByRole('dialog', { name: /Edit Punjab PPRA/ });
    const webAddrInput2 = within(editDialog2).getByLabelText('Website address');
    await user.clear(webAddrInput2);
    await user.type(webAddrInput2, 'https://eproc.punjab.gov.pk/home');
    const savePortalBtn = within(editDialog2).getByRole('button', { name: 'Save' });
    await user.click(savePortalBtn);
    expect(handleUpdatePortal).toHaveBeenCalledWith('punjab_eproc', expect.objectContaining({
      base_url: 'https://eproc.punjab.gov.pk/home'
    }));

    // Test Auto-find tender page button inside edit portal dialog
    await user.click(editPortalBtn);
    const editDialog3 = screen.getByRole('dialog', { name: /Edit Punjab PPRA/ });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        tendersUrl: 'https://bpptwo.vdc.services:5451/Tenders',
        message: 'Discovered tender page (10 listings found)'
      })
    } as any);
    const autoFindBtn = within(editDialog3).getByRole('button', { name: /Auto-find tender page/i });
    await user.click(autoFindBtn);
    await waitFor(() => {
      expect(within(editDialog3).getByText(/Discovered tender page/i)).toBeInTheDocument();
    });
    const cancelPortalBtn = within(editDialog3).getByRole('button', { name: 'Cancel' });
    await user.click(cancelPortalBtn);
    expect(screen.queryByRole('dialog', { name: /Edit Punjab PPRA/ })).not.toBeInTheDocument();
  });

  it('handles error when loading data settings fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Data API failure'));

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
    const user = userEvent.setup();
    await user.click(dataTab);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to load data settings:', expect.any(Error));
    });
  });

  it('handles backups, document pruning, and factory reset in Data tab', async () => {
    const user = userEvent.setup();
    const handleEraseAll = vi.fn();

    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'backup_1.db', created_at: '2026-05-01T10:00:00Z', size_bytes: 500000 }]
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total_bytes: 10000000,
          passed_bytes: 4000000,
          passed_tenders: 2,
          tenders_with_documents: 5
        })
      } as any)
      // Prune endpoint response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ freed_bytes: 4000000, tenders: 2 })
      } as any)
      // Reload backups & storage after prune
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total_bytes: 0, passed_bytes: 0, passed_tenders: 0, tenders_with_documents: 0 }) } as any);

    render(
      <SourcesScreen
        portals={samplePortals}
        tracks={sampleTracks}
        onSaveTrack={vi.fn()}
        onDeleteTrack={vi.fn()}
        onClearInbox={vi.fn()}
        onEraseAll={handleEraseAll}
        onUpdatePortal={vi.fn()}
        onLaunchHitl={vi.fn()}
        onVerifyHitl={vi.fn()}
        onScanSinglePortal={vi.fn()}
      />
    );

    const dataTab = screen.getByRole('tab', { name: /Data/ });
    await user.click(dataTab);

    // Prune documents
    const pruneBtn = await screen.findByRole('button', { name: /Delete files for passed tenders/ });
    await user.click(pruneBtn);

    const pruneDialog = screen.getByRole('dialog', { name: 'Delete files for passed tenders?' });
    const pruneConfirmBtn = within(pruneDialog).getByRole('button', { name: 'Delete files' });
    await user.click(pruneConfirmBtn);

    await waitFor(() => {
      expect(screen.getByText(/Deleted files for 2 passed tenders and freed/)).toBeInTheDocument();
    });

    // Dismiss message
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    await user.click(dismissBtn);

    // Export CSV with scope change
    const scopeSelect = screen.getByLabelText(/What to include/i);
    await user.selectOptions(scopeSelect, 'inbox');
    const exportBtn = screen.getByRole('button', { name: /Export/i });
    await user.click(exportBtn);

    // Erase all data confirmation dialog
    const eraseBtn = screen.getByRole('button', { name: 'Erase all data' });
    await user.click(eraseBtn);

    const eraseDialog = screen.getByRole('dialog', { name: 'Erase all data?' });
    const eraseConfirmBtn = within(eraseDialog).getByRole('button', { name: 'Erase everything' });
    expect(eraseConfirmBtn).toBeDisabled();

    const typeInput = within(eraseDialog).getByLabelText('Type CLEAR to confirm');
    await user.type(typeInput, 'CLEAR');
    expect(eraseConfirmBtn).toBeEnabled();

    await user.click(eraseConfirmBtn);
    expect(handleEraseAll).toHaveBeenCalledTimes(1);
  });

  it('handles manual backup and prune error messages in Data tab', async () => {
    const user = userEvent.setup();

    vi.spyOn(global, 'fetch')
      // initial load
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total_bytes: 1000, passed_bytes: 500, passed_tenders: 2, tenders_with_documents: 2 }) } as any)
      // backup success
      .mockResolvedValueOnce({ ok: true } as any)
      // reload after backup
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total_bytes: 1000, passed_bytes: 500, passed_tenders: 2, tenders_with_documents: 2 }) } as any)
      // prune failure
      .mockResolvedValueOnce({ ok: false } as any)
      // reload after prune
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total_bytes: 1000, passed_bytes: 500, passed_tenders: 2, tenders_with_documents: 2 }) } as any);

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

    // 1. Back up now
    const backupBtn = await screen.findByRole('button', { name: /Back up now/i });
    await user.click(backupBtn);

    await waitFor(() => {
      expect(screen.getByText('Backup created.')).toBeInTheDocument();
    });

    // 2. Prune failure
    const pruneBtn = screen.getByRole('button', { name: /Delete files for passed tenders/ });
    await user.click(pruneBtn);

    const pruneDialog = screen.getByRole('dialog', { name: 'Delete files for passed tenders?' });
    const pruneConfirmBtn = within(pruneDialog).getByRole('button', { name: 'Delete files' });
    await user.click(pruneConfirmBtn);

    await waitFor(() => {
      expect(screen.getByText('Could not delete the files.')).toBeInTheDocument();
    });
  });

  it('allows adding a new procurement portal through the dialog', async () => {
    const user = userEvent.setup();
    const handleAddPortal = vi.fn().mockResolvedValue(true);

    render(
      <SourcesScreen
        portals={samplePortals}
        tracks={sampleTracks}
        onSaveTrack={vi.fn()}
        onDeleteTrack={vi.fn()}
        onClearInbox={vi.fn()}
        onEraseAll={vi.fn()}
        onUpdatePortal={vi.fn()}
        onAddPortal={handleAddPortal}
        onDeletePortal={vi.fn()}
        onLaunchHitl={vi.fn()}
        onVerifyHitl={vi.fn()}
        onScanSinglePortal={vi.fn()}
      />
    );

    // Switch to Portals tab
    const portalsTab = screen.getByRole('tab', { name: /Portals/ });
    await user.click(portalsTab);

    // Click "+ Add portal"
    const addBtn = screen.getByRole('button', { name: /Add portal/i });
    await user.click(addBtn);

    // Dialog appears
    const dialog = screen.getByRole('dialog', { name: 'Add procurement portal' });
    expect(dialog).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText('e.g. Sindh Irrigation Department');
    const urlInput = screen.getByPlaceholderText('https://example.gov.pk/tenders');

    await user.type(nameInput, 'Custom Irrigation Department');
    await user.type(urlInput, 'https://irrigation.punjab.gov.pk/tenders');

    const submitBtn = within(dialog).getByRole('button', { name: 'Add portal' });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(handleAddPortal).toHaveBeenCalledTimes(1);
      expect(handleAddPortal).toHaveBeenCalledWith(
        expect.objectContaining({
          portal_name: 'Custom Irrigation Department',
          tenders_url: 'https://irrigation.punjab.gov.pk/tenders',
          category: 'Provincial'
        })
      );
    });
  });

  it('allows deleting a portal through the confirmation dialog', async () => {
    const user = userEvent.setup();
    const handleDeletePortal = vi.fn().mockResolvedValue(true);

    render(
      <SourcesScreen
        portals={samplePortals}
        tracks={sampleTracks}
        onSaveTrack={vi.fn()}
        onDeleteTrack={vi.fn()}
        onClearInbox={vi.fn()}
        onEraseAll={vi.fn()}
        onUpdatePortal={vi.fn()}
        onAddPortal={vi.fn()}
        onDeletePortal={handleDeletePortal}
        onLaunchHitl={vi.fn()}
        onVerifyHitl={vi.fn()}
        onScanSinglePortal={vi.fn()}
      />
    );

    const portalsTab = screen.getByRole('tab', { name: /Portals/ });
    await user.click(portalsTab);

    // Click delete on first portal
    const deleteBtn = screen.getByRole('button', { name: /Delete Punjab PPRA/i });
    await user.click(deleteBtn);

    // Confirm dialog appears
    const dialog = screen.getByRole('dialog', { name: 'Delete this portal?' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Are you sure you want to remove/i)).toBeInTheDocument();

    const confirmBtn = within(dialog).getByRole('button', { name: 'Delete' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(handleDeletePortal).toHaveBeenCalledTimes(1);
      expect(handleDeletePortal).toHaveBeenCalledWith('punjab_eproc');
    });
  });

  it('Plan D: displays structured last_error_code chip on errored portals', async () => {
    const user = userEvent.setup();
    const portalsWithErrorCode = [
      {
        ...samplePortals[0],
        status: 'error' as const,
        last_error_code: 'TIMEOUT' as const,
        last_error_message: 'Timed out after 15s'
      }
    ];

    render(
      <SourcesScreen
        portals={portalsWithErrorCode}
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

    await user.click(screen.getByRole('tab', { name: /Portals/ }));
    expect(screen.getByText('TIMEOUT')).toBeInTheDocument();
    expect(screen.getByText('Timed out after 15s')).toBeInTheDocument();
  });

  it('Plan B: renders and saves Daily Digest & Closing Alerts settings in Data tab', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total_bytes: 1024,
          passed_bytes: 0,
          passed_tenders: 0,
          tenders_with_documents: 1,
          digest: {
            settings: { enabled: true, webhookUrl: 'https://hooks.example/test', withinHours: 48, lastSentDatePkt: null },
            summary: { closingSoonCount: 4, unacknowledgedCorrigendaCount: 2, newMatchesLast24hCount: 5 }
          }
        })
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, settings: { enabled: true, webhookUrl: 'https://hooks.example/updated', withinHours: 72, lastSentDatePkt: null } })
      } as any)
      .mockResolvedValue({ ok: true, json: async () => [] } as any);

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

    await user.click(screen.getByRole('tab', { name: /Data/ }));

    expect(await screen.findByText(/4 closing within 48h/i)).toBeInTheDocument();
    expect(screen.getByText(/2 unread corrigenda/i)).toBeInTheDocument();

    const webhookInput = screen.getByPlaceholderText('https://hooks.slack.com/services/...');
    await user.clear(webhookInput);
    await user.type(webhookInput, 'https://hooks.example/updated');

    await user.click(screen.getByRole('button', { name: 'Save digest settings' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/system/digest/settings',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('https://hooks.example/updated')
        })
      );
    });
  });
});
