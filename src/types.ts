export type OpportunityStatus =
  | 'New Opportunity'
  | 'Under Review'
  | 'Preparing Bid'
  | 'Submitted'
  | 'Won'
  | 'Passed';

export interface CachedDossier {
  label: string;
  localPath: string;
  originalUrl: string;
  mimeType: string;
  sha256: string;
  sizeBytes?: number;
}

export interface SecondarySource {
  portalName: string;
  directUrl: string;
  discoveredAt: string;
}

export interface Tender {
  id: string;
  canonical_id: string;
  reference_no: string | null;
  title: string;
  organization: string;
  portal_id: string;
  portal_name: string;
  direct_url: string;
  secondary_sources: SecondarySource[];
  domain_tracks: string[]; // e.g. ["Construction & Civil Works", "Solar & Clean Energy"]
  matched_keywords: string[];
  match_score: number; // 0 - 100
  publish_date: string | null;
  closing_date: string | null; // ISO string or null for "Not Available"
  closing_date_formatted: string;
  estimated_value: string | null;
  location: string | null;
  description: string;
  cached_dossiers: CachedDossier[];
  has_corrigendum: number; // 0 or 1
  pipeline_status: OpportunityStatus;
  status_notes: string;
  result_expected_date?: string | null; // optional: when the award result is expected
  is_bookmarked: number;
  viewed: number;
  created_at: string;
  updated_at: string;
}

export interface CorrigendumLog {
  id: string;
  tender_id: string;
  tender_title?: string;
  change_type: 'deadline_extension' | 'scope_revision' | 'attachment_update';
  previous_value: string | null;
  new_value: string;
  is_acknowledged: number;
  detected_at: string;
}

export interface PipelineAuditLog {
  id: string;
  tender_id: string;
  previous_status: string | null;
  new_status: string;
  notes: string | null;
  created_at: string;
}

export interface DomainTrack {
  id: string;
  name: string;
  positive_keywords: string[];
  negative_keywords: string[];
  is_active: number;
}

export interface PortalHealth {
  portal_id: string;
  portal_name: string;
  category: 'Regulatory' | 'Federal/Regional' | 'Tech & Skills' | 'Multilateral' | 'Aggregator';
  tier: 'playwright' | 'http';
  base_url: string;
  tenders_url: string;
  login_url?: string;
  auth_username?: string;
  has_credentials?: boolean;
  session_cookies?: string;
  status: 'online' | 'scanning' | 'hitl_required' | 'selector_broken' | 'error';
  last_scan_at: string | null;
  last_items_found: number;
  consecutive_zero_yields: number;
  last_error_message: string | null;
  access_mode?: 'public' | 'login_required' | 'cloudflare' | 'offline_broken';
  verified_status?: string;
}

export interface ScanStatus {
  isScanning: boolean;
  currentPortal: string | null;
  progressPercent: number;
  completedPortals: number;
  totalPortals: number;
  newTendersFound: number;
  corrigendaFound: number;
  lastScanTimestamp: string | null;
}
