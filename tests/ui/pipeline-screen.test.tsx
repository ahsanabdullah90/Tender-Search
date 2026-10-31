import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PipelineScreen } from '../../src/components/PipelineScreen.js';
import type { Tender } from '../../src/types.js';

describe('PipelineScreen component', () => {
  const samplePipelineTenders: Tender[] = [
    {
      id: 'tender-p1',
      canonical_id: 'tender-p1',
      portal_id: 'epads',
      portal_name: 'Federal PPRA',
      reference_no: 'REF-P1',
      title: 'National Data Center Storage Array Expansion',
      organization: 'National Information Technology Board',
      description: 'Supply of enterprise SAN storage',
      estimated_value: 'PKR 120,000,000',
      location: 'Islamabad',
      publish_date: '2026-05-01',
      closing_date: '2026-07-20T14:00:00+05:00',
      closing_date_formatted: '20-07-2026',
      direct_url: 'https://example.com/p1',
      secondary_sources: [],
      domain_tracks: ['Software & IT Services'],
      matched_keywords: ['storage'],
      match_score: 90,
      cached_dossiers: [],
      has_corrigendum: 0,
      pipeline_status: 'Preparing Bid',
      status_notes: 'Drafting compliance sheet',
      is_bookmarked: 1,
      viewed: 1,
      created_at: '2026-05-01',
      updated_at: '2026-05-01'
    },
    {
      id: 'tender-won',
      canonical_id: 'tender-won',
      portal_id: 'punjab_eproc',
      portal_name: 'Punjab PPRA',
      reference_no: 'REF-WON-1',
      title: 'School IT Lab Setup',
      organization: 'Punjab Education Department',
      description: 'Supply of 50 PCs',
      estimated_value: 'PKR 15,000,000',
      location: 'Lahore',
      publish_date: '2026-04-01',
      closing_date: '2026-05-01T14:00:00+05:00',
      closing_date_formatted: '01-05-2026',
      direct_url: 'https://example.com/won',
      secondary_sources: [],
      domain_tracks: ['Education & Learning'],
      matched_keywords: ['pcs'],
      match_score: 85,
      cached_dossiers: [],
      has_corrigendum: 0,
      pipeline_status: 'Won',
      status_notes: 'PO received',
      is_bookmarked: 0,
      viewed: 1,
      created_at: '2026-04-01',
      updated_at: '2026-05-02'
    }
  ];

  it('renders pipeline stage columns', () => {
    render(
      <PipelineScreen
        tenders={samplePipelineTenders}
        corrigenda={[]}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onSetResultDate={vi.fn()}
      />
    );

    expect(screen.getByText('Reviewing')).toBeInTheDocument();
    expect(screen.getByText('Preparing bid')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Won' })).toBeInTheDocument();

    expect(screen.getByText('National Data Center Storage Array Expansion')).toBeInTheDocument();
    expect(screen.getByText('School IT Lab Setup')).toBeInTheDocument();
  });

  it('switches between Board and Gantt views', async () => {
    const user = userEvent.setup();

    render(
      <PipelineScreen
        tenders={samplePipelineTenders}
        corrigenda={[]}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onSetResultDate={vi.fn()}
      />
    );

    const ganttTab = screen.getByRole('tab', { name: /Gantt/ });
    await user.click(ganttTab);
    expect(ganttTab).toHaveAttribute('aria-selected', 'true');
  });

  it('opens tender detail slideover when tender card is clicked', async () => {
    const user = userEvent.setup();

    render(
      <PipelineScreen
        tenders={samplePipelineTenders}
        corrigenda={[]}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onSetResultDate={vi.fn()}
      />
    );

    const card = screen.getByText('National Data Center Storage Array Expansion');
    await user.click(card);

    expect(screen.getByRole('dialog', { name: 'National Data Center Storage Array Expansion' })).toBeInTheDocument();
    expect(screen.getByText('Drafting compliance sheet')).toBeInTheDocument();
  });

  it('renders empty state when pipeline has no active tenders', () => {
    render(
      <PipelineScreen
        tenders={[]}
        corrigenda={[]}
        onStatusChange={vi.fn()}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onSetResultDate={vi.fn()}
      />
    );

    expect(screen.getByText('No tenders in your pipeline')).toBeInTheDocument();
  });
});
