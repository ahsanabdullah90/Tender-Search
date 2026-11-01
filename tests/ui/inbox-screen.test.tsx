import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InboxScreen, asList } from '../../src/components/InboxScreen.js';
import type { Tender, DomainTrack } from '../../src/types.js';

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
      closing_date: '2026-08-30T14:00:00+05:00',
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
        closing_date: null
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
      // 1. Extract with AI response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          message: 'Tender summary extracted with AI.',
          tender: { ...tenderWithMedia, description: '• Scope: 500kW Solar PV\n• Eligibility: PEC C3' }
        })
      } as any)
      // 2. Edit details PATCH response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          tender: { ...tenderWithMedia, title: 'Edited Solar Tender', description: '• Scope: Updated manually' }
        })
      } as any)
      // 3. Create manual tender POST response
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

    // Trigger Extract with AI
    const aiBtn = screen.getByRole('button', { name: /Extract with AI/i });
    await user.click(aiBtn);
    expect(onTenderUpdated).toHaveBeenCalled();

    // Open inline Edit details form and save
    const editBtn = screen.getByRole('button', { name: /Edit details/i });
    await user.click(editBtn);
    const saveEditBtn = screen.getByRole('button', { name: /Save changes/i });
    await user.click(saveEditBtn);
    expect(onTenderUpdated).toHaveBeenCalledTimes(2);

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
});
