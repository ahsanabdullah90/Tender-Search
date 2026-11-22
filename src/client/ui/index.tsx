import React, { useEffect, useId, useRef, useState } from 'react';
import { RotateCw, X } from 'lucide-react';

/* Shared building blocks. Every screen uses these, so the look stays consistent. */

export const FIELD_INPUT_CLASS = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-ink-muted';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-transparent hover:brightness-110',
  secondary: 'bg-surface text-ink border-line hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-muted border-transparent hover:bg-surface-2 hover:text-ink',
  danger: 'bg-surface text-danger border-danger hover:bg-danger-soft',
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }
>(({ variant = 'secondary', size = 'md', className = '', type = 'button', ...rest }, ref) => (
  <button
    ref={ref}
    type={type}
    className={`inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
      size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4'
    } ${buttonStyles[variant]} ${className}`}
    {...rest}
  />
));
Button.displayName = 'Button';

type ChipTone = 'neutral' | 'accent' | 'danger' | 'warn' | 'ok';

const chipTones: Record<ChipTone, string> = {
  neutral: 'bg-chip text-ink-muted',
  accent: 'bg-accent-soft text-accent',
  danger: 'bg-danger-soft text-danger',
  warn: 'bg-warn-soft text-warn',
  ok: 'bg-ok-soft text-ok',
};

export function Chip({ tone = 'neutral', children, className = '' }: { tone?: ChipTone; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${chipTones[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function DocStatusChip({
  kind,
  shortLabel,
  title,
  testId,
}: {
  kind: 'processing' | 'queued' | 'failed' | 'complete' | 'listing_only';
  shortLabel: string;
  title: string;
  testId?: string;
}) {
  if (kind !== 'processing' && kind !== 'queued' && kind !== 'failed') return null;
  const toneClass =
    kind === 'processing'
      ? 'bg-accent-soft text-accent'
      : kind === 'failed'
        ? 'bg-warn-soft text-warn'
        : 'bg-surface-2 text-ink-muted';
  return (
    <span
      data-testid={testId}
      title={title}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${toneClass}`}
    >
      {kind === 'processing' && <RotateCw aria-hidden="true" className="h-3 w-3 motion-safe:animate-spin" />}
      {shortLabel}
    </span>
  );
}

export function Panel({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <section className={`rounded-xl border border-line bg-surface ${className}`}>{children}</section>;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-6 border-b border-line">
      {items.map(item => {
        const on = item.id === value;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(item.id)}
            className={`-mb-px cursor-pointer border-b-2 py-2.5 text-sm font-semibold ${
              on ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {item.label}
            {item.count !== undefined && <span className="ml-2 font-mono text-xs text-ink-muted">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Shows time left to close. Red under 24 hours. Callers re-render to keep it current. */
export function DeadlineChip({ closingDate }: { closingDate: string | null }) {
  if (!closingDate) return <Chip>No deadline stated</Chip>;
  const hours = (new Date(closingDate).getTime() - Date.now()) / 3_600_000;
  if (hours < 0) return <Chip>Closed</Chip>;
  const label = hours < 48 ? `Closes in ${Math.max(1, Math.floor(hours))}h` : `Closes in ${Math.floor(hours / 24)} days`;
  return <Chip tone={hours < 24 ? 'danger' : 'neutral'}>{label}</Chip>;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="mb-1 text-ink-muted">{icon}</div>}
      <div className="text-base font-semibold text-ink">{title}</div>
      {body && <p className="max-w-sm text-ink-muted">{body}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const titleId = useId();
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative w-full max-w-md rounded-xl border border-line bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-3 min-w-0">
            {icon && <div className="shrink-0">{icon}</div>}
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-bold">{title}</h2>
              {subtitle && <p className="truncate text-xs text-ink-muted">{subtitle}</p>}
            </div>
          </div>
          <button aria-label="Close" onClick={onClose} className="cursor-pointer rounded-md p-1 text-ink-muted hover:bg-surface-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Panel that slides in from the right. Used for tender details. */
export function SlideOver({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden="true" />
      <aside role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative flex h-full w-full max-w-xl flex-col border-l border-line bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id={titleId} className="truncate text-base font-bold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="cursor-pointer rounded-md p-1 text-ink-muted hover:bg-surface-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

/** Small menu anchored to a button. Closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = 'start',
  panelClassName = 'min-w-56',
}: {
  trigger: (p: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: 'start' | 'end';
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      {trigger({ open, toggle: () => setOpen(o => !o) })}
      {open && (
        <div className={`absolute z-40 mt-2 rounded-xl border border-line bg-surface p-2 shadow-lg ${panelClassName} ${align === 'end' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
