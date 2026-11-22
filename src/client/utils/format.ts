import type { PortalHealth } from '../../shared/types';

export function asList<T>(value: unknown): T[] {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value || '[]');
    } catch {
      return [];
    }
  }
  return (value as T[]) || [];
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export function formatRelativeAge(
  iso: string | null | undefined,
  options?: { prefix?: string; empty?: string; compactHours?: boolean }
): string {
  if (!iso) return options?.empty ?? 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  let core: string;
  if (options?.compactHours) {
    const hours = Math.round(diffMs / 3_600_000);
    core = hours <= 0 ? 'just now' : `${hours}h ago`;
  } else {
    const mins = Math.round(diffMs / 60_000);
    if (mins < 1) core = 'just now';
    else if (mins < 60) core = `${mins} min ago`;
    else if (mins < 1440) core = `${Math.round(mins / 60)} h ago`;
    else core = `${Math.round(mins / 1440)} days ago`;
  }
  return options?.prefix ? `${options.prefix} ${core}` : core;
}

export function isPortalOffline(p: PortalHealth): boolean {
  return p.status === 'selector_broken' || p.status === 'error' || p.access_mode === 'offline_broken';
}
