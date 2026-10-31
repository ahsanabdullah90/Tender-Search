import React, { useState, useEffect, useCallback, useRef } from 'react';
import { KpiHeader } from './components/KpiHeader';
import { TrackFilterBar } from './components/TrackFilterBar';
import { SplitPaneWorkspace } from './components/SplitPaneWorkspace';
import { TenderTable } from './components/TenderTable';
import { TenderKanban } from './components/TenderKanban';
import { TenderDrawer } from './components/TenderDrawer';
import { TrackManagerModal } from './components/TrackManagerModal';
import { PortalHealthModal } from './components/PortalHealthModal';
import { SettingsWorkspace } from './components/SettingsWorkspace';
import { Tender, DomainTrack, PortalHealth, CorrigendumLog, ScanStatus, OpportunityStatus } from './types';

export default function App() {
  // Theme State with localStorage persistence
  const [isDark, setIsDark] = useState<boolean>(() => {
    const saved = localStorage.getItem('sentinel_isDark');
    if (saved !== null) return saved === 'true';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    localStorage.setItem('sentinel_isDark', String(isDark));
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // Primary Workspace Tab: 'tenders' (Console) vs 'management' (Dedicated Keywords & Portals Tab)
  const [activeTab, setActiveTab] = useState<'tenders' | 'management'>('tenders');

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
    totalPortals: 17,
    onlinePortals: 17,
    hitlRequiredCount: 0
  });

  const [scanStatus, setScanStatus] = useState<ScanStatus>({
    isScanning: false,
    currentPortal: null,
    progressPercent: 0,
    completedPortals: 0,
    totalPortals: 17,
    newTendersFound: 0,
    corrigendaFound: 0,
    lastScanTimestamp: null
  });

  // UI Filtering & Navigation States
  const [selectedTrack, setSelectedTrack] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('All');
  const [bookmarkedOnly, setBookmarkedOnly] = useState<boolean>(false);
  const [corrigendumOnly, setCorrigendumOnly] = useState<boolean>(false);
  const [currentView, setCurrentView] = useState<'split' | 'table' | 'kanban'>(() => {
    return (localStorage.getItem('sentinel_currentView') as any) || 'split';
  });

  const handleViewChange = (view: 'split' | 'table' | 'kanban') => {
    setCurrentView(view);
    localStorage.setItem('sentinel_currentView', view);
  };

  // Debounce search query to avoid laggy queries
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Modal & Active Selected Opportunity States
  const [selectedTender, setSelectedTender] = useState<Tender | null>(null);
  const [isTrackModalOpen, setIsTrackModalOpen] = useState<boolean>(false);
  const [isPortalModalOpen, setIsPortalModalOpen] = useState<boolean>(false);

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
      if (selectedTrack !== 'All') params.append('track', selectedTrack);
      if (selectedStatus !== 'All') params.append('status', selectedStatus);
      if (debouncedSearch.trim()) params.append('search', debouncedSearch.trim());
      if (bookmarkedOnly) params.append('bookmarkedOnly', 'true');
      if (corrigendumOnly) params.append('corrigendumOnly', 'true');

      const res = await fetch(`/api/tenders?${params.toString()}`, {
        signal: abortControllerRef.current.signal
      });
      if (res.ok) {
        const data = await res.json();
        setTenders(data);
        if (data.length > 0) {
          setSelectedTender(prev => {
            if (!prev) return data[0];
            const found = data.find((t: Tender) => t.id === prev.id);
            return found || data[0];
          });
        } else {
          setSelectedTender(null);
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Failed to fetch tenders:', err);
      }
    }
  }, [selectedTrack, selectedStatus, debouncedSearch, bookmarkedOnly, corrigendumOnly]);

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
        if (selectedTender?.id === tenderId) {
          setSelectedTender(prev => prev ? { ...prev, pipeline_status: newStatus } : null);
        }
        fetchKpis();
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
        if (selectedTender?.id === tenderId) {
          setSelectedTender(prev => prev ? { ...prev, is_bookmarked: data.is_bookmarked } : null);
        }
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
    if (selectedTender?.id === tenderId) {
      setSelectedTender(prev => prev ? { ...prev, status_notes: notes } : null);
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

  const handleExportCsv = () => {
    const params = new URLSearchParams();
    if (selectedTrack !== 'All') params.append('track', selectedTrack);
    if (selectedStatus !== 'All') params.append('status', selectedStatus);
    if (debouncedSearch.trim()) params.append('search', debouncedSearch.trim());
    if (bookmarkedOnly) params.append('bookmarkedOnly', 'true');
    if (corrigendumOnly) params.append('corrigendumOnly', 'true');

    window.location.href = `/api/export/csv?${params.toString()}`;
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

  const handleSelectTenderById = (tenderId: string) => {
    const found = tenders.find(t => t.id === tenderId);
    if (found) {
      setSelectedTender(found);
      setActiveTab('tenders');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans transition-colors flex flex-col">
      {/* 1. Top KPI & Status Bar */}
      <KpiHeader
        stats={kpiStats}
        scanStatus={scanStatus}
        corrigenda={corrigenda}
        portals={portals}
        isDark={isDark}
        onToggleTheme={() => setIsDark(prev => !prev)}
        onRunScan={() => handleRunScan()}
        onOpenPortalModal={() => setIsPortalModalOpen(true)}
        onAcknowledgeCorrigendum={handleAcknowledgeCorrigendum}
        onLaunchHitl={handleLaunchHitl}
        onSelectTenderById={handleSelectTenderById}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {/* 2. TAB A: Tenders Pipeline View */}
      {activeTab === 'tenders' ? (
        <>
          <TrackFilterBar
            tracks={tracks}
            selectedTrack={selectedTrack}
            onSelectTrack={setSelectedTrack}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            selectedStatus={selectedStatus}
            onStatusChange={setSelectedStatus}
            bookmarkedOnly={bookmarkedOnly}
            onToggleBookmarked={() => setBookmarkedOnly(prev => !prev)}
            corrigendumOnly={corrigendumOnly}
            onToggleCorrigendum={() => setCorrigendumOnly(prev => !prev)}
            currentView={currentView}
            onViewChange={handleViewChange}
            onOpenTrackModal={() => setIsTrackModalOpen(true)}
            onExportCsv={handleExportCsv}
            onClearDatabase={handleClearDatabase}
            isScanning={scanStatus.isScanning}
          />

          <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
            {currentView === 'split' ? (
              <SplitPaneWorkspace
                tenders={tenders}
                selectedTender={selectedTender}
                onSelectTender={setSelectedTender}
                corrigenda={corrigenda}
                onStatusChange={handleUpdateStatus}
                onAcknowledgeCorrigendum={handleAcknowledgeCorrigendum}
                onSaveNotes={handleSaveNotes}
                onToggleBookmark={handleToggleBookmark}
              />
            ) : currentView === 'table' ? (
              <div className="bg-white dark:bg-slate-900 rounded-lg border border-slate-200/80 dark:border-slate-800 shadow-xs overflow-hidden transition-colors">
                <TenderTable
                  tenders={tenders}
                  onSelectTender={setSelectedTender}
                  onUpdateStatus={handleUpdateStatus}
                  onToggleBookmark={handleToggleBookmark}
                />
              </div>
            ) : (
              <div className="bg-white dark:bg-slate-900 rounded-lg border border-slate-200/80 dark:border-slate-800 shadow-xs overflow-hidden transition-colors">
                <TenderKanban
                  tenders={tenders}
                  onSelectTender={setSelectedTender}
                  onUpdateStatus={handleUpdateStatus}
                  onToggleBookmark={handleToggleBookmark}
                />
              </div>
            )}
          </main>
        </>
      ) : (
        /* TAB B: Dedicated Keywords & Portals Settings View */
        <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
          <SettingsWorkspace
            tracks={tracks}
            portals={portals}
            onSaveTrack={handleSaveTrack}
            onDeleteTrack={handleDeleteTrack}
            onUpdatePortal={handleUpdatePortal}
            onLaunchHitl={handleLaunchHitl}
            onVerifyHitl={handleVerifyHitl}
            onScanSinglePortal={handleRunScan}
          />
        </main>
      )}

      {/* Slide-Over Tender Detail Drawer (only for table/kanban view inspection) */}
      {currentView !== 'split' && activeTab === 'tenders' && selectedTender && (
        <TenderDrawer
          tender={selectedTender}
          onClose={() => setSelectedTender(null)}
          onUpdateStatus={handleUpdateStatus}
          onSaveNotes={handleSaveNotes}
        />
      )}

      {/* Modals */}
      <TrackManagerModal
        isOpen={isTrackModalOpen}
        onClose={() => setIsTrackModalOpen(false)}
        tracks={tracks}
        onSaveTrack={handleSaveTrack}
        onDeleteTrack={handleDeleteTrack}
      />

      <PortalHealthModal
        isOpen={isPortalModalOpen}
        onClose={() => setIsPortalModalOpen(false)}
        portals={portals}
        onLaunchHitl={handleLaunchHitl}
        onVerifyHitl={handleVerifyHitl}
        onScanSinglePortal={handleRunScan}
        onUpdatePortal={handleUpdatePortal}
      />
    </div>
  );
}
