import React, { useState } from 'react';
import { 
  SlidersHorizontal, Plus, Trash2, Edit2, Check, X, ExternalLink, RefreshCw, 
  CheckCircle2, AlertTriangle, AlertOctagon, Radio, Globe, Shield, Search
} from 'lucide-react';
import { DomainTrack, PortalHealth } from '../types';

interface SettingsWorkspaceProps {
  tracks: DomainTrack[];
  portals: PortalHealth[];
  onSaveTrack: (track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[] }) => void;
  onDeleteTrack: (id: string) => void;
  onUpdatePortal: (portalId: string, updates: Partial<PortalHealth>) => void;
  onLaunchHitl: (portalId: string) => void;
  onVerifyHitl: (portalId: string) => void;
  onScanSinglePortal: (portalId: string) => void;
}

export const SettingsWorkspace: React.FC<SettingsWorkspaceProps> = ({
  tracks,
  portals,
  onSaveTrack,
  onDeleteTrack,
  onUpdatePortal,
  onLaunchHitl,
  onVerifyHitl,
  onScanSinglePortal
}) => {
  const [activeSection, setActiveSection] = useState<'keywords' | 'portals'>('keywords');

  // Track editing state
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [trackForm, setTrackForm] = useState({
    id: '',
    name: '',
    positive: '',
    negative: ''
  });

  // Portal editing state
  const [editingPortalId, setEditingPortalId] = useState<string | null>(null);
  const [portalForm, setPortalForm] = useState({
    portal_name: '',
    tenders_url: '',
    base_url: '',
    tier: 'http' as 'playwright' | 'http',
    access_mode: 'public' as 'public' | 'login_required' | 'cloudflare' | 'offline_broken',
    verified_status: ''
  });

  const [portalSearch, setPortalSearch] = useState('');

  // Handle Track Create / Edit
  const handleStartAddTrack = () => {
    setEditingTrackId(null);
    setTrackForm({ id: '', name: '', positive: '', negative: '' });
    setIsAddingTrack(true);
  };

  const handleStartEditTrack = (t: DomainTrack) => {
    setEditingTrackId(t.id);
    setTrackForm({
      id: t.id,
      name: t.name,
      positive: t.positive_keywords.join(', '),
      negative: t.negative_keywords.join(', ')
    });
    setIsAddingTrack(true);
  };

  const handleSaveTrackSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trackForm.name.trim()) return;

    onSaveTrack({
      id: trackForm.id || undefined,
      name: trackForm.name.trim(),
      positive_keywords: trackForm.positive.split(',').map(s => s.trim()).filter(Boolean),
      negative_keywords: trackForm.negative.split(',').map(s => s.trim()).filter(Boolean)
    });

    setIsAddingTrack(false);
    setEditingTrackId(null);
    setTrackForm({ id: '', name: '', positive: '', negative: '' });
  };

  // Handle Portal Edit
  const handleStartEditPortal = (p: PortalHealth) => {
    setEditingPortalId(p.portal_id);
    setPortalForm({
      portal_name: p.portal_name,
      tenders_url: p.tenders_url,
      base_url: p.base_url,
      tier: p.tier,
      access_mode: p.access_mode || 'public',
      verified_status: p.verified_status || ''
    });
  };

  const handleSavePortalSubmit = (portalId: string) => {
    onUpdatePortal(portalId, portalForm);
    setEditingPortalId(null);
  };

  const filteredPortals = portals.filter(p => 
    p.portal_name.toLowerCase().includes(portalSearch.toLowerCase()) ||
    p.category.toLowerCase().includes(portalSearch.toLowerCase()) ||
    (p.access_mode && p.access_mode.toLowerCase().includes(portalSearch.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      {/* Sub-Header Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            Command Center Settings
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Manage target procurement domain keywords and monitor statutory government portals.
          </p>
        </div>

        <div className="flex items-center gap-1.5 p-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs shadow-xs">
          <button
            onClick={() => setActiveSection('keywords')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold transition-all cursor-pointer ${
              activeSection === 'keywords'
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Domain Tracks &amp; Keywords ({tracks.length})</span>
          </button>
          <button
            onClick={() => setActiveSection('portals')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold transition-all cursor-pointer ${
              activeSection === 'portals'
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Portals &amp; Health ({portals.length})</span>
          </button>
        </div>
      </div>

      {/* SECTION 1: KEYWORDS & TRACKS */}
      {activeSection === 'keywords' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Active Domain Tracks
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Notices matching positive keywords are tagged and prioritized; negative keywords filter out noise.
              </p>
            </div>
            {!isAddingTrack && (
              <button
                onClick={handleStartAddTrack}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-slate-200 text-white dark:text-slate-900 text-xs font-semibold rounded-lg shadow-xs cursor-pointer transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Domain Track</span>
              </button>
            )}
          </div>

          {/* Add / Edit Track Form */}
          {isAddingTrack && (
            <form onSubmit={handleSaveTrackSubmit} className="p-4 rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50/20 dark:bg-blue-950/20 space-y-3 text-xs">
              <div className="flex items-center justify-between border-b border-blue-200/60 dark:border-blue-800/60 pb-2">
                <span className="font-bold text-slate-900 dark:text-white">
                  {editingTrackId ? 'Edit Domain Track' : 'Create New Domain Track'}
                </span>
                <button
                  type="button"
                  onClick={() => setIsAddingTrack(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Domain Name
                </label>
                <input
                  type="text"
                  required
                  value={trackForm.name}
                  onChange={e => setTrackForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Media Production, Documentary & Communications"
                  className="w-full p-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-hidden focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Positive Keywords (comma-separated synonyms)
                </label>
                <input
                  type="text"
                  required
                  value={trackForm.positive}
                  onChange={e => setTrackForm(prev => ({ ...prev, positive: e.target.value }))}
                  placeholder="e.g. documentary, video production, animation, digital communications"
                  className="w-full p-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-hidden focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Negative Keywords (comma-separated exclusions)
                </label>
                <input
                  type="text"
                  value={trackForm.negative}
                  onChange={e => setTrackForm(prev => ({ ...prev, negative: e.target.value }))}
                  placeholder="e.g. cctv, surveillance camera"
                  className="w-full p-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-hidden focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsAddingTrack(false)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1.5 shadow-xs"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Save Track</span>
                </button>
              </div>
            </form>
          )}

          {/* Tracks Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {tracks.map(track => (
              <div
                key={track.id}
                className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between gap-3 shadow-xs"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-bold text-slate-900 dark:text-white text-xs">
                      {track.name}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleStartEditTrack(track)}
                        title="Edit Track"
                        className="p-1 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteTrack(track.id)}
                        title="Delete Track"
                        className="p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">Matching:</span>{' '}
                    <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400">
                      {track.positive_keywords.join(' · ')}
                    </span>
                  </div>

                  {track.negative_keywords && track.negative_keywords.length > 0 && (
                    <div className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                      <span className="font-semibold">Excluding:</span>{' '}
                      <span className="font-mono text-[11px]">
                        {track.negative_keywords.join(', ')}
                      </span>
                    </div>
                  )}
                </div>

                <div className="text-[10px] text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <span>Track ID: {track.id}</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">&check; Active</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SECTION 2: PORTALS & HEALTH */}
      {activeSection === 'portals' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Procurement Authorities &amp; Scraper Tiers
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                16+ monitored statutory boards across Pakistan and international agencies.
              </p>
            </div>

            <div className="relative min-w-[240px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={portalSearch}
                onChange={e => setPortalSearch(e.target.value)}
                placeholder="Filter portals..."
                className="w-full pl-8 pr-3 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
              />
            </div>
          </div>

          {/* Portals Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            {filteredPortals.map(portal => {
              const isEditing = editingPortalId === portal.portal_id;
              const isHitl = portal.status === 'hitl_required';
              const isBroken = portal.status === 'selector_broken';
              const isScanning = portal.status === 'scanning';

              if (isEditing) {
                return (
                  <div
                    key={portal.portal_id}
                    className="p-4 rounded-xl border border-blue-400 dark:border-blue-600 bg-blue-50/20 dark:bg-blue-950/20 space-y-2.5 shadow-xs"
                  >
                    <div className="flex items-center justify-between border-b border-blue-200 dark:border-blue-800 pb-2">
                      <span className="font-bold text-slate-900 dark:text-white">
                        Edit: {portal.portal_name}
                      </span>
                      <button onClick={() => setEditingPortalId(null)} className="text-slate-400 hover:text-slate-600">
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                        Direct Procurement / Tender URL
                      </label>
                      <input
                        type="url"
                        value={portalForm.tenders_url}
                        onChange={e => setPortalForm(prev => ({ ...prev, tenders_url: e.target.value }))}
                        className="w-full p-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-[11px]"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                          Crawler Tier
                        </label>
                        <select
                          value={portalForm.tier}
                          onChange={e => setPortalForm(prev => ({ ...prev, tier: e.target.value as any }))}
                          className="w-full p-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                        >
                          <option value="http">Fast HTTP (Tolerant TLS)</option>
                          <option value="playwright">Playwright Stealth Context</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                          Access Mode
                        </label>
                        <select
                          value={portalForm.access_mode}
                          onChange={e => setPortalForm(prev => ({ ...prev, access_mode: e.target.value as any }))}
                          className="w-full p-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                        >
                          <option value="public">Public (No Login)</option>
                          <option value="login_required">🔒 Login Required (EPMS)</option>
                          <option value="cloudflare">🛡️ Cloudflare Bot-Shield</option>
                          <option value="offline_broken">⚠️ Host / SSL Down</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setEditingPortalId(null)}
                        className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSavePortalSubmit(portal.portal_id)}
                        className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1 shadow-xs"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Save Changes</span>
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={portal.portal_id}
                  className={`p-4 rounded-xl border transition-all ${
                    isHitl
                      ? 'border-purple-300 dark:border-purple-800 bg-purple-50/20 dark:bg-purple-950/20'
                      : isBroken
                      ? 'border-amber-300 dark:border-amber-800 bg-amber-50/20 dark:bg-amber-950/20'
                      : portal.status === 'error'
                      ? 'border-red-300 dark:border-red-900 bg-red-50/20 dark:bg-red-950/20'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-slate-900 dark:text-white text-xs">
                          {portal.portal_name}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                          {portal.category}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex flex-wrap items-center gap-1.5">
                        <span>Tier: <strong className="font-mono">{portal.tier.toUpperCase()}</strong></span>
                        <span>·</span>
                        <span>Found: <strong className="font-mono">{portal.last_items_found} live</strong></span>
                        {portal.access_mode === 'login_required' && (
                          <span className="text-[10px] font-semibold text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/60 px-1.5 py-0.2 rounded border border-purple-200 dark:border-purple-800">
                            🔒 Login Required
                          </span>
                        )}
                        {portal.access_mode === 'offline_broken' && (
                          <span className="text-[10px] font-semibold text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/60 px-1.5 py-0.2 rounded border border-rose-200 dark:border-rose-800">
                            ⚠️ Domain / SSL Down
                          </span>
                        )}
                      </div>
                      {portal.verified_status && (
                        <div className="mt-1.5 text-[10.5px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/80 p-1.5 rounded border border-slate-200/60 dark:border-slate-700/60">
                          {portal.verified_status}
                        </div>
                      )}
                    </div>

                    {/* Status Badge */}
                    <div className="shrink-0">
                      {isHitl ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300">
                          <AlertOctagon className="w-3 h-3" />
                          HITL Required
                        </span>
                      ) : isBroken ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="w-3 h-3" />
                          Layout Check
                        </span>
                      ) : isScanning ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 animate-pulse">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          Scanning
                        </span>
                      ) : portal.status === 'error' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
                          <AlertOctagon className="w-3 h-3" />
                          Unreachable
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="w-3 h-3" />
                          Online
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                    <a
                      href={portal.tenders_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1 text-[11px]"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>Direct Portal Link</span>
                    </a>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleStartEditPortal(portal)}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium text-[11px] flex items-center gap-1 cursor-pointer"
                      >
                        <Edit2 className="w-3 h-3" />
                        <span>Edit</span>
                      </button>

                      {isHitl ? (
                        <>
                          <button
                            onClick={() => onLaunchHitl(portal.portal_id)}
                            className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded font-medium text-[11px] shadow-xs cursor-pointer"
                          >
                            Launch Browser
                          </button>
                          <button
                            onClick={() => onVerifyHitl(portal.portal_id)}
                            className="px-2 py-1 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 text-slate-800 dark:text-slate-200 rounded font-medium text-[11px] cursor-pointer"
                          >
                            Verify &amp; Resume
                          </button>
                        </>
                      ) : (
                        <>
                          {portal.tier === 'playwright' && (
                            <button
                              onClick={() => onLaunchHitl(portal.portal_id)}
                              title="Open persistent browser to log in or update credentials"
                              className="px-2 py-1 rounded border border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/40 font-medium text-[11px] flex items-center gap-1 cursor-pointer"
                            >
                              <span>Browser / Login</span>
                            </button>
                          )}
                          <button
                            onClick={() => onScanSinglePortal(portal.portal_id)}
                            className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium text-[11px] flex items-center gap-1 cursor-pointer"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>Scan</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
