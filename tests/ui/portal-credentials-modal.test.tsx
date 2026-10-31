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
});
