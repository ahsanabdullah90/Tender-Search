import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PortalHealth, Tender } from '../../src/shared/types.js';
import {
  asList,
  fileToBase64,
  formatBytes,
  formatMegabytes,
  formatRelativeAge,
  isPortalOffline
} from '../../src/client/utils/format.js';
import { ApiError, apiJson, apiMutate } from '../../src/client/utils/apiClient.js';
import { DeleteTenderModal } from '../../src/client/components/inbox/DeleteTenderModal.js';
import { PassConfirmModal } from '../../src/client/components/pipeline/PassConfirmModal.js';

const baseTender: Tender = {
  id: 'tender-util-1',
  canonical_id: 'canon-util-1',
  reference_no: 'REF-100',
  title: 'Supply of Inverters',
  organization: 'Energy Dept',
  portal_id: 'epads',
  portal_name: 'EPADS',
  direct_url: 'https://eprocure.gov.pk/t/1',
  secondary_sources: [],
  domain_tracks: ['Solar'],
  matched_keywords: ['inverter'],
  match_score: 90,
  publish_date: null,
  closing_date: '2026-12-20T12:00:00Z',
  closing_date_formatted: '20 Dec 2026',
  estimated_value: null,
  location: null,
  description: 'Procurement scope',
  cached_dossiers: [
    {
      label: 'RFP.pdf',
      localPath: 'EPADS_REF-100_RFP.pdf',
      originalUrl: 'https://eprocure.gov.pk/t/1/rfp.pdf',
      mimeType: 'application/pdf',
      sha256: 'abc123',
      sizeBytes: 2 * 1024 * 1024,
      addedAt: '2026-11-20T00:00:00Z'
    }
  ],
  has_corrigendum: 0,
  pipeline_status: 'Under Review',
  status_notes: 'Reviewing spec',
  is_bookmarked: 0,
  viewed: 1,
  created_at: '2026-11-20T00:00:00Z',
  updated_at: '2026-11-20T00:00:00Z'
};

function makePortal(overrides: Partial<PortalHealth>): PortalHealth {
  return {
    portal_id: 'test',
    portal_name: 'Test Portal',
    category: 'Federal/Regional',
    tier: 'http',
    base_url: 'https://example.gov.pk',
    tenders_url: 'https://example.gov.pk/tenders',
    status: 'online',
    last_scan_at: null,
    last_items_found: 0,
    consecutive_zero_yields: 0,
    last_error_message: null,
    access_mode: 'public',
    ...overrides
  };
}

describe('Client Utilities & Shared Modal Accessibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('format utilities', () => {
    it('asList parses JSON array strings safely and passes arrays through', () => {
      expect(asList<string>('["a","b"]')).toEqual(['a', 'b']);
      expect(asList<string>('{invalid')).toEqual([]);
      expect(asList<number>([1, 2])).toEqual([1, 2]);
      expect(asList<string>(null)).toEqual([]);
    });

    it('formatBytes and formatMegabytes format byte sizes across units', () => {
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(2048)).toBe('2 KB');
      expect(formatBytes(1.5 * 1024 ** 2)).toBe('1.5 MB');
      expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.50 GB');
      expect(formatMegabytes(5 * 1024 * 1024)).toBe('5.00');
    });

    it('formatRelativeAge formats timestamps, compactHours, prefixes, and empty states', () => {
      expect(formatRelativeAge(null)).toBe('Never');
      expect(formatRelativeAge(null, { empty: 'Never checked' })).toBe('Never checked');

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));

      expect(formatRelativeAge('2026-11-22T12:00:00Z')).toBe('just now');
      expect(formatRelativeAge('2026-11-22T11:45:00Z')).toBe('15 min ago');
      expect(formatRelativeAge('2026-11-22T09:00:00Z', { prefix: 'Checked' })).toBe('Checked 3 h ago');
      expect(formatRelativeAge('2026-11-20T12:00:00Z')).toBe('2 days ago');
      expect(formatRelativeAge('2026-11-22T08:00:00Z', { compactHours: true })).toBe('4h ago');
    });

    it('fileToBase64 strips the DataURL prefix from FileReader output', async () => {
      const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
      const encoded = await fileToBase64(file);
      expect(encoded).toBe(btoa('hello'));
    });

    it('isPortalOffline identifies selector_broken, error, and offline_broken portals', () => {
      expect(isPortalOffline(makePortal({ status: 'selector_broken' }))).toBe(true);
      expect(isPortalOffline(makePortal({ status: 'error' }))).toBe(true);
      expect(isPortalOffline(makePortal({ access_mode: 'offline_broken' }))).toBe(true);
      expect(isPortalOffline(makePortal({ status: 'online' }))).toBe(false);
      expect(isPortalOffline(makePortal({ status: 'hitl_required' }))).toBe(false);
    });
  });

  describe('apiClient helpers', () => {
    it('apiJson calls bare fetch(url) for default GET requests without extra init headers', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ count: 3 })
      } as unknown as Response);

      const res = await apiJson<{ count: number }>('/api/kpis');
      expect(res).toEqual({ count: 3 });
      expect(fetchSpy).toHaveBeenCalledWith('/api/kpis');
    });

    it('apiJson throws ApiError on !res.ok (even with partial mocks) and on success === false', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: false, message: 'Scan already active' })
        } as unknown as Response);

      await expect(apiJson('/api/failing')).rejects.toMatchObject({
        name: 'ApiError',
        status: 500,
        message: 'HTTP 500'
      });

      await expect(apiJson('/api/scan/start')).rejects.toBeInstanceOf(ApiError);
    });

    it('apiMutate omits body/headers when body is undefined and sends JSON when body is supplied', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ saved: true })
        } as unknown as Response);

      await apiMutate('/api/tenders/1/fetch-documents', 'POST');
      expect(fetchSpy).toHaveBeenNthCalledWith(1, '/api/tenders/1/fetch-documents', { method: 'POST' });

      await apiMutate('/api/tracks', 'POST', { name: 'Solar' });
      expect(fetchSpy).toHaveBeenNthCalledWith(2, '/api/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Solar' })
      });
    });
  });

  describe('Shared Modal Accessibility', () => {
    it('DeleteTenderModal renders an accessible dialog with safe Cancel focus and Escape dismissal', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onConfirmDelete = vi.fn().mockResolvedValue(undefined);

      render(
        <DeleteTenderModal
          tender={baseTender}
          isOpen={true}
          onClose={onClose}
          onConfirmDelete={onConfirmDelete}
        />
      );

      const dialog = screen.getByRole('dialog', { name: 'Delete Tender Permanently?' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
      expect(screen.getByText(/2\.00 MB/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: 'Delete Permanently' }));
      expect(onConfirmDelete).toHaveBeenCalledWith('tender-util-1');
    });

    it('PassConfirmModal renders an accessible dialog with safe Keep Tracking focus and Escape dismissal', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onConfirmPass = vi.fn().mockResolvedValue(undefined);

      render(
        <PassConfirmModal
          tender={baseTender}
          isOpen={true}
          onClose={onClose}
          onConfirmPass={onConfirmPass}
        />
      );

      const dialog = screen.getByRole('dialog', { name: 'Pass Active Bid Pursuit?' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Keep Tracking' })).toHaveFocus();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: 'Pass & Remove Files' }));
      expect(onConfirmPass).toHaveBeenCalledWith('tender-util-1');
    });
  });
});
