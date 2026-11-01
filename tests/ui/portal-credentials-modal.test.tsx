import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortalCredentialsModal } from '../../src/components/PortalCredentialsModal.js';
import type { PortalHealth } from '../../src/types.js';

describe('PortalCredentialsModal component', () => {
  const samplePortal: PortalHealth = {
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
    verified_status: 'Credentials required'
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render when isOpen is false or portal is null', () => {
    const { container } = render(
      <PortalCredentialsModal
        portal={samplePortal}
        isOpen={false}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('loads existing credentials and displays form inputs', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        username: 'operator@tenderservice.pk',
        loginUrl: 'https://tenderservice.pk/permits/login.php',
        hasPassword: true
      })
    } as any);

    render(
      <PortalCredentialsModal
        portal={samplePortal}
        isOpen={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    await screen.findByDisplayValue('operator@tenderservice.pk');

    expect(screen.getByDisplayValue('operator@tenderservice.pk')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. yourname@company.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/leave blank to keep current/i)).toBeInTheDocument();
  });

  it('submits form, displays success message, and calls onSuccess', async () => {
    const user = userEvent.setup();
    const handleSuccess = vi.fn();
    const handleClose = vi.fn();

    // Initial credentials fetch
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: '', loginUrl: '', hasPassword: false })
      } as any)
      // Save credentials post
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, message: 'Authentication successful!' })
      } as any);

    render(
      <PortalCredentialsModal
        portal={samplePortal}
        isOpen={true}
        onClose={handleClose}
        onSuccess={handleSuccess}
      />
    );

    const userInput = await screen.findByPlaceholderText('e.g. yourname@company.com');
    const passInput = screen.getByPlaceholderText(/Enter password or access key/i);

    await user.type(userInput, 'user@example.com');
    await user.type(passInput, 'secretPassword123');

    const submitBtn = screen.getByRole('button', { name: /Save & Log In/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Authentication successful!')).toBeInTheDocument();
    });

    // Advance timer past the 1200ms auto-close delay
    await waitFor(() => {
      expect(handleSuccess).toHaveBeenCalledTimes(1);
      expect(handleClose).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
  });

  it('toggles password visibility, updates loginUrl, and handles escape key', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ username: 'user1', loginUrl: 'https://example.com/login', hasPassword: false })
    } as any);

    render(
      <PortalCredentialsModal
        portal={samplePortal}
        isOpen={true}
        onClose={handleClose}
        onSuccess={vi.fn()}
      />
    );

    const userInput = await screen.findByPlaceholderText('e.g. yourname@company.com');
    expect(userInput).toBeInTheDocument();

    // Toggle password visibility
    const passInput = screen.getByPlaceholderText(/Enter password or access key/i) as HTMLInputElement;
    expect(passInput.type).toBe('password');

    const toggleBtn = passInput.parentElement?.querySelector('button') as HTMLButtonElement;
    await user.click(toggleBtn);
    expect(passInput.type).toBe('text');

    await user.click(toggleBtn);
    expect(passInput.type).toBe('password');

    // Change Login URL
    const urlInput = screen.getByDisplayValue('https://example.com/login');
    await user.clear(urlInput);
    await user.type(urlInput, 'https://newlogin.pk');
    expect(screen.getByDisplayValue('https://newlogin.pk')).toBeInTheDocument();

    // Press Escape to close modal
    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(event);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to portal defaults when credentials fetch fails', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const otherPortal: PortalHealth = {
      ...samplePortal,
      portal_id: 'epads',
      portal_name: 'Federal PPRA',
      auth_username: 'fed_user',
      login_url: 'https://epms.ppra.gov.pk/login',
      has_credentials: true
    };

    render(
      <PortalCredentialsModal
        portal={otherPortal}
        isOpen={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    await screen.findByDisplayValue('fed_user');
    expect(screen.getByDisplayValue('https://epms.ppra.gov.pk/login')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/leave blank to keep current/i)).toBeInTheDocument();
  });

  it('displays error message when authentication fails', async () => {
    const user = userEvent.setup();

    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: '', loginUrl: '', hasPassword: false })
      } as any)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false, message: 'Invalid credentials provided' })
      } as any);

    render(
      <PortalCredentialsModal
        portal={samplePortal}
        isOpen={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    const userInput = await screen.findByPlaceholderText('e.g. yourname@company.com');
    const passInput = screen.getByPlaceholderText(/Enter password or access key/i);

    await user.type(userInput, 'wrong@example.com');
    await user.type(passInput, 'wrongPass');

    const submitBtn = screen.getByRole('button', { name: /Save & Log In/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials provided')).toBeInTheDocument();
    });
  });

  it('handles credential fetch failure on mount and uses default portal fallback URLs', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Fetch failed'));

    const portalWithoutLoginUrl: PortalHealth = {
      ...samplePortal,
      portal_id: 'punjab_eproc',
      portal_name: 'Punjab PPRA',
      login_url: undefined,
      tenders_url: 'https://eproc.punjab.gov.pk/tenders'
    };

    render(
      <PortalCredentialsModal
        portal={portalWithoutLoginUrl}
        isOpen={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    const loginInput = await screen.findByDisplayValue('https://eproc.punjab.gov.pk/tenders');
    expect(loginInput).toBeInTheDocument();
  });

  it('handles authentication error without message string', async () => {
    const user = userEvent.setup();

    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      } as any)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false }) // no message
      } as any);

    render(
      <PortalCredentialsModal
        portal={samplePortal}
        isOpen={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    const userInput = await screen.findByPlaceholderText('e.g. yourname@company.com');
    const passInput = screen.getByPlaceholderText(/Enter password or access key/i);

    await user.type(userInput, 'test@example.com');
    await user.type(passInput, 'pass');

    const submitBtn = screen.getByRole('button', { name: /Save & Log In/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Failed to authenticate portal credentials')).toBeInTheDocument();
    });
  });
});
