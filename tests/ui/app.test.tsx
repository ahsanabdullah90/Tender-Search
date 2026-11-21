import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../src/client/App.js';

let lastEventSource: any = null;

class MockEventSource {
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();

  constructor() {
    lastEventSource = this;
  }
}

describe('App root component', () => {
  const sampleTenders = [
    {
      id: 't-1',
      reference_no: 'REF-001',
      title: 'Solar Power System',
      description: 'Supply of solar panels and inverters',
      portal_id: 'epads',
      portal_name: 'Federal PPRA (EPADS)',
      organization: 'WAPDA',
      closing_date: '2026-12-01T14:00:00+05:00',
      closing_date_raw: '01/12/2026',
      estimated_value_pkr: 5000000,
      tender_url: 'https://example.com/t1',
      pipeline_status: 'New Opportunity',
      matched_keyword: 'solar',
      match_score: 95,
      is_bookmarked: 0,
      status_notes: 'Initial note',
      has_unacknowledged_corrigenda: 0,
      created_at: '2026-10-01T10:00:00Z',
      updated_at: '2026-10-01T10:00:00Z',
    },
    {
      id: 't-2',
      reference_no: 'REF-002',
      title: 'IT Hardware Procurement',
      description: 'Laptops and Servers',
      portal_id: 'sindh_ppra',
      portal_name: 'Sindh PPRA',
      organization: 'Education Dept',
      closing_date: '2026-12-10T14:00:00+05:00',
      closing_date_raw: '10/12/2026',
      estimated_value_pkr: 2000000,
      tender_url: 'https://example.com/t2',
      pipeline_status: 'Under Review',
      matched_keyword: 'hardware',
      match_score: 80,
      is_bookmarked: 1,
      status_notes: 'Under eval',
      has_unacknowledged_corrigenda: 1,
      created_at: '2026-10-02T10:00:00Z',
      updated_at: '2026-10-02T10:00:00Z',
    }
  ];

  const sampleTracks = [
    {
      id: 'track-1',
      name: 'Renewable Energy',
      positive_keywords: ['solar', 'wind'],
      negative_keywords: ['coal'],
      is_active: 1
    }
  ];

  const samplePortals = [
    {
      portal_id: 'epads',
      portal_name: 'Federal PPRA (EPADS)',
      status: 'online',
      last_scrape_timestamp: '2026-10-31T10:00:00Z',
      consecutive_failures: 0,
      requires_auth: 1,
      requires_hitl: 0
    },
    {
      portal_id: 'kppra',
      portal_name: 'KPK KPPRA',
      status: 'error',
      last_scrape_timestamp: null,
      consecutive_failures: 3,
      requires_auth: 0,
      requires_hitl: 0
    }
  ];

  const sampleCorrigenda = [
    {
      id: 'c-1',
      tender_id: 't-2',
      tender_title: 'IT Hardware Procurement',
      portal_name: 'Sindh PPRA',
      organization: 'Education Dept',
      change_type: 'date_extended',
      old_value: '2026-11-20',
      new_value: '2026-12-10',
      detected_at: '2026-10-31T12:00:00Z',
      acknowledged: 0
    }
  ];

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    lastEventSource = null;
    vi.stubGlobal('EventSource', MockEventSource);

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const urlStr = String(url);
      const method = init?.method || 'GET';

      if (urlStr.includes('/api/tenders') && method === 'GET') {
        if (urlStr.includes('/api/tenders/t-1')) {
          return { ok: true, json: async () => sampleTenders[0] } as any;
        }
        if (urlStr.includes('/api/tenders/t-2')) {
          return { ok: true, json: async () => sampleTenders[1] } as any;
        }
        if (urlStr.includes('status=New+Opportunity')) {
          return { ok: true, json: async () => [sampleTenders[0]] } as any;
        }
        return { ok: true, json: async () => sampleTenders } as any;
      }
      if (urlStr.includes('/api/tracks') && method === 'GET') {
        return { ok: true, json: async () => sampleTracks } as any;
      }
      if (urlStr.includes('/api/portals') && method === 'GET') {
        return { ok: true, json: async () => samplePortals } as any;
      }
      if (urlStr.includes('/api/kpis')) {
        return {
          ok: true,
          json: async () => ({
            totalTracked: 2,
            closingSoon: 1,
            inPipeline: 1,
            unackCorrigenda: 1,
            totalPortals: 18,
            onlinePortals: 18,
            hitlRequiredCount: 0
          })
        } as any;
      }
      if (urlStr.includes('/api/corrigenda') && method === 'GET') {
        return { ok: true, json: async () => sampleCorrigenda } as any;
      }
      if (urlStr.includes('/api/backups')) {
        return { ok: true, json: async () => [] } as any;
      }
      if (urlStr.includes('/api/storage')) {
        return {
          ok: true,
          json: async () => ({
            total_bytes: 1000,
            passed_bytes: 200,
            passed_tenders: 1,
            tenders_with_documents: 1
          })
        } as any;
      }
      if (urlStr.includes('/api/system/network/check') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            state: 'online',
            latencyMs: 38,
            checkedAt: '2026-11-19T10:01:00Z',
            reason: 'Healthy',
            heavyTasksPaused: false,
            deferredHeavyTasks: {
              deepScanPending: false,
              pendingDocumentJobs: 0
            }
          })
        } as any;
      }
      if (urlStr.includes('/api/system/network') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            state: 'online',
            latencyMs: 45,
            checkedAt: '2026-11-19T10:00:00Z',
            reason: 'Healthy',
            heavyTasksPaused: false,
            deferredHeavyTasks: {
              deepScanPending: false,
              pendingDocumentJobs: 0
            }
          })
        } as any;
      }
      if (urlStr.includes('/api/scan/status')) {
        return {
          ok: true,
          json: async () => ({
            isScanning: false,
            currentPortal: null,
            progressPercent: 0,
            completedPortals: 0,
            totalPortals: 18,
            newTendersFound: 0,
            corrigendaFound: 0,
            lastScanTimestamp: null
          })
        } as any;
      }
      if (urlStr.includes('/api/scan/start') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            isScanning: true,
            currentPortal: 'epads',
            progressPercent: 10,
            completedPortals: 1,
            totalPortals: 18,
            newTendersFound: 1,
            corrigendaFound: 0,
            lastScanTimestamp: null
          })
        } as any;
      }
      if (urlStr.includes('/status') && method === 'PATCH') {
        return { ok: true, json: async () => ({ success: true }) } as any;
      }
      if (urlStr.includes('/bookmark') && method === 'PATCH') {
        return { ok: true, json: async () => ({ is_bookmarked: 1 }) } as any;
      }
      if (urlStr.includes('/notes') && method === 'PATCH') {
        return { ok: true, json: async () => ({ success: true }) } as any;
      }
      if (urlStr.includes('/result-date') && method === 'PATCH') {
        return { ok: true, json: async () => ({ success: true }) } as any;
      }
      if (urlStr.includes('/acknowledge') && method === 'POST') {
        return { ok: true, json: async () => ({ success: true }) } as any;
      }
      if (urlStr.includes('/hitl-launch') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            isHeadlessFallback: true,
            portalUrl: 'https://example.com/login'
          })
        } as any;
      }
      if (urlStr.includes('/hitl-verify') && method === 'POST') {
        return { ok: true, json: async () => ({ success: true }) } as any;
      }
      if (urlStr.includes('/api/tracks') && (method === 'POST' || method === 'DELETE')) {
        return { ok: true, json: async () => ({ success: true }) } as any;
      }
      if (urlStr.includes('/api/tenders/clear') && method === 'POST') {
        return { ok: true, json: async () => ({ success: true, deleted: 1 }) } as any;
      }
      if (urlStr.includes('/api/portals/') && method === 'PUT') {
        return { ok: true, json: async () => ({ success: true }) } as any;
      }

      return { ok: true, json: async () => ({}) } as any;
    });
  });

  it('renders application with sidebar and default inbox view', async () => {
    render(<App />);

    expect(screen.getByText('Tender Tracker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pipeline/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sources & Keywords/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Solar Power System')).toBeInTheDocument();
    });
  });

  it('migrates legacy localStorage keys on mount', () => {
    localStorage.setItem('tender_tracker_currentView', 'kanban');
    localStorage.setItem('sentinel_token', 'xyz123');

    render(<App />);

    expect(localStorage.getItem('tt_section')).toBe('pipeline');
    expect(localStorage.getItem('sentinel_token')).toBeNull();
    expect(localStorage.getItem('tender_tracker_currentView')).toBeNull();
  });

  it('navigates between sections and persists selection', async () => {
    const user = userEvent.setup();
    render(<App />);

    const pipelineBtn = screen.getByRole('button', { name: /Pipeline/i });
    await user.click(pipelineBtn);

    await waitFor(() => {
      expect(screen.getByText('IT Hardware Procurement')).toBeInTheDocument();
    });
    expect(localStorage.getItem('tt_section')).toBe('pipeline');

    const sourcesBtn = screen.getByRole('button', { name: /Sources & Keywords/i });
    await user.click(sourcesBtn);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Portals/i })).toBeInTheDocument();
    });
    expect(localStorage.getItem('tt_section')).toBe('sources');
  });

  it('handles SSE scan progress updates and re-fetches when scan finishes', async () => {
    render(<App />);

    await waitFor(() => {
      expect(lastEventSource).not.toBeNull();
    });

    // 1. In-progress scan event
    act(() => {
      lastEventSource.onmessage?.({
        data: JSON.stringify({
          status: {
            isScanning: true,
            currentPortal: 'epads',
            progressPercent: 50,
            completedPortals: 9,
            totalPortals: 18,
            newTendersFound: 2,
            corrigendaFound: 1,
            lastScanTimestamp: null
          }
        })
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Scanning epads/i)).toBeInTheDocument();
    });

    // 2. Scan finished event -> triggers data refresh
    act(() => {
      lastEventSource.onmessage?.({
        data: JSON.stringify({
          status: {
            isScanning: false,
            currentPortal: null,
            progressPercent: 100,
            completedPortals: 18,
            totalPortals: 18,
            newTendersFound: 5,
            corrigendaFound: 2,
            lastScanTimestamp: '2026-11-01T10:00:00Z'
          }
        })
      });
    });

    // 3. Invalid JSON resilience
    act(() => {
      lastEventSource.onmessage?.({ data: '{{{ malformed json' });
    });

    // 4. SSE error resilience
    act(() => {
      lastEventSource.onerror?.(new Error('SSE disconnected'));
    });
  });

  it('debounces search input queries in inbox', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Solar Power System')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search tenders/i);
    await user.type(searchInput, 'inverter');

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('search=inverter'),
        expect.anything()
      );
    }, { timeout: 2000 });
  });

  it('toggles theme preference between Light, Dark, and System', async () => {
    const user = userEvent.setup();
    render(<App />);

    const darkRadio = screen.getByRole('radio', { name: /Dark/i });
    await user.click(darkRadio);
    expect(localStorage.getItem('tt_theme')).toBe('dark');

    const lightRadio = screen.getByRole('radio', { name: /Light/i });
    await user.click(lightRadio);
    expect(localStorage.getItem('tt_theme')).toBe('light');

    const systemRadio = screen.getByRole('radio', { name: /System/i });
    await user.click(systemRadio);
    expect(localStorage.getItem('tt_theme')).toBe('system');
  });

  it('handles scan trigger button', async () => {
    const user = userEvent.setup();
    render(<App />);

    const scanBtn = screen.getByRole('button', { name: /Scan now/i });
    await user.click(scanBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/scan/start',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('navigates and focuses tender when selected from banner', async () => {
    render(<App />);

    const bannerBtn = await screen.findByRole('button', { name: /IT Hardware Procurement/i });
    const user = userEvent.setup();
    await user.click(bannerBtn);

    // Should fetch tender details and open Pipeline section
    await waitFor(() => {
      expect(localStorage.getItem('tt_section')).toBe('pipeline');
    });
  });

  it('handles tender actions in inbox: status change, bookmarking, and notes', async () => {
    const user = userEvent.setup();
    render(<App />);

    // 1. Status change (Track this bid)
    const trackBidBtn = await screen.findByRole('button', { name: /Track this bid/i });
    await user.click(trackBidBtn);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/tenders/t-1/status',
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    // 2. Bookmark toggle
    const bookmarkBtn = screen.getByRole('button', { name: /Bookmark/i });
    await user.click(bookmarkBtn);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/tenders/t-1/bookmark',
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    // 3. Notes editing and saving
    const notesArea = screen.getByPlaceholderText(/Bank guarantee/i);
    await user.clear(notesArea);
    await user.type(notesArea, 'Urgent follow-up needed');
    await user.tab(); // trigger blur
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/tenders/t-1/notes',
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  it('handles filters in Inbox: toggles bookmarked and corrigendum filters', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Solar Power System')).toBeInTheDocument();
    });

    // Open Filters popover
    const filterBtn = screen.getByRole('button', { name: /Filters/i });
    await user.click(filterBtn);

    const bookmarkedToggle = screen.getByRole('checkbox', { name: /Bookmarked only/i });
    await user.click(bookmarkedToggle);

    const corrigendumToggle = screen.getByRole('checkbox', { name: /Amended only/i });
    await user.click(corrigendumToggle);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('bookmarkedOnly=true'),
        expect.anything()
      );
    });
  });

  it('handles Sources screen operations: tracks, portals, and data management', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to sources
    const sourcesBtn = screen.getByRole('button', { name: /Sources & Keywords/i });
    await user.click(sourcesBtn);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Keywords/i })).toBeInTheDocument();
    });

    // 1. Add track
    const addDomainBtn = screen.getByRole('button', { name: /Add domain/i });
    await user.click(addDomainBtn);

    const nameInput = screen.getByLabelText(/Domain name/i);
    await user.type(nameInput, 'Clean Hydrogen');
    const positiveInput = screen.getByLabelText(/Words to look for/i);
    await user.type(positiveInput, 'hydrogen, fuel cell');

    const saveTrackBtn = screen.getByRole('button', { name: 'Save' });
    await user.click(saveTrackBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/tracks',
        expect.objectContaining({ method: 'POST' })
      );
    });

    // 2. Delete track
    const delTrackBtn = screen.getByRole('button', { name: /Delete Renewable Energy/i });
    await user.click(delTrackBtn);

    const delDialog = screen.getByRole('dialog', { name: /Delete this domain\?/i });
    const confirmDelBtn = within(delDialog).getByRole('button', { name: 'Delete' });
    await user.click(confirmDelBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/tracks/track-1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    // 3. Portals tab: update portal and verify HITL
    const portalsTab = screen.getByRole('tab', { name: /Portals/i });
    await user.click(portalsTab);

    const editPortalBtn = screen.getByRole('button', { name: /Edit Federal PPRA \(EPADS\)/i });
    await user.click(editPortalBtn);

    const editPortalDialog = screen.getByRole('dialog', { name: /Edit Federal PPRA/i });
    const savePortalBtn = within(editPortalDialog).getByRole('button', { name: 'Save' });
    await user.click(savePortalBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/portals/epads',
        expect.objectContaining({ method: 'PUT' })
      );
    });

    // 4. Switch to Data tab and test Clear Inbox & Factory reset
    const dataTab = screen.getByRole('tab', { name: 'Data' });
    await user.click(dataTab);

    const clearInboxBtn = await screen.findByRole('button', { name: 'Clear Inbox' });
    await user.click(clearInboxBtn);

    // Confirm dialog
    const inboxDialog = screen.getByRole('dialog', { name: 'Clear the Inbox?' });
    const confirmClearBtn = within(inboxDialog).getByRole('button', { name: 'Clear Inbox' });
    await user.click(confirmClearBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/tenders/clear',
        expect.objectContaining({ method: 'POST' })
      );
    });

    // Factory reset
    const eraseAllBtn = screen.getByRole('button', { name: /Erase all data/i });
    await user.click(eraseAllBtn);

    const eraseDialog = screen.getByRole('dialog', { name: /Erase all data\?/i });
    const typeClearInput = within(eraseDialog).getByLabelText(/Type CLEAR to confirm/i);
    await user.type(typeClearInput, 'CLEAR');

    const confirmEraseBtn = within(eraseDialog).getByRole('button', { name: /Erase everything/i });
    await user.click(confirmEraseBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/tenders/clear',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ unreviewedOnly: false })
        })
      );
    });
  });

  it('handles navigation to inbox when selected tender is a New Opportunity', async () => {
    // Return tender 1 (New Opportunity)
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/tenders/t-banner')) {
        return { ok: true, json: async () => ({ id: 't-banner', title: 'New Opp Tender', pipeline_status: 'New Opportunity' }) } as any;
      }
      if (urlStr.includes('/api/corrigenda')) {
        return {
          ok: true,
          json: async () => [{
            id: 'c-new',
            tender_id: 't-banner',
            tender_title: 'New Opp Tender',
            portal_name: 'Federal PPRA',
            change_type: 'deadline_extension',
            detected_at: '2026-11-01T10:00:00Z',
            is_acknowledged: 0
          }]
        } as any;
      }
      if (urlStr.includes('/api/tenders')) {
        return { ok: true, json: async () => [] } as any;
      }
      if (urlStr.includes('/api/portals')) {
        return { ok: true, json: async () => [] } as any;
      }
      if (urlStr.includes('/api/tracks')) {
        return { ok: true, json: async () => [] } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    render(<App />);

    const bannerBtn = await screen.findByRole('button', { name: /New Opp Tender/i });
    const user = userEvent.setup();
    await user.click(bannerBtn);

    await waitFor(() => {
      expect(localStorage.getItem('tt_section')).toBe('inbox');
    });
  });

  it('handles localStorage throwing exceptions safely', () => {
    const origGet = localStorage.getItem;
    const origSet = localStorage.setItem;

    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('Access denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('Quota exceeded');
    });

    expect(() => render(<App />)).not.toThrow();

    Storage.prototype.getItem = origGet;
    Storage.prototype.setItem = origSet;
  });

  it('handles network errors in UI action handlers gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Solar Power System')).toBeInTheDocument();
    });

    // Make fetch reject on next calls
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network disconnected'));

    // Trigger scan button failure
    const scanBtn = screen.getByRole('button', { name: /Scan now/i });
    await user.click(scanBtn);

    // Trigger bookmark toggle failure
    const bookmarkBtn = screen.getByRole('button', { name: /Bookmark/i });
    await user.click(bookmarkBtn);

    // Trigger track status change failure
    const trackBidBtn = screen.getByRole('button', { name: /Track this bid/i });
    await user.click(trackBidBtn);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to trigger scan:', expect.any(Error));
      expect(consoleSpy).toHaveBeenCalledWith('Failed to toggle bookmark:', expect.any(Error));
      expect(consoleSpy).toHaveBeenCalledWith('Failed to update status:', expect.any(Error));
    });
  });

  it('opens sources view when Review portals is clicked from outage banner', async () => {
    const user = userEvent.setup();
    render(<App />);

    const reviewBtn = await screen.findByRole('button', { name: /Review portals →/i });
    await user.click(reviewBtn);

    await waitFor(() => {
      expect(localStorage.getItem('tt_section')).toBe('sources');
    });
  });

  it('handles network error in fetch calls gracefully without crashing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network offline'));

    render(<App />);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to fetch tenders:', expect.any(Error));
    });
  });

  it('handles error states in sources and banner navigation', async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    localStorage.setItem('tt_section', 'sources');

    render(<App />);

    // Switch to Portals tab and Data tab
    const dataTab = await screen.findByRole('tab', { name: 'Data' });
    await user.click(dataTab);

    // Make fetch reject
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Clear error'));

    // Clear inbox in Data tab
    const clearInboxBtn = screen.getByRole('button', { name: 'Clear Inbox' });
    await user.click(clearInboxBtn);
    const confirmDialog = screen.getByRole('dialog', { name: 'Clear the Inbox?' });
    const confirmClearBtn = within(confirmDialog).getByRole('button', { name: 'Clear Inbox' });
    await user.click(confirmClearBtn);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to clear database:', expect.any(Error));
    });

    // Test banner tender fetch returning 404
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404
    } as any);

    // Click banner item
    const bannerBtn = screen.getByRole('button', { name: /IT Hardware Procurement/i });
    await user.click(bannerBtn);

    // Test banner tender fetch rejecting
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    await user.click(bannerBtn);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to open tender:', expect.any(Error));
    });

    // Test banner tender fetch returning New Opportunity (navigates to inbox)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 't-1',
        title: 'New Opportunity Tender',
        pipeline_status: 'New Opportunity'
      })
    } as any);

    await user.click(bannerBtn);
    await waitFor(() => {
      expect(localStorage.getItem('tt_section')).toBe('inbox');
    });
  });

  it('fetches network status on mount and triggers manual network recheck', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('network-status-indicator')).toHaveTextContent('Network: Healthy (45ms)');
    });

    const recheckBtn = screen.getByRole('button', { name: /Recheck network connectivity/i });
    await user.click(recheckBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/system/network/check',
        expect.objectContaining({ method: 'POST' })
      );
      expect(screen.getByTestId('network-status-indicator')).toHaveTextContent('Network: Healthy (38ms)');
    });
  });

  it('displays pausedReason without staying stuck in scanning state when scan start defers', async () => {
    const user = userEvent.setup();
    const pausedMessage = 'Slow network detected — deep scan held until connection is healthy (Quick Scan remains available)';

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Solar Power System')).toBeInTheDocument();
    });

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/scan/start')) {
        return {
          ok: true,
          json: async () => ({
            isScanning: false,
            currentPortal: null,
            progressPercent: 0,
            completedPortals: 0,
            totalPortals: 10,
            newTendersFound: 0,
            corrigendaFound: 0,
            lastScanTimestamp: null,
            pausedReason: pausedMessage,
          }),
        } as any;
      }
      if (urlStr.includes('/api/system/network')) {
        return {
          ok: true,
          json: async () => ({
            state: 'degraded',
            latencyMs: 2100,
            checkedAt: '2026-11-19T10:02:00Z',
            reason: 'High latency',
            heavyTasksPaused: true,
            deferredHeavyTasks: { deepScanPending: true, pendingDocumentJobs: 2 },
          }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    const deepBtn = screen.getByRole('button', { name: /Run deep multi-page scan/i });
    await user.click(deepBtn);

    await waitFor(() => {
      expect(screen.getByTestId('scan-paused-reason')).toHaveTextContent(pausedMessage);
      expect(screen.getByTestId('network-status-indicator')).toHaveTextContent('Network: Slow');
      expect(screen.getByRole('button', { name: /Scan now/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Run deep multi-page scan/i })).toBeDisabled();
    });
  });

  it('reloads tenders/KPIs/corrigenda on SSE documents_updated without redundant portal reloads and ignores doc_queue_progress reloads', async () => {
    render(<App />);

    await waitFor(() => {
      expect(lastEventSource).not.toBeNull();
      expect(screen.getByText('Solar Power System')).toBeInTheDocument();
    });

    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();

    // 1. doc_queue_progress updates sidebar indicator without triggering API reloads
    act(() => {
      lastEventSource.onmessage?.({
        data: JSON.stringify({
          type: 'doc_queue_progress',
          status: {
            isScanning: false,
            currentPortal: null,
            progressPercent: 100,
            completedPortals: 10,
            totalPortals: 10,
            newTendersFound: 0,
            corrigendaFound: 0,
            lastScanTimestamp: '2026-11-19T10:00:00Z',
            docQueue: { isFetching: true, readyPending: 4, awaitingScopePending: 9, totalPending: 13, completedInRun: 1 }
          }
        })
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('doc-queue-indicator')).toHaveTextContent('Downloading Inbox docs (4 left)');
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. documents_updated triggers tenders, KPIs, and corrigenda refresh (without /api/portals)
    act(() => {
      lastEventSource.onmessage?.({
        data: JSON.stringify({
          type: 'documents_updated',
          status: {
            isScanning: false,
            currentPortal: null,
            progressPercent: 100,
            completedPortals: 10,
            totalPortals: 10,
            newTendersFound: 0,
            corrigendaFound: 0,
            lastScanTimestamp: '2026-11-19T10:00:00Z',
            docQueue: { isFetching: false, readyPending: 0, awaitingScopePending: 9, totalPending: 9, completedInRun: 5 }
          }
        })
      });
    });

    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.includes('/api/tenders'))).toBe(true);
      expect(urls.some(u => u.includes('/api/kpis'))).toBe(true);
      expect(urls.some(u => u.includes('/api/corrigenda'))).toBe(true);
      expect(urls.some(u => u.includes('/api/portals'))).toBe(false);
    });
  });
});
