import React, { useState, useEffect, useCallback, useRef } from 'react';
import { KpiHeader } from './components/KpiHeader';
import { AppShell, Section } from './components/AppShell';
import {
  ThemePref,
  readThemePref,
  writeThemePref,
  systemPrefersDark,
  resolveDark,
  applyDarkClass,
  onSystemThemeChange,
} from './theme';
import { InboxScreen } from './components/InboxScreen';
import { PipelineScreen } from './components/PipelineScreen';
import { SourcesScreen } from './components/SourcesScreen';
import { Tender, DomainTrack, PortalHealth, CorrigendumLog, ScanStatus, OpportunityStatus } from './types';

const SECTION_KEY = 'tt_section';
const OLD_KEYS = ['tender_tracker_currentView', 'tender_tracker_sortBy', 'tender_tracker_isDark'];

/** Reads the saved section. Carries over the old view setting once, then clears leftover keys from earlier versions. */
function readSection(): Section {
  try {
    let saved = localStorage.getItem(SECTION_KEY);
    if (!saved) {
      saved = localStorage.getItem('tender_tracker_currentView') === 'kanban' ? 'pipeline' : 'inbox';
      localStorage.setItem(SECTION_KEY, saved);
    }
    for (const key of OLD_KEYS) localStorage.removeItem(key);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sentinel_')) localStorage.removeItem(key);
    }
    return saved === 'pipeline' || saved === 'sources' ? saved : 'inbox';
  } catch {
    return 'inbox';
  }
}

export default function App() {
  // Theme: System (default), Light or Dark. System follows the computer and updates live.
  const [themePref, setThemePref] = useState<ThemePref>(readThemePref);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);
  const isDark = resolveDark(themePref, systemDark);

  useEffect(() => onSystemThemeChange(() => setSystemDark(systemPrefersDark())), []);

  useEffect(() => {
    applyDarkClass(isDark);
  }, [isDark]);

  const changeThemePref = (pref: ThemePref) => {
    writeThemePref(pref);
    setThemePref(pref);
  };


  // Data States
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [tracks, setTracks] = useState<DomainTrack[]>([]);
  const [portals, setPortals] = useState<PortalHealth[]>([]);
  const [corrigenda, setCorrigenda] = useState<CorrigendumLog[]>([]);
  const [kpiStats, setKpiStats] = useState({
    totalTracked: 0,
    closingSoon: 0,
    inPipeline: 0,
    unackCorrigenda: 0,
    totalPortals: 18,
    onlinePortals: 18,
    hitlRequiredCount: 0
  });

  const [scanStatus, setScanStatus] = useState<ScanStatus>({
    isScanning: false,
    currentPortal: null,
    progressPercent: 0,
    completedPortals: 0,
    totalPortals: 18,
    newTendersFound: 0,
    corrigendaFound: 0,
    lastScanTimestamp: null
  });

  // UI Filtering & Navigation States
  const [selectedTrack, setSelectedTrack] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [bookmarkedOnly, setBookmarkedOnly] = useState<boolean>(false);
  const [corrigendumOnly, setCorrigendumOnly] = useState<boolean>(false);
  const [section, setSection] = useState<Section>(readSection);
  // A tender to open when arriving from an alert banner.
  const [focusTenderId, setFocusTenderId] = useState<string | null>(null);

  const handleNavigate = (next: Section) => {
    setSection(next);
    setFocusTenderId(null);
    try { localStorage.setItem(SECTION_KEY, next); } catch { /* storage unavailable */ }
  };

  // The Inbox only lists tenders that have not been reviewed yet.
  const inboxMode = section === 'inbox';
  const pipelineMode = section === 'pipeline';

  // Debounce search query to avoid laggy queries
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // In-flight abort controller
  const abortControllerRef = useRef<AbortController | null>(null);

  // Data Fetchers
  const fetchTenders = useCallback(async () => {
    try {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      const params = new URLSearchParams();
      if (inboxMode) params.append('status', 'New Opportunity');
      // The Pipeline shows every stage past the Inbox, so the Inbox filters do not apply.
      if (!pipelineMode) {
        if (selectedTrack !== 'All') params.append('track', selectedTrack);
        if (debouncedSearch.trim()) params.append('search', debouncedSearch.trim());
        if (bookmarkedOnly) params.append('bookmarkedOnly', 'true');
        if (corrigendumOnly) params.append('corrigendumOnly', 'true');
      }

      const res = await fetch(`/api/tenders?${params.toString()}`, {
        signal: abortControllerRef.current.signal
      });
      if (res.ok) {
        const data = await res.json();
        setTenders(data);
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Failed to fetch tenders:', err);
      }
    }
  }, [inboxMode, pipelineMode, selectedTrack, debouncedSearch, bookmarkedOnly, corrigendumOnly]);

  const fetchTracks = useCallback(async () => {
    try {
      const res = await fetch('/api/tracks');
      if (res.ok) {
        const data = await res.json();
        setTracks(data);
      }
    } catch (err) {
      console.error('Failed to fetch tracks:', err);
    }
  }, []);

  const fetchPortals = useCallback(async () => {
    try {
      const res = await fetch('/api/portals');
      if (res.ok) {
        const data = await res.json();
        setPortals(data);
      }
    } catch (err) {
      console.error('Failed to fetch portals:', err);
    }
  }, []);

  const fetchCorrigenda = useCallback(async () => {
    try {
      const res = await fetch('/api/corrigenda');
      if (res.ok) {
        const data = await res.json();
        setCorrigenda(data);
      }
    } catch (err) {
      console.error('Failed to fetch corrigenda:', err);
    }
  }, []);

  const fetchKpis = useCallback(async () => {
    try {
      const res = await fetch('/api/kpis');
      if (res.ok) {
        const data = await res.json();
        setKpiStats(data);
      }
    } catch (err) {
      console.error('Failed to fetch KPIs:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchTenders();
    fetchTracks();
    fetchPortals();
    fetchCorrigenda();
    fetchKpis();
  }, [fetchTenders, fetchTracks, fetchPortals, fetchCorrigenda, fetchKpis]);

  // Server-Sent Events (SSE) Listener for Real-Time Scraper Telemetry
  useEffect(() => {
    const eventSource = new EventSource('/api/scan/stream');

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const statusData: ScanStatus = payload.status || payload;

        setScanStatus(statusData);

        // If scan completed, reload live datasets
        if (!statusData.isScanning && statusData.completedPortals > 0) {
          fetchTenders();
          fetchPortals();
          fetchCorrigenda();
          fetchKpis();
        }
      } catch (err) {
        console.error('SSE JSON parse error:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn('SSE connection closed or re-connecting:', err);
    };

    return () => {
      eventSource.close();
    };
  }, [fetchTenders, fetchPortals, fetchCorrigenda, fetchKpis]);

  // Actions
  const handleRunScan = async (portalId?: string) => {
    try {
      setScanStatus(prev => ({ ...prev, isScanning: true }));
      const res = await fetch('/api/scan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portalId })
      });
      if (res.ok) {
        const status = await res.json();
        setScanStatus(status);
      }
    } catch (err) {
      console.error('Failed to trigger scan:', err);
      setScanStatus(prev => ({ ...prev, isScanning: false }));
    }
  };

  const handleUpdateStatus = async (tenderId: string, newStatus: OpportunityStatus) => {
    try {
      const res = await fetch(`/api/tenders/${tenderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        setTenders(prev =>
          prev.map(t => (t.id === tenderId ? { ...t, pipeline_status: newStatus } : t))
        );
        fetchKpis();
        // Re-query so a tender that changed stage leaves the list it no longer belongs to.
        fetchTenders();
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const handleToggleBookmark = async (tenderId: string) => {
    try {
      const res = await fetch(`/api/tenders/${tenderId}/bookmark`, { method: 'PATCH' });
      if (res.ok) {
        const data = await res.json();
        setTenders(prev =>
          prev.map(t => (t.id === tenderId ? { ...t, is_bookmarked: data.is_bookmarked } : t))
        );
      }
    } catch (err) {
      console.error('Failed to toggle bookmark:', err);
    }
  };

  const handleSaveNotes = async (tenderId: string, notes: string): Promise<void> => {
    const res = await fetch(`/api/tenders/${tenderId}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    if (!res.ok) {
      throw new Error(`Failed to save notes: HTTP ${res.status}`);
    }
    setTenders(prev =>
      prev.map(t => (t.id === tenderId ? { ...t, status_notes: notes } : t))
    );
  };

  const handleSetResultDate = async (tenderId: string, date: string | null) => {
    try {
      const res = await fetch(`/api/tenders/${tenderId}/result-date`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date })
      });
      if (res.ok) {
        setTenders(prev => prev.map(t => (t.id === tenderId ? { ...t, result_expected_date: date } : t)));
      }
    } catch (err) {
      console.error('Failed to set result date:', err);
    }
  };

  const handleAcknowledgeCorrigendum = async (logId: string) => {
    try {
      const res = await fetch(`/api/corrigenda/${logId}/acknowledge`, { method: 'POST' });
      if (res.ok) {
        fetchCorrigenda();
        fetchKpis();
        fetchTenders();
      }
    } catch (err) {
      console.error('Failed to acknowledge corrigendum:', err);
    }
  };

  const handleLaunchHitl = async (portalId: string) => {
    try {
      const res = await fetch(`/api/portals/${portalId}/hitl-launch`, { method: 'POST' });
      const data = await res.json();
      if (data.isHeadlessFallback && data.portalUrl) {
        window.open(data.portalUrl, '_blank');
      }
    } catch (err) {
      console.error('HITL launch error:', err);
    }
  };

  const handleVerifyHitl = async (portalId: string) => {
    try {
      await fetch(`/api/portals/${portalId}/hitl-verify`, { method: 'POST' });
      fetchPortals();
      fetchKpis();
    } catch (err) {
      console.error('HITL verify error:', err);
    }
  };

  const handleSaveTrack = async (track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[] }) => {
    try {
      const res = await fetch('/api/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track)
      });
      if (res.ok) {
        fetchTracks();
        fetchTenders();
      }
    } catch (err) {
      console.error('Failed to save track:', err);
    }
  };

  const handleDeleteTrack = async (id: string) => {
    try {
      const deletedTrack = tracks.find(t => t.id === id);
      const res = await fetch(`/api/tracks/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchTracks();
        if (deletedTrack && selectedTrack === deletedTrack.name) {
          setSelectedTrack('All');
        }
        fetchTenders();
      }
    } catch (err) {
      console.error('Failed to delete track:', err);
    }
  };

  const handleClearDatabase = async (unreviewedOnly: boolean) => {
    try {
      const res = await fetch('/api/tenders/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unreviewedOnly })
      });
      if (res.ok) {
        fetchTenders();
        fetchKpis();
        fetchCorrigenda();
      }
    } catch (err) {
      console.error('Failed to clear database:', err);
    }
  };

  const handleAddPortal = async (portal: { portal_name: string; tenders_url: string; base_url?: string; category?: string; tier?: string; access_mode?: string; login_url?: string }) => {
    try {
      const res = await fetch('/api/portals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(portal)
      });
      if (res.ok) {
        fetchPortals();
        fetchKpis();
        return true;
      }
      return false;
    } catch (err) {
      console.error('Failed to add portal:', err);
      return false;
    }
  };

  const handleDeletePortal = async (portalId: string) => {
    try {
      const res = await fetch(`/api/portals/${portalId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        fetchPortals();
        fetchKpis();
        return true;
      }
      return false;
    } catch (err) {
      console.error('Failed to delete portal:', err);
      return false;
    }
  };

  const handleUpdatePortal = async (portalId: string, updates: Partial<PortalHealth>) => {
    try {
      const res = await fetch(`/api/portals/${portalId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        fetchPortals();
      }
    } catch (err) {
      console.error('Failed to update portal:', err);
    }
  };

  const handleSelectTenderById = async (tenderId: string) => {
    try {
      const res = await fetch(`/api/tenders/${tenderId}`);
      if (!res.ok) return;
      const tender: Tender = await res.json();
      handleNavigate(tender.pipeline_status === 'New Opportunity' ? 'inbox' : 'pipeline');
      setFocusTenderId(tenderId);
    } catch (err) {
      console.error('Failed to open tender:', err);
    }
  };

  return (
    <AppShell
      section={section}
      onNavigate={handleNavigate}
      scanStatus={scanStatus}
      onRunScan={() => handleRunScan()}
      themePref={themePref}
      onThemePref={changeThemePref}
    >
      <KpiHeader
        stats={kpiStats}
        corrigenda={corrigenda}
        portals={portals}
        onAcknowledgeCorrigendum={handleAcknowledgeCorrigendum}
        onLaunchHitl={handleLaunchHitl}
        onSelectTenderById={handleSelectTenderById}
        onOpenSources={() => handleNavigate('sources')}
      />

      {/* 2. TAB A: Tenders Pipeline View */}
      {inboxMode ? (
        <InboxScreen
          tenders={tenders}
          tracks={tracks}
          corrigenda={corrigenda}
          selectedTrack={selectedTrack}
          onSelectTrack={setSelectedTrack}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          bookmarkedOnly={bookmarkedOnly}
          onToggleBookmarked={() => setBookmarkedOnly(prev => !prev)}
          corrigendumOnly={corrigendumOnly}
          onToggleCorrigendum={() => setCorrigendumOnly(prev => !prev)}
          onStatusChange={handleUpdateStatus}
          onAcknowledgeCorrigendum={handleAcknowledgeCorrigendum}
          onSaveNotes={handleSaveNotes}
          onToggleBookmark={handleToggleBookmark}
          focusId={focusTenderId}
          onTenderUpdated={updated => setTenders(prev => prev.map(t => (t.id === updated.id ? updated : t)))}
          onTenderCreated={created => {
            setTenders(prev => [created, ...prev]);
            fetchKpis();
          }}
        />
      ) : pipelineMode ? (
        <PipelineScreen
          tenders={tenders}
          corrigenda={corrigenda}
          onStatusChange={handleUpdateStatus}
          onAcknowledgeCorrigendum={handleAcknowledgeCorrigendum}
          onSaveNotes={handleSaveNotes}
          onToggleBookmark={handleToggleBookmark}
          onSetResultDate={handleSetResultDate}
          focusId={focusTenderId}
        />
      ) : (
        <main className="flex-1">
          <SourcesScreen
            tracks={tracks}
            portals={portals}
            onSaveTrack={handleSaveTrack}
            onDeleteTrack={handleDeleteTrack}
            onUpdatePortal={handleUpdatePortal}
            onAddPortal={handleAddPortal}
            onDeletePortal={handleDeletePortal}
            onLaunchHitl={handleLaunchHitl}
            onVerifyHitl={handleVerifyHitl}
            onScanSinglePortal={handleRunScan}
            onClearInbox={() => handleClearDatabase(true)}
            onEraseAll={() => handleClearDatabase(false)}
          />
        </main>
      )}
    </AppShell>
  );
}
