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
      id: 'tender-p2-undated',
      canonical_id: 'tender-p2-undated',
      portal_id: 'epads',
      portal_name: 'Federal PPRA',
      reference_no: 'REF-P2',
      title: 'Undated Infrastructure Upgrade',
      organization: 'Gov Department',
      description: 'Consultancy',
      estimated_value: null,
      location: null,
      publish_date: '2026-05-01',
      closing_date: null,
      closing_date_formatted: 'Not Available',
      direct_url: 'https://example.com/p2',
      secondary_sources: [],
      domain_tracks: ['Software & IT Services'],
      matched_keywords: ['it'],
      match_score: 80,
      cached_dossiers: [],
      has_corrigendum: 0,
      pipeline_status: 'Preparing Bid',
      status_notes: '',
      is_bookmarked: 0,
      viewed: 1,
      created_at: '2026-05-01',
      updated_at: '2026-05-01'
    },
    {
      id: 'tender-p3-current',
      canonical_id: 'tender-p3-current',
      portal_id: 'epads',
      portal_name: 'Federal PPRA',
      reference_no: 'REF-P3',
      title: 'Current Week Deadline Tender',
      organization: 'Gov Department',
      description: 'Hardware',
      estimated_value: null,
      location: null,
      publish_date: '2026-05-01',
      closing_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      closing_date_formatted: 'In 2 days',
      result_expected_date: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      direct_url: 'https://example.com/p3',
      secondary_sources: [],
      domain_tracks: ['Software & IT Services'],
      matched_keywords: ['it'],
      match_score: 80,
      cached_dossiers: [],
      has_corrigendum: 0,
      pipeline_status: 'Under Review',
      status_notes: '',
      is_bookmarked: 0,
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
    },
    {
      id: 'tender-p2',
      canonical_id: 'tender-p2',
      portal_id: 'epads',
      portal_name: 'Federal PPRA',
      reference_no: 'REF-P2',
      title: 'Secondary Data Center Rack Installation',
      organization: 'NITB',
      description: 'Rack mounting',
      estimated_value: 'PKR 10,000,000',
      location: 'Islamabad',
      publish_date: '2026-05-02',
      closing_date: '2026-08-10T14:00:00+05:00',
      closing_date_formatted: '10-08-2026',
      direct_url: 'https://example.com/p2',
      secondary_sources: [],
      domain_tracks: ['Software & IT Services'],
      matched_keywords: ['rack'],
      match_score: 75,
      cached_dossiers: [],
      has_corrigendum: 0,
      pipeline_status: 'Preparing Bid',
      status_notes: 'Initial check',
      is_bookmarked: 0,
      viewed: 0,
      created_at: '2026-05-02',
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

  it('handles stage transitions and passing bid from slideover', async () => {
    const user = userEvent.setup();
    const handleStatusChange = vi.fn().mockResolvedValue(undefined);

    render(
      <PipelineScreen
        tenders={samplePipelineTenders}
        corrigenda={[]}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onSetResultDate={vi.fn()}
        focusId="tender-p1"
      />
    );

    // Detail slideover should already be open via focusId
    expect(screen.getByRole('dialog', { name: 'National Data Center Storage Array Expansion' })).toBeInTheDocument();

    // Click "Submitted" stage button
    const submittedBtn = screen.getByRole('button', { name: 'Submitted' });
    await user.click(submittedBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('tender-p1', 'Submitted');

    // Click "Pass" button
    const passBtn = screen.getByRole('button', { name: 'Pass' });
    await user.click(passBtn);
    // Confirm pass in modal
    const confirmBtn = screen.getByRole('button', { name: /Pass & Remove Files/i });
    await user.click(confirmBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('tender-p1', 'Passed');
  });

  it('toggles archived view, shows empty state, and reopens passed tender', async () => {
    const user = userEvent.setup();
    const handleStatusChange = vi.fn().mockResolvedValue(undefined);

    const tendersWithPassed: Tender[] = [
      ...samplePipelineTenders,
      {
        ...samplePipelineTenders[0],
        id: 'passed-1',
        title: 'Archived IT Tender',
        pipeline_status: 'Passed'
      }
    ];

    const { rerender } = render(
      <PipelineScreen
        tenders={tendersWithPassed}
        corrigenda={[]}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onSetResultDate={vi.fn()}
      />
    );

    // Open archive drawer
    const archiveBtn = screen.getByRole('button', { name: /Passed and archived/ });
    await user.click(archiveBtn);

    expect(screen.getByText('Archived IT Tender')).toBeInTheDocument();

    // Click Reopen button
    const reopenBtn = screen.getByRole('button', { name: 'Reopen' });
    await user.click(reopenBtn);
    expect(handleStatusChange).toHaveBeenCalledWith('passed-1', 'New Opportunity');

    // Rerender with 0 passed tenders
    rerender(
      <PipelineScreen
        tenders={samplePipelineTenders}
        corrigenda={[]}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={vi.fn()}
        onSaveNotes={vi.fn()}
        onToggleBookmark={vi.fn()}
        onSetResultDate={vi.fn()}
      />
    );

    expect(screen.getByText('Nothing archived')).toBeInTheDocument();
  });

  it('renders Gantt timeline with dated and undated tenders and empty state', async () => {
    const user = userEvent.setup();

    const mixedTenders: Tender[] = [
      {
        ...samplePipelineTenders[0],
        result_expected_date: '2026-08-15'
      },
      {
        ...samplePipelineTenders[1],
        id: 'undated-gantt',
        title: 'Undated Gantt Opportunity',
        pipeline_status: 'Under Review',
        closing_date: null
      }
    ];

    const { rerender } = render(
      <PipelineScreen
        tenders={mixedTenders}
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

    expect(screen.getByText('Undated Gantt Opportunity')).toBeInTheDocument();
    expect(screen.getByText('No deadline stated')).toBeInTheDocument();

    // Empty active tenders in Gantt view
    rerender(
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

    expect(screen.getByText('Nothing to chart yet')).toBeInTheDocument();
  });

  it('opens slideover from Gantt row and interacts with slideover detail controls', async () => {
    const user = userEvent.setup();
    const handleSetResultDate = vi.fn();
    const handleSaveNotes = vi.fn();
    const handleToggleBookmark = vi.fn();
    const handleAck = vi.fn();
    const handleStatusChange = vi.fn();

    const corrLog = {
      id: 'corr-slide-1',
      tender_id: 'tender-p1',
      tender_title: 'National Data Center Storage Array Expansion',
      portal_name: 'Federal PPRA',
      organization: 'NITB',
      change_type: 'deadline_extension' as const,
      previous_value: '2026-06-01',
      new_value: '2026-07-20',
      detected_at: '2026-05-10',
      is_acknowledged: 0
    };

    render(
      <PipelineScreen
        tenders={[samplePipelineTenders[0]]}
        corrigenda={[corrLog]}
        onStatusChange={handleStatusChange}
        onAcknowledgeCorrigendum={handleAck}
        onSaveNotes={handleSaveNotes}
        onToggleBookmark={handleToggleBookmark}
        onSetResultDate={handleSetResultDate}
      />
    );

    // Switch to Gantt
    const ganttTab = screen.getByRole('tab', { name: /Gantt/ });
    await user.click(ganttTab);

    // Click on tender button in Gantt row to open slideover
    const rowBtn = screen.getByText('National Data Center Storage Array Expansion');
    await user.click(rowBtn);

    // In slideover, test Result expected date input
    const dateInput = screen.getByLabelText(/Result expected/i);
    await user.clear(dateInput);
    await user.type(dateInput, '2026-09-01');
    expect(handleSetResultDate).toHaveBeenCalled();

    // Test acknowledge corrigendum
    const gotItBtn = screen.getByRole('button', { name: 'Got it' });
    await user.click(gotItBtn);
    expect(handleAck).toHaveBeenCalledWith('corr-slide-1');

    // Test toggle bookmark
    const bookmarkBtn = screen.getByRole('button', { name: 'Remove bookmark' });
    await user.click(bookmarkBtn);
    expect(handleToggleBookmark).toHaveBeenCalledTimes(1);

    // Test save notes
    const notesInput = screen.getByPlaceholderText(/Bank guarantee/i);
    await user.type(notesInput, ' updated');
    notesInput.blur();
    expect(handleSaveNotes).toHaveBeenCalled();

    // Close slideover
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    await user.click(closeBtn);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
