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
});
