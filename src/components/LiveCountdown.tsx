import React, { useState, useEffect } from 'react';

interface LiveCountdownProps {
  closingDate?: string | null;
  closingDateFormatted?: string | null;
  mode?: 'compact' | 'detailed' | 'badge';
  className?: string;
}

interface TimeRemaining {
  totalSeconds: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isExpired: boolean;
  isUrgent: boolean; // < 24h
  isApproaching: boolean; // < 72h
}

export function calculateTimeRemaining(dateStr?: string | null): TimeRemaining | null {
  if (!dateStr || dateStr === 'Not Available') return null;

  const target = new Date(dateStr).getTime();
  if (isNaN(target)) return null;

  const now = Date.now();
  const diffMs = target - now;
  const totalSeconds = Math.floor(diffMs / 1000);

  if (totalSeconds <= 0) {
    return {
      totalSeconds: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      isExpired: true,
      isUrgent: false,
      isApproaching: false,
    };
  }

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return {
    totalSeconds,
    days,
    hours,
    minutes,
    seconds,
    isExpired: false,
    isUrgent: totalSeconds < 86400, // < 24 hours
    isApproaching: totalSeconds < 259200, // < 72 hours
  };
}

export function LiveCountdown({
  closingDate,
  closingDateFormatted,
  mode = 'compact',
  className = '',
}: LiveCountdownProps) {
  const [remaining, setRemaining] = useState<TimeRemaining | null>(() =>
    calculateTimeRemaining(closingDate)
  );

  useEffect(() => {
    // Immediate compute
    setRemaining(calculateTimeRemaining(closingDate));

    // If no date or already expired, no need to tick
    const initial = calculateTimeRemaining(closingDate);
    if (!initial || initial.isExpired) return;

    const timer = setInterval(() => {
      const next = calculateTimeRemaining(closingDate);
      setRemaining(next);
      if (next?.isExpired) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [closingDate]);

  if (!closingDate || closingDate === 'Not Available' || !remaining) {
    return (
      <span className={`text-slate-400 dark:text-slate-500 font-mono text-xs ${className}`}>
        {closingDateFormatted || 'Deadline Open'}
      </span>
    );
  }

  if (remaining.isExpired) {
    return (
      <span className={`inline-flex items-center text-slate-500 dark:text-slate-400 font-mono text-xs ${className}`}>
        Submission Closed
      </span>
    );
  }

  const pad = (n: number) => String(n).padStart(2, '0');

  // Detailed mode for persistent dossier pane
  if (mode === 'detailed') {
    let urgencyTheme = 'bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-800/60 dark:border-slate-700 dark:text-slate-300';
    let urgencyLabel = 'Standard Timeline';

    if (remaining.isUrgent) {
      urgencyTheme = 'bg-rose-50 border-rose-200 text-rose-800 dark:bg-rose-950/40 dark:border-rose-900/60 dark:text-rose-300';
      urgencyLabel = 'Critical Cutoff (<24h)';
    } else if (remaining.isApproaching) {
      urgencyTheme = 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-900/60 dark:text-amber-300';
      urgencyLabel = 'Approaching Cutoff (<72h)';
    }

    return (
      <div className={`p-3 rounded-lg border ${urgencyTheme} flex items-center justify-between gap-4 ${className}`}>
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0 opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider opacity-75">{urgencyLabel}</div>
            <div className="text-xs opacity-90">{closingDateFormatted || new Date(closingDate).toLocaleString()}</div>
          </div>
        </div>
        <div className="font-mono tabular-nums text-sm font-semibold tracking-tight">
          {remaining.days > 0 && <span className="mr-1.5">{remaining.days}d</span>}
          <span>{pad(remaining.hours)}</span>:
          <span>{pad(remaining.minutes)}</span>:
          <span>{pad(remaining.seconds)}</span>
        </div>
      </div>
    );
  }

  // Compact mode for left triage feed cards
  let textStyle = 'text-slate-600 dark:text-slate-300';
  if (remaining.isUrgent) {
    textStyle = 'text-rose-600 dark:text-rose-400 font-semibold';
  } else if (remaining.isApproaching) {
    textStyle = 'text-amber-600 dark:text-amber-400 font-medium';
  }

  return (
    <span className={`font-mono tabular-nums text-xs inline-flex items-center gap-1 ${textStyle} ${className}`}>
      <svg className="w-3.5 h-3.5 shrink-0 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {remaining.days > 0 && <span>{remaining.days}d </span>}
      <span>{pad(remaining.hours)}h {pad(remaining.minutes)}m {pad(remaining.seconds)}s</span>
    </span>
  );
}
