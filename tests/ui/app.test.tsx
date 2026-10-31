import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../src/App.js';

describe('App root component', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();

    // Mock EventSource for SSE scan progress
    class MockEventSource {
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal('EventSource', MockEventSource);

    // Mock initial API responses
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/tenders')) {
        return { ok: true, json: async () => [] } as any;
      }
      if (urlStr.includes('/api/tracks')) {
        return { ok: true, json: async () => [] } as any;
      }
      if (urlStr.includes('/api/portals')) {
        return { ok: true, json: async () => [] } as any;
      }
      if (urlStr.includes('/api/kpis')) {
        return {
          ok: true,
          json: async () => ({
            totalTracked: 0,
            closingSoon: 0,
            inPipeline: 0,
            unackCorrigenda: 0,
            totalPortals: 18,
            onlinePortals: 18,
            hitlRequiredCount: 0
          })
        } as any;
      }
      if (urlStr.includes('/api/corrigenda')) {
        return { ok: true, json: async () => [] } as any;
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
      expect(screen.getByText('Your Inbox is clear')).toBeInTheDocument();
    });
  });

  it('navigates between sections when sidebar buttons are clicked', async () => {
    const user = userEvent.setup();
    render(<App />);

    const pipelineBtn = screen.getByRole('button', { name: /Pipeline/i });
    await user.click(pipelineBtn);

    await waitFor(() => {
      expect(screen.getByText('No tenders in your pipeline')).toBeInTheDocument();
    });

    const sourcesBtn = screen.getByRole('button', { name: /Sources & Keywords/i });
    await user.click(sourcesBtn);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Portals/i })).toBeInTheDocument();
    });
  });
});
