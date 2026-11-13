import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InboxScreen, asList } from '../../src/client/components/InboxScreen.js';
import type { Tender, DomainTrack } from '../../src/shared/types.js';

describe('InboxScreen component', () => {
  const sampleTracks: DomainTrack[] = [
    {
      id: 'track-1',
      name: 'Solar & Clean Energy',
      positive_keywords: ['solar'],
      negative_keywords: [],
      is_active: 1
    }
  ];

  const sampleTenders: Tender[] = [
    {
      id: 'tender-1',
      canonical_id: 'tender-1',
      portal_id: 'punjab_eproc',
      portal_name: 'Punjab PPRA',
      reference_no: 'REF-101',
      title: 'Solarization of District Headquarters Hospitals',
      organization: 'Specialized Healthcare Department',
      description: 'Turnkey solar PV system design, supply and installation',
      estimated_value: 'PKR 45,000,000',
      location: 'Lahore',
      publish_date: '2026-05-01',
      // Relative to now so the sample stays an open tender (closed ones are hidden by default)
      closing_date: new Date(Date.now() + 30 * 86400000).toISOString(),
      closing_date_formatted: '30-08-2026',
      direct_url: 'https://example.com/t1',
      secondary_sources: [],
      domain_tracks: ['Solar & Clean Energy'],
      matched_keywords: ['solar'],
      match_score: 95,
      cached_dossiers: [],
      has_corrigendum: 0,
      pipeline_status: 'New Opportunity',
      status_notes: '',
      is_bookmarked: 0,
      viewed: 0,
      created_at: '2026-05-01',
      updated_at: '2026-05-01'
    }
  ];

  it('renders helper asList correctly with text or array', () => {
    expect(asList('["apple", "banana"]')).toEqual(['apple', 'banana']);
    expect(asList(['orange'])).toEqual(['orange']);
    expect(asList('invalid json')).toEqual([]);
    expect(asList(null)).toEqual([]);
  });

  it('renders tender list in inbox with reference number and title', () => {
    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    expect(screen.getAllByText('Solarization of District Headquarters Hospitals').length).toBeGreaterThan(0);
    expect(screen.getByText('REF-101')).toBeInTheDocument();
    expect(screen.getAllByText(/Punjab PPRA/).length).toBeGreaterThan(0);
  });

  it('fires onSearchChange when typing in search input', async () => {
    const user = userEvent.setup();
    const handleSearchChange = vi.fn();

    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={handleSearchChange}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/Search/i);
    await user.type(input, 'Hospital');
    expect(handleSearchChange).toHaveBeenCalled();
  });

  it('moves tender to "Under Review" on Track this bid button click', async () => {
    const user = userEvent.setup();
    const handleStatusChange = vi.fn().mockResolvedValue(undefined);

    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    const trackBtn = screen.getByRole('button', { name: /Track this bid/i });
    await user.click(trackBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('tender-1', 'Under Review');
  });

  it('moves tender to "Passed" on Pass button click', async () => {
    const user = userEvent.setup();
    const handleStatusChange = vi.fn().mockResolvedValue(undefined);

    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    const passBtn = screen.getByRole('button', { name: /Pass/i });
    await user.click(passBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('tender-1', 'Passed');
  });

  it('renders empty state when there are no tenders in inbox', () => {
    render(
      <InboxScreen
        tenders={[]}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    expect(screen.getByText('Your Inbox is clear')).toBeInTheDocument();
  });

  it('interacts with Filters popover, switches domain, toggles flags, and changes sorting', async () => {
    const user = userEvent.setup();
    const handleSelectTrack = vi.fn();
    const handleToggleBookmarked = vi.fn();
    const handleToggleCorrigendum = vi.fn();

    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={handleSelectTrack}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={handleToggleBookmarked}
        corrigendumOnly={false}
        onToggleCorrigendum={handleToggleCorrigendum}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    // Open Filters popover
    const filterBtn = screen.getByRole('button', { name: /Filters/ });
    await user.click(filterBtn);

    // Select a domain
    const domainSelect = screen.getByLabelText(/Domain/i);
    await user.selectOptions(domainSelect, 'Solar & Clean Energy');
    expect(handleSelectTrack).toHaveBeenCalledWith('Solar & Clean Energy');

    // Toggle bookmarked checkbox
    const bookmarkCheck = screen.getByRole('checkbox', { name: /Bookmarked only/i });
    await user.click(bookmarkCheck);
    expect(handleToggleBookmarked).toHaveBeenCalledTimes(1);

    // Toggle amended checkbox
    const amendedCheck = screen.getByRole('checkbox', { name: /Amended only/i });
    await user.click(amendedCheck);
    expect(handleToggleCorrigendum).toHaveBeenCalledTimes(1);

    // Change sort
    const sortSelect = screen.getByLabelText(/Sort by/i);
    await user.selectOptions(sortSelect, 'score');
    await user.selectOptions(sortSelect, 'newest');
  });

  it('renders undated tenders section and empty state when filtering', () => {
    const undatedTenders: Tender[] = [
      {
        ...sampleTenders[0],
        id: 'undated-1',
        title: 'Undated Tender Opportunity',
        closing_date: null,
        // Recently published: undated tenders older than 60 days count as closed and are hidden
        publish_date: new Date().toISOString().slice(0, 10)
      }
    ];

    const { rerender } = render(
      <InboxScreen
        tenders={undatedTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    expect(screen.getAllByText('No deadline stated').length).toBeGreaterThanOrEqual(1);

    // Rerender with active search filter and no results
    rerender(
      <InboxScreen
        tenders={[]}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery="nonexistent"
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    expect(screen.getByText('Nothing matches these filters')).toBeInTheDocument();
  });

  it('handles notes editing and saving on blur in detail view', async () => {
    const user = userEvent.setup();
    const handleSaveNotes = vi.fn().mockResolvedValue(undefined);
    const handleToggleBookmark = vi.fn();
    const handleAckCorrigendum = vi.fn();

    const tenderWithExtra: Tender = {
      ...sampleTenders[0],
      is_bookmarked: 1,
      cached_dossiers: [{
        label: 'Tender RFP',
        localPath: 'rfp.pdf',
        originalUrl: 'http://example.com/rfp.pdf',
        mimeType: 'application/pdf',
        sha256: 'abc'
      }],
      secondary_sources: [{
        portalName: 'Federal PPRA',
        directUrl: 'http://ppra.gov.pk',
        discoveredAt: '2026-05-01'
      }]
    };

    const corrigenda = [{
      id: 'corr-1',
      tender_id: tenderWithExtra.id,
      change_type: 'deadline_extension' as const,
      previous_value: '2026-05-10',
      new_value: '2026-05-20',
      is_acknowledged: 0,
      detected_at: '2026-05-02'
    }];

    render(
      <InboxScreen
        tenders={[tenderWithExtra]}
        tracks={sampleTracks}
        corrigenda={corrigenda}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={handleAckCorrigendum}
        onSaveNotes={handleSaveNotes}
        onToggleBookmark={handleToggleBookmark}
      />
    );

    expect(screen.getByText('This tender was amended')).toBeInTheDocument();
    expect(screen.getByText('Tender RFP')).toBeInTheDocument();
    expect(screen.getByText('Federal PPRA')).toBeInTheDocument();

    // Acknowledge amendment
    const ackBtn = screen.getByRole('button', { name: 'Got it' });
    await user.click(ackBtn);
    expect(handleAckCorrigendum).toHaveBeenCalledWith('corr-1');

    // Toggle bookmark
    const starBtn = screen.getByRole('button', { name: 'Remove bookmark' });
    await user.click(starBtn);
    expect(handleToggleBookmark).toHaveBeenCalledTimes(1);

    // Edit notes and blur
    const notesArea = screen.getByPlaceholderText(/Bank guarantee, partner contacts/i);
    await user.type(notesArea, 'Urgent follow-up needed');
    notesArea.blur();
    expect(handleSaveNotes).toHaveBeenCalledWith(tenderWithExtra.id, 'Urgent follow-up needed');
  });

  it('handles note saving failure gracefully', async () => {
    const user = userEvent.setup();
    const handleSaveNotesReject = vi.fn().mockRejectedValue(new Error('Network error'));

    render(
      <InboxScreen
        tenders={[sampleTenders[0]]}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={handleSaveNotesReject}
        onToggleBookmark={vi.fn()}
      />
    );

    const notesArea = screen.getByPlaceholderText(/Bank guarantee, partner contacts/i);
    await user.type(notesArea, 'Note that fails to save');
    notesArea.blur();

    expect(handleSaveNotesReject).toHaveBeenCalled();
  });

  it('selects tender on row click and supports ArrowDown / ArrowUp keyboard navigation', async () => {
    const user = userEvent.setup();
    const twoTenders: Tender[] = [
      { ...sampleTenders[0], id: 'tender-row-1', title: 'First Tender Alpha' },
      { ...sampleTenders[0], id: 'tender-row-2', title: 'Second Tender Beta' }
    ];

    render(
      <InboxScreen
        tenders={twoTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    // Click second tender
    const secondRow = screen.getByText('Second Tender Beta');
    await user.click(secondRow);

    // Keyboard ArrowUp moves to first
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    // Keyboard ArrowDown moves to second
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    // Non-arrow key does nothing
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    // Target inside input ignored
    const searchInput = screen.getByPlaceholderText('Search tenders');
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });

  it('handles urgency sorting with past deadlines and single-item action clearing selection', async () => {
    const user = userEvent.setup();
    const handleStatusChange = vi.fn();
    const pastAndFutureTenders: Tender[] = [
      {
        ...sampleTenders[0],
        id: 't-past',
        title: 'Past Tender',
        closing_date: new Date(Date.now() - 3600000).toISOString()
      },
      {
        ...sampleTenders[0],
        id: 't-future',
        title: 'Future Tender',
        closing_date: new Date(Date.now() + 7200000).toISOString()
      }
    ];

    const { rerender } = render(
      <InboxScreen
        tenders={pastAndFutureTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={true}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={true}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    // Open Filters and switch sort to urgency
    const filtersBtn = screen.getByRole('button', { name: /Filters/i });
    await user.click(filtersBtn);
    const sortSelect = screen.getByRole('combobox', { name: 'Sort by' });
    await user.selectOptions(sortSelect, 'urgency');

    // Now test single-item action setting selectedId to null
    rerender(
      <InboxScreen
        tenders={[pastAndFutureTenders[0]]}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    // A closed tender is hidden even when it is the only one; the empty state offers to show it
    expect(screen.queryByText('Past Tender')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Show closed$/i }));

    const passBtn = screen.getByRole('button', { name: /Pass/i });
    await user.click(passBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('t-past', 'Passed');
  });

  it('supports AI extraction, inline detail editing, inline image/PDF preview, and manual tender creation', async () => {
    const user = userEvent.setup();
    const onTenderUpdated = vi.fn();
    const onTenderCreated = vi.fn();

    const tenderWithMedia: Tender = {
      ...sampleTenders[0],
      description: '',
      cached_dossiers: [
        {
          label: 'Notice Image',
          localPath: '/api/dossiers/tender-1/notice.png',
          originalUrl: 'manual://notice.png',
          mimeType: 'image/png',
          sha256: 'img123'
        },
        {
          label: 'Bidding Document PDF',
          localPath: '/api/dossiers/tender-1/bid.pdf',
          originalUrl: 'manual://bid.pdf',
          mimeType: 'application/pdf',
          sha256: 'pdf123'
        }
      ]
    };

    const fetchSpy = vi.spyOn(global, 'fetch')
      // 1. Refresh tender response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          message: 'Tender information refreshed from portal.',
          tender: { ...tenderWithMedia, description: '• Scope: Refreshed from portal' }
        })
      } as any)
      // 2. Extract with AI response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          message: 'Tender summary extracted with AI.',
          tender: { ...tenderWithMedia, description: '• Scope: 500kW Solar PV\n• Eligibility: PEC C3' }
        })
      } as any)
      // 3. Edit details PATCH response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          tender: { ...tenderWithMedia, title: 'Edited Solar Tender', description: '• Scope: Updated manually' }
        })
      } as any)
      // 4. Create manual tender POST response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          tender: { ...sampleTenders[0], id: 'manual-new-1', title: 'Manual Hospital Generator Tender' }
        })
      } as any);

    render(
      <InboxScreen
        tenders={[tenderWithMedia]}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onTenderUpdated={onTenderUpdated}
        onTenderCreated={onTenderCreated}
      />
    );

    // Honest fallback message when description is empty
    expect(screen.getByText(/No detailed scope was provided on the portal listing page/i)).toBeInTheDocument();

    // Inline image preview is rendered
    expect(screen.getByAltText('Notice Image')).toBeInTheDocument();

    // Toggle PDF preview
    const previewPdfBtn = screen.getByRole('button', { name: 'Preview PDF' });
    await user.click(previewPdfBtn);
    expect(screen.getByTitle('Bidding Document PDF')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide preview' }));

    // Click Refresh info
    const refreshBtn = screen.getByRole('button', { name: /Refresh info/i });
    await user.click(refreshBtn);
    expect(onTenderUpdated).toHaveBeenCalledWith(expect.objectContaining({ description: '• Scope: Refreshed from portal' }));

    // Trigger Extract with AI
    const aiBtn = screen.getByRole('button', { name: /Extract with AI/i });
    await user.click(aiBtn);
    expect(onTenderUpdated).toHaveBeenCalledTimes(2);

    // Open inline Edit details form and save
    const editBtn = screen.getByRole('button', { name: /Edit details/i });
    await user.click(editBtn);
    const saveEditBtn = screen.getByRole('button', { name: /Save changes/i });
    await user.click(saveEditBtn);
    expect(onTenderUpdated).toHaveBeenCalledTimes(3);

    // Open Add tender modal and create a manual tender
    const addTenderBtn = screen.getByRole('button', { name: /Add tender/i });
    await user.click(addTenderBtn);
    const titleInput = screen.getByPlaceholderText(/Procurement of Solar PV System/i);
    await user.type(titleInput, 'Manual Hospital Generator Tender');
    const createBtn = screen.getByRole('button', { name: /Create tender/i });
    await user.click(createBtn);
    expect(onTenderCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'manual-new-1' }));

    fetchSpy.mockRestore();
  });

  it('supports single-key triage shortcuts: t, p, b, o, and / to search', async () => {
    const handleStatusChange = vi.fn().mockResolvedValue(undefined);
    const handleToggleBookmark = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={handleToggleBookmark}
      />
    );

    // Press 'b' to toggle bookmark
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    expect(handleToggleBookmark).toHaveBeenCalledWith('tender-1');

    // Press 'o' to open direct_url
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o' }));
    expect(openSpy).toHaveBeenCalledWith('https://example.com/t1', '_blank', 'noopener,noreferrer');

    // Press 't' to track
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
    expect(handleStatusChange).toHaveBeenCalledWith('tender-1', 'Under Review');

    // Press '/' to focus search input
    const searchInput = screen.getByPlaceholderText(/Search tenders/i);
    const focusSpy = vi.spyOn(searchInput, 'focus');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
    expect(focusSpy).toHaveBeenCalled();

    openSpy.mockRestore();
  });

  it('renders Undo toast bar after Pass action and restores status on Undo click', async () => {
    const user = userEvent.setup();
    const handleStatusChange = vi.fn().mockResolvedValue(undefined);

    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    const passBtn = screen.getByRole('button', { name: /Pass/i });
    await user.click(passBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('tender-1', 'Passed');

    // Undo toast should appear
    const undoToast = screen.getByRole('status');
    expect(undoToast).toHaveTextContent(/Moved to Passed/i);

    const undoBtn = screen.getByRole('button', { name: /^Undo$/i });
    await user.click(undoBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('tender-1', 'New Opportunity');
  });

  it('renders Domain pill bar, active filter chips, Export CSV, and Copy summary', async () => {
    const user = userEvent.setup();
    const handleSelectTrack = vi.fn();
    const handleToggleBookmarked = vi.fn();
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="Solar & Clean Energy"
        onSelectTrack={handleSelectTrack}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={true}
        onToggleBookmarked={handleToggleBookmarked}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    // 1. Domain pill bar
    const allDomainsBtn = screen.getByRole('button', { name: 'All domains' });
    await user.click(allDomainsBtn);
    expect(handleSelectTrack).toHaveBeenCalledWith('All');

    // 2. Active filter chip
    const bookmarkedChip = screen.getByRole('button', { name: /Bookmarked/i });
    await user.click(bookmarkedChip);
    expect(handleToggleBookmarked).toHaveBeenCalled();

    // 3. Export CSV link
    const exportCsvLink = screen.getByTitle(/Export filtered Inbox tenders to CSV/i);
    expect(exportCsvLink).toHaveAttribute('href', expect.stringContaining('/api/export/csv?scope=inbox'));

    // 4. Copy summary
    const copySummaryBtn = screen.getByRole('button', { name: /Copy summary/i });
    await user.click(copySummaryBtn);
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('Solarization of District Headquarters Hospitals'));
    expect(screen.getByText('Copied!')).toBeInTheDocument();
  });

  it('renders Archive expired button when past tenders exist and sweeps them to Passed', async () => {
    const user = userEvent.setup();
    const handleStatusChange = vi.fn().mockResolvedValue(undefined);
    const expiredTender: Tender = {
      ...sampleTenders[0],
      id: 'tender-expired-1',
      title: 'Expired Tender',
      closing_date: new Date(Date.now() - 86400000).toISOString()
    };

    render(
      <InboxScreen
        tenders={[expiredTender]}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    // Hidden by default (Phase 0.2): revealed only on request
    expect(screen.getByText('Your Inbox is clear')).toBeInTheDocument();
    expect(screen.getByText(/1 closed tender\(s\) are hidden/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Show closed$/i }));

    const archiveBtn = screen.getByRole('button', { name: /Archive expired \(1\)/i });
    await user.click(archiveBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('tender-expired-1', 'Passed');
  });

  it('hides expired tenders alongside open ones and keeps bookmarked expired tenders visible', () => {
    const open: Tender = { ...sampleTenders[0], id: 't-open', title: 'Open Solar Tender' };
    const expired: Tender = { ...sampleTenders[0], id: 't-closed', title: 'Closed Solar Tender', closing_date: new Date(Date.now() - 3600000).toISOString() };
    const bookmarkedExpired: Tender = { ...expired, id: 't-closed-bm', title: 'Bookmarked Closed Tender', is_bookmarked: 1 };

    render(
      <InboxScreen
        tenders={[open, expired, bookmarkedExpired]}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
      />
    );

    expect(screen.getAllByText('Open Solar Tender').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Bookmarked Closed Tender').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Closed Solar Tender')).not.toBeInTheDocument();
    expect(screen.getByText(/closed tender\(s\) hidden/)).toBeInTheDocument();
  });

  it('removes the tender from the list when the server reports it auto-expired', async () => {
    const user = userEvent.setup();
    const onTenderDeleted = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, expired: true, id: 'tender-1', message: 'Deadline has passed: tender removed from the Inbox.' })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <InboxScreen
        tenders={sampleTenders}
        tracks={sampleTracks}
        corrigenda={[]}
        selectedTrack="All"
        onSelectTrack={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        bookmarkedOnly={false}
        onToggleBookmarked={vi.fn()}
        corrigendumOnly={false}
        onToggleCorrigendum={vi.fn()}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onTenderDeleted={onTenderDeleted}
      />
    );

    await user.click(screen.getAllByText('Solarization of District Headquarters Hospitals')[0]);
    await user.click(screen.getByRole('button', { name: /Fetch documents/i }));

    expect(fetchMock).toHaveBeenCalledWith('/api/tenders/tender-1/fetch-documents', { method: 'POST' });
    expect(onTenderDeleted).toHaveBeenCalledWith('tender-1');
    expect(screen.queryByText('Solarization of District Headquarters Hospitals')).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  describe('Phase 4: provenance badges, review and document retry', () => {
    const baseProps = {
      tracks: sampleTracks,
      corrigenda: [],
      selectedTrack: 'All',
      onSelectTrack: vi.fn(),
      searchQuery: '',
      onSearchChange: vi.fn(),
      bookmarkedOnly: false,
      onToggleBookmarked: vi.fn(),
      corrigendumOnly: false,
      onToggleCorrigendum: vi.fn(),
      onStatusChange: vi.fn(),
      onAcknowledgeCorrigendum: vi.fn(),
      onSaveNotes: vi.fn(),
      onToggleBookmark: vi.fn()
    };

    it('labels where each deadline came from', async () => {
      const { deadlineProvenance } = await import('../../src/client/components/InboxScreen.js');
      expect(deadlineProvenance({ closing_date: '2026-12-01T09:00:00Z', deadline_source: 'primary_doc', deadline_confidence: 'high' }).label).toBe('Document verified');
      expect(deadlineProvenance({ closing_date: '2026-12-01T09:00:00Z', deadline_source: 'corrigendum_doc', deadline_confidence: 'high' }).label).toBe('Verified from corrigendum');
      expect(deadlineProvenance({ closing_date: '2026-12-01T09:00:00Z', deadline_source: 'primary_doc', deadline_confidence: 'medium' }).tone).toBe('warn');
      expect(deadlineProvenance({ closing_date: '2026-12-01T09:00:00Z', deadline_source: 'html_row', deadline_confidence: null }).label).toBe('Portal listing');
      expect(deadlineProvenance({ closing_date: null, deadline_source: null, deadline_confidence: null }).label).toBe('No deadline · Portal HTML only');
    });

    it('turns review reasons into sentences', async () => {
      const { humanReviewReason } = await import('../../src/client/components/InboxScreen.js');
      expect(humanReviewReason('deadline_moved_earlier: 15 Dec 2026 → 05 Dec 2026')).toBe('A corrigendum moved the deadline earlier (15 Dec 2026 → 05 Dec 2026).');
      expect(humanReviewReason('corrigendum_cancelled: x')).toMatch(/cancelled or withdrawn/);
      expect(humanReviewReason(null)).toBe('Please check this tender.');
    });

    it('shows the provenance badge and "No deadline stated" in the detail pane', async () => {
      const user = userEvent.setup();
      const undated: Tender = { ...sampleTenders[0], closing_date: null, closing_date_formatted: 'Not Available', publish_date: new Date().toISOString().slice(0, 10) };
      render(<InboxScreen {...baseProps} tenders={[undated]} />);
      await user.click(screen.getAllByText(undated.title)[0]);
      expect(screen.getAllByText('No deadline stated').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId('deadline-provenance')).toHaveTextContent('No deadline · Portal HTML only');
    });

    it('flagged tenders come first, stay visible even when past, and can be confirmed', async () => {
      const user = userEvent.setup();
      const open: Tender = { ...sampleTenders[0], id: 't-open', title: 'Open Solar Tender' };
      const flagged: Tender = {
        ...sampleTenders[0],
        id: 't-flag',
        title: 'Flagged Solar Tender',
        closing_date: new Date(Date.now() - 3600000).toISOString(),
        needs_review: 1,
        review_reason: 'deadline_moved_earlier: 15 Dec 2026 → 05 Nov 2026',
        deadline_source: 'corrigendum_doc',
        deadline_confidence: 'high'
      };
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, tender: { ...flagged, needs_review: 0, review_reason: null } }) });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<InboxScreen {...baseProps} tenders={[open, flagged]} />);
      const rows = Array.from(container.querySelectorAll('[data-tender-id]')).map(el => el.getAttribute('data-tender-id'));
      expect(rows[0]).toBe('t-flag');
      expect(screen.getAllByText('Review').length).toBeGreaterThanOrEqual(1);

      await user.click(screen.getAllByText('Flagged Solar Tender')[0]);
      expect(screen.getByRole('alert')).toHaveTextContent('A corrigendum moved the deadline earlier');
      await user.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(fetchMock).toHaveBeenCalledWith('/api/tenders/t-flag/review', expect.objectContaining({ method: 'PATCH' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      vi.unstubAllGlobals();
    });

    it('shows background fetching and a retry action for failed documents', async () => {
      const user = userEvent.setup();
      const failed: Tender = { ...sampleTenders[0], doc_fetch_status: 'failed' };
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, requeued: 1, tender: { ...failed, doc_fetch_status: 'pending' }, message: 'Retrying 1 document(s) in the background.' }) });
      vi.stubGlobal('fetch', fetchMock);

      render(<InboxScreen {...baseProps} tenders={[failed]} />);
      await user.click(screen.getAllByText(failed.title)[0]);
      await user.click(screen.getByRole('button', { name: /Retry document fetch/i }));
      expect(fetchMock).toHaveBeenCalledWith('/api/tenders/tender-1/retry-documents', { method: 'POST' });
      expect(screen.getByText(/Fetching documents in the background/)).toBeInTheDocument();
      vi.unstubAllGlobals();
    });

    it('Plan A & B: filters Inbox by Closing <=48h toggle and renders collapsible Go / No-Go Bid Brief', async () => {
      const user = userEvent.setup();
      const urgentTender: Tender = {
        ...sampleTenders[0],
        id: 't-urg-ui',
        title: 'Urgent School Solar Tender',
        closing_date: new Date(Date.now() + 18 * 3600000).toISOString(),
        bid_brief: {
          bidSecurityAmount: '2% CDR',
          tenderFee: 'PKR 3,000',
          requiredRegistrations: ['PEC C5', 'NTN'],
          requiredExperience: '3 years school solarization',
          deliverablesSummary: ['10kW rooftop PV', '2-year warranty'],
          bidMethod: 'Single Stage – Two Envelope'
        }
      };
      const laterTender: Tender = {
        ...sampleTenders[0],
        id: 't-later-ui',
        title: 'Later Textbook Printing Tender',
        closing_date: new Date(Date.now() + 14 * 86400000).toISOString(),
        bid_brief: null
      };

      const { container } = render(<InboxScreen {...baseProps} tenders={[urgentTender, laterTender]} />);

      // Closing <=48h toggle filters list to urgent item only
      const urgentBtn = screen.getByRole('button', { name: /Closing (?:≤|<=)48h/i });
      expect(urgentBtn).toHaveTextContent('(1)');
      await user.click(urgentBtn);

      const visibleIds = Array.from(container.querySelectorAll('[data-tender-id]')).map(el => el.getAttribute('data-tender-id'));
      expect(visibleIds).toEqual(['t-urg-ui']);

      // Go / No-Go Bid Brief card renders structured qualification fields
      await user.click(screen.getAllByText('Urgent School Solar Tender')[0]);
      expect(screen.getByText(/Go \/ No-Go Bid Brief/i)).toBeInTheDocument();
      expect(screen.getByText('2% CDR')).toBeInTheDocument();
      expect(screen.getByText('PEC C5')).toBeInTheDocument();
      expect(screen.getByText(/10kW rooftop PV/)).toBeInTheDocument();
    });
  });
});