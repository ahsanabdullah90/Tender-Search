import React from 'react';
import { Inbox, Kanban, SlidersHorizontal, RefreshCw, Monitor, Sun, Moon, Shield } from 'lucide-react';
import { ScanStatus } from '../types';
import { ThemePref } from '../theme';
import { Button } from '../ui';

export type Section = 'inbox' | 'pipeline' | 'sources';

interface AppShellProps {
  section: Section;
  onNavigate: (section: Section) => void;
  scanStatus: ScanStatus;
  onRunScan: () => void;
  themePref: ThemePref;
  onThemePref: (pref: ThemePref) => void;
  children: React.ReactNode;
}

const navItems = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'pipeline', label: 'Pipeline', icon: Kanban },
  { id: 'sources', label: 'Sources & Keywords', icon: SlidersHorizontal },
] as const;

const themeOptions: { id: ThemePref; label: string; icon: typeof Monitor }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

function ThemeSwitch({ value, onChange }: { value: ThemePref; onChange: (p: ThemePref) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {themeOptions.map(opt => {
        const on = value === opt.id;
        const Icon = opt.icon;
        return (
          <button
            key={opt.id}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(opt.id)}
            className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold ${
              on ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function AppShell({ section, onNavigate, scanStatus, onRunScan, themePref, onThemePref, children }: AppShellProps) {
  const scanning = scanStatus.isScanning;
  const lastSync = scanStatus.lastScanTimestamp
    ? new Date(scanStatus.lastScanTimestamp).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Karachi',
      })
    : null;

  const syncText = scanning
    ? `Scanning ${scanStatus.currentPortal ?? ''} (${scanStatus.progressPercent}%)`.replace('  ', ' ')
    : lastSync
      ? `Synced ${lastSync}`
      : 'Not synced yet';

  return (
    <div className="flex min-h-screen bg-bg text-ink">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-6 border-r border-line bg-surface p-4">
        <div className="flex items-center gap-2.5 px-2">
          <img src="/favicon.png" alt="Tender Tracker" className="h-7 w-7 rounded-lg object-contain shadow-xs" />
          <span className="text-sm font-bold tracking-tight">Tender Tracker</span>
        </div>

        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {navItems.map(({ id, label, icon: Icon }) => {
            const on = section === id;
            return (
              <button
                key={id}
                onClick={() => onNavigate(id)}
                aria-current={on ? 'page' : undefined}
                className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium ${
                  on ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-3">
          <div className="flex items-center gap-2 px-2 text-xs text-ink-muted">
            <span className={`h-2 w-2 shrink-0 rounded-full ${scanning ? 'animate-pulse bg-warn' : 'bg-ok'}`} />
            <span>{syncText}</span>
          </div>
          <Button onClick={onRunScan} disabled={scanning} className="w-full">
            <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? 'Scanning…' : 'Scan now'}
          </Button>
          <ThemeSwitch value={themePref} onChange={onThemePref} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
