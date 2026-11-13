import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Button,
  Chip,
  Panel,
  Tabs,
  DeadlineChip,
  EmptyState,
  Dialog,
  SlideOver,
  Popover
} from '../../src/client/ui/index.js';

describe('UI Primitives (src/ui/index.tsx)', () => {
  describe('Button', () => {
    it('renders with text and handles clicks', async () => {
      const user = userEvent.setup();
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Click Me</Button>);

      const btn = screen.getByRole('button', { name: 'Click Me' });
      expect(btn).toBeInTheDocument();
      await user.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('applies variant and size styles properly', () => {
      const { rerender } = render(<Button variant="danger" size="sm">Danger</Button>);
      expect(screen.getByRole('button')).toHaveClass('text-danger');

      rerender(<Button variant="primary">Primary</Button>);
      expect(screen.getByRole('button')).toHaveClass('bg-accent');
    });

    it('respects disabled state', async () => {
      const user = userEvent.setup();
      const handleClick = vi.fn();
      render(<Button disabled onClick={handleClick}>Disabled</Button>);

      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
      await user.click(btn);
      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  describe('Chip', () => {
    it('renders with various tones', () => {
      const { rerender } = render(<Chip tone="ok">Active</Chip>);
      expect(screen.getByText('Active')).toHaveClass('text-ok');

      rerender(<Chip tone="danger">Expired</Chip>);
      expect(screen.getByText('Expired')).toHaveClass('text-danger');
    });
  });

  describe('Panel', () => {
    it('renders container children', () => {
      render(<Panel><p>Inside Panel</p></Panel>);
      expect(screen.getByText('Inside Panel')).toBeInTheDocument();
    });
  });

  describe('Tabs', () => {
    it('renders tabs with counts and triggers onChange', async () => {
      const user = userEvent.setup();
      const handleChange = vi.fn();
      const items = [
        { id: 'all', label: 'All Tenders', count: 42 },
        { id: 'saved', label: 'Saved' }
      ];

      render(<Tabs items={items} value="all" onChange={handleChange} label="Tender Filter Tabs" />);

      expect(screen.getByRole('tablist', { name: 'Tender Filter Tabs' })).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();

      const savedTab = screen.getByRole('tab', { name: /Saved/ });
      await user.click(savedTab);
      expect(handleChange).toHaveBeenCalledWith('saved');
    });
  });

  describe('DeadlineChip', () => {
    it('renders "No deadline stated" when date is null', () => {
      render(<DeadlineChip closingDate={null} />);
      expect(screen.getByText('No deadline stated')).toBeInTheDocument();
    });

    it('renders "Closed" when date is in the past', () => {
      const pastDate = new Date(Date.now() - 3600000).toISOString();
      render(<DeadlineChip closingDate={pastDate} />);
      expect(screen.getByText('Closed')).toBeInTheDocument();
    });

    it('renders danger tone under 24 hours', () => {
      const closingSoon = new Date(Date.now() + 10 * 3600000).toISOString();
      render(<DeadlineChip closingDate={closingSoon} />);
      const chip = screen.getByText(/Closes in \d+h/);
      expect(chip).toHaveClass('text-danger');
    });

    it('renders days when closing in 48+ hours', () => {
      const closingDays = new Date(Date.now() + 72 * 3600000).toISOString();
      render(<DeadlineChip closingDate={closingDays} />);
      expect(screen.getByText(/Closes in \d+ days/)).toBeInTheDocument();
    });
  });

  describe('EmptyState', () => {
    it('renders title, body, and action button', () => {
      render(
        <EmptyState
          title="No Results Found"
          body="Try broadening your search criteria."
          action={<Button>Reset</Button>}
        />
      );

      expect(screen.getByText('No Results Found')).toBeInTheDocument();
      expect(screen.getByText('Try broadening your search criteria.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    });
  });

  describe('Dialog', () => {
    it('renders dialog when open is true and handles Escape and Close', async () => {
      const user = userEvent.setup();
      const handleClose = vi.fn();

      const { rerender } = render(
        <Dialog open={true} onClose={handleClose} title="Confirm Delete">
          <p>Are you sure?</p>
        </Dialog>
      );

      expect(screen.getByRole('dialog', { name: 'Confirm Delete' })).toBeInTheDocument();
      expect(screen.getByText('Are you sure?')).toBeInTheDocument();

      // Click close icon button
      const closeBtn = screen.getByRole('button', { name: 'Close' });
      await user.click(closeBtn);
      expect(handleClose).toHaveBeenCalledTimes(1);

      // Press non-Escape key, should not trigger close
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(handleClose).toHaveBeenCalledTimes(1);

      // Press Escape key
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(2);

      // Unrender when open=false
      rerender(
        <Dialog open={false} onClose={handleClose} title="Confirm Delete">
          <p>Are you sure?</p>
        </Dialog>
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('SlideOver', () => {
    it('renders slide over panel when open and handles escape', async () => {
      const user = userEvent.setup();
      const handleClose = vi.fn();

      const { rerender } = render(
        <SlideOver open={true} onClose={handleClose} title="Tender Details">
          <div>RFP Specs</div>
        </SlideOver>
      );

      expect(screen.getByRole('dialog', { name: 'Tender Details' })).toBeInTheDocument();
      expect(screen.getByText('RFP Specs')).toBeInTheDocument();

      const closeBtn = screen.getByRole('button', { name: 'Close' });
      await user.click(closeBtn);
      expect(handleClose).toHaveBeenCalledTimes(1);

      rerender(
        <SlideOver open={false} onClose={handleClose} title="Tender Details">
          <div>RFP Specs</div>
        </SlideOver>
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('Popover', () => {
    it('toggles open and closes on trigger click or option select', async () => {
      const user = userEvent.setup();

      render(
        <Popover
          trigger={({ toggle }) => (
            <button onClick={toggle}>Menu</button>
          )}
        >
          {close => (
            <button onClick={close}>Action 1</button>
          )}
        </Popover>
      );

      const trigger = screen.getByText('Menu');
      expect(screen.queryByText('Action 1')).not.toBeInTheDocument();

      await user.click(trigger);
      expect(screen.getByText('Action 1')).toBeInTheDocument();

      await user.click(screen.getByText('Action 1'));
      expect(screen.queryByText('Action 1')).not.toBeInTheDocument();
    });

    it('closes Popover on Escape key and supports align="end"', async () => {
      const user = userEvent.setup();

      render(
        <div>
          <button>Outside</button>
          <Popover
            align="end"
            trigger={({ toggle }) => (
              <button onClick={toggle}>AlignedMenu</button>
            )}
          >
            {() => <span>Dropdown Content</span>}
          </Popover>
        </div>
      );

      const trigger = screen.getByText('AlignedMenu');
      await user.click(trigger);
      expect(screen.getByText('Dropdown Content')).toBeInTheDocument();

      // Press non-Escape key, should not close
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(screen.getByText('Dropdown Content')).toBeInTheDocument();

      // Press Escape
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByText('Dropdown Content')).not.toBeInTheDocument();

      // Reopen and click outside
      await user.click(trigger);
      expect(screen.getByText('Dropdown Content')).toBeInTheDocument();
      fireEvent.mouseDown(screen.getByText('Outside'));
      expect(screen.queryByText('Dropdown Content')).not.toBeInTheDocument();
    });
  });
});
