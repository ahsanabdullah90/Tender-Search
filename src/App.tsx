import React, { useState, useEffect, useCallback } from 'react';
import { KpiHeader } from './components/KpiHeader';
import { TrackFilterBar } from './components/TrackFilterBar';
import { SplitPaneWorkspace } from './components/SplitPaneWorkspace';
import { TenderTable } from './components/TenderTable';
import { TenderKanban } from './components/TenderKanban';
import { TenderDrawer } from './components/TenderDrawer';
import { TrackManagerModal } from './components/TrackManagerModal';
import { PortalHealthModal } from './components/PortalHealthModal';
import { Tender, DomainTrack, PortalHealth, CorrigendumLog, ScanStatus, OpportunityStatus } from './types';

export default function App() {
  // Theme State
  const [isDark, setIsDark] = useState<boolean>(() => {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

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
    totalPortals: 16,
    onlinePortals: 16,
    hitlRequiredCount: 0
  });

  const [scanStatus, setScanStatus] = useState<ScanStatus>({
    isScanning: false,
    currentPortal: null,
    progressPercent: 0,
    completedPortals: 0,
    totalPortals: 16,
    newTendersFound: 0,
    corrigendaFound: 0,
    lastScanTimestamp: null
  });

  // UI Filtering & Navigation States (Defaulting to Split-Pane Command Center)
  const [selectedTrack, setSelectedTrack] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('All');
  const [bookmarkedOnly, setBookmarkedOnly] = useState<boolean>(false);
  const [corrigendumOnly, setCorrigendumOnly] = useState<boolean>(false);
  const [currentView, setCurrentView] = useState<'split' | 'table' | 'kanban'>('split');

  // Modal & Active Selected Opportunity States
  const [selectedTender, setSelectedTender] = useState<Tender | null>(null);
  const [isTrackModalOpen, setIsTrackModalOpen] = useState<boolean>(false);
  const [isPortalModalOpen, setIsPortalModalOpen] = useState<boolean>(false);

  // Data Fetchers
  const fetchTenders = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedTrack !== 'All') params.append('track', selectedTrack);
      if (selectedStatus !== 'All') params.append('status', selectedStatus);
      if (searchQuery.trim()) params.append('search', searchQuery.trim());
      if (bookmarkedOnly) params.append('bookmarkedOnly', 'true');
      if (corrigendumOnly) params.append('corrigendumOnly', 'true');

      const res = await fetch(`/api/tenders?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setTenders(data);
        // If current selected tender is not in the new filtered list, update to first available or keep if present
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
    } catch (err) {
      console.error('Failed to fetch tenders:', err);
    }
  }, [selectedTrack, selectedStatus, searchQuery, bookmarkedOnly, corrigendumOnly]);

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
    const eventSource = new EventSource('/api/scan/progress');

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'scan_progress') {
          setScanStatus(data.status);
        } else if (data.type === 'scan_complete') {
          setScanStatus(data.status);
          fetchTenders();
          fetchPortals();
          fetchCorrigenda();
          fetchKpis();
        } else if (data.type === 'hitl_required') {
          fetchPortals();
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
      const endpoint = portalId ? `/api/scan/start?portalId=${portalId}` : '/api/scan/start';
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.ok) {
        setScanStatus(prev => ({ ...prev, isScanning: true }));
      }
    } catch (err) {
      console.error('Failed to trigger scan:', err);
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

  const handleToggleBookmark = async (tenderId: string, currentVal?: boolean) => {
    try {
      const res = await fetch(`/api/tenders/${tenderId}/bookmark`, { method: 'POST' });
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

  const handleSaveNotes = async (tenderId: string, notes: string) => {
    try {
      const res = await fetch(`/api/tenders/${tenderId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes })
      });
      if (res.ok) {
        setTenders(prev =>
          prev.map(t => (t.id === tenderId ? { ...t, status_notes: notes } : t))
        );
        if (selectedTender?.id === tenderId) {
          setSelectedTender(prev => prev ? { ...prev, status_notes: notes } : null);
        }
      }
    } catch (err) {
      console.error('Failed to save notes:', err);
    }
  };

  const handleAcknowledgeCorrigendum = async (logId: string) => {
    try {
      const res = await fetch(`/api/corrigenda/${logId}/ack`, { method: 'POST' });
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
      setIsPortalModalOpen(true);
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
      }
    } catch (err) {
      console.error('Failed to save track:', err);
    }
  };

  const handleDeleteTrack = async (id: string) => {
    try {
      const res = await fetch(`/api/tracks/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchTracks();
      }
    } catch (err) {
      console.error('Failed to delete track:', err);
    }
  };

  const handleExportCsv = () => {
    window.location.href = '/api/export/csv';
  };

  const handleClearDatabase = async () => {
    try {
      const res = await fetch('/api/tenders/clear', { method: 'POST' });
      if (res.ok) {
        setTenders([]);
        setSelectedTender(null);
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
      />

      {/* 2. Dynamic Domain Track Selector & Filtering Bar */}
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
        onViewChange={setCurrentView}
        onOpenTrackModal={() => setIsTrackModalOpen(true)}
        onExportCsv={handleExportCsv}
        onClearDatabase={handleClearDatabase}
      />

      {/* 3. Main Operational Viewport */}
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

      {/* 4. Slide-Over Tender Detail Drawer (only for table/kanban view inspection) */}
      {currentView !== 'split' && selectedTender && (
        <TenderDrawer
          tender={selectedTender}
          onClose={() => setSelectedTender(null)}
          onUpdateStatus={handleUpdateStatus}
          onSaveNotes={handleSaveNotes}
        />
      )}

      {/* 5. Dynamic Track & Keyword Manager Modal */}
      <TrackManagerModal
        isOpen={isTrackModalOpen}
        onClose={() => setIsTrackModalOpen(false)}
        tracks={tracks}
        onSaveTrack={handleSaveTrack}
        onDeleteTrack={handleDeleteTrack}
      />

      {/* 6. Portal Health & HITL Browser Verification Modal */}
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
