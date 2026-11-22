import React from 'react';
import type { DomainTrack, PortalHealth } from '../../../shared/types';

export type SourcesTab = 'keywords' | 'portals' | 'data';

export interface SourcesScreenProps {
  initialTab?: SourcesTab;
  tracks: DomainTrack[];
  portals: PortalHealth[];
  onSaveTrack: (track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[] }) => void;
  onDeleteTrack: (id: string) => void;
  onUpdatePortal: (portalId: string, updates: Partial<PortalHealth>) => void;
  onAddPortal?: (portal: { portal_name: string; tenders_url: string; base_url?: string; category?: string; tier?: string; access_mode?: string; login_url?: string }) => Promise<boolean> | void;
  onDeletePortal?: (portalId: string) => Promise<boolean> | void;
  onLaunchHitl: (portalId: string) => void;
  onVerifyHitl: (portalId: string) => void;
  onScanSinglePortal: (portalId: string) => void;
  onClearInbox: () => void;
  onEraseAll: () => void;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}
