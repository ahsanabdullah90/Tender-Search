import React, { useState } from 'react';
import { X, ExternalLink, RefreshCw, CheckCircle2, AlertTriangle, AlertOctagon, Radio, Edit2, Check, Globe } from 'lucide-react';
import { PortalHealth } from '../types';

interface PortalHealthModalProps {
  isOpen: boolean;
  onClose: () => void;
  portals: PortalHealth[];
  onLaunchHitl: (portalId: string) => void;
  onVerifyHitl: (portalId: string) => void;
  onScanSinglePortal: (portalId: string) => void;
  onUpdatePortal?: (portalId: string, updates: Partial<PortalHealth>) => void;
}

export const PortalHealthModal: React.FC<PortalHealthModalProps> = ({
  isOpen,
  onClose,
  portals,
  onLaunchHitl,
  onVerifyHitl,
  onScanSinglePortal,
  onUpdatePortal
}) => {
  const [editingPortalId, setEditingPortalId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    portal_name: string;
    tenders_url: string;
    base_url: string;
    tier: 'playwright' | 'http';
    access_mode: 'public' | 'login_required' | 'cloudflare' | 'offline_broken';
    verified_status: string;
  }>({
    portal_name: '',
    tenders_url: '',
    base_url: '',
    tier: 'http',
    access_mode: 'public',
    verified_status: ''
  });

  if (!isOpen) return null;

  const startEditing = (p: PortalHealth) => {
    setEditingPortalId(p.portal_id);
    setEditForm({
      portal_name: p.portal_name,
      tenders_url: p.tenders_url,
      base_url: p.base_url,
      tier: p.tier,
      access_mode: p.access_mode || 'public',
      verified_status: p.verified_status || ''
    });
  };

  const handleSaveEdit = (portalId: string) => {
    if (onUpdatePortal) {
      onUpdatePortal(portalId, editForm);
    }
    setEditingPortalId(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
      <div className="w-full max-w-4xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Radio className="w-4 h-4 text-blue-600" />
              <span>Procurement Sentinel Portals &amp; URL Configuration</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Edit live URLs, access modes, scraper tiers (Playwright/HTTP), and test connectivity across all 16+ portals.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-5 overflow-y-auto space-y-3 flex-1 text-xs">
          {/* Status Legend Strip */}
          <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-[11px]">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-semibold">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span> Verified Working
              </span>
              <span className="flex items-center gap-1 text-purple-700 dark:text-purple-400 font-semibold">
                <span className="w-2 h-2 rounded-full bg-purple-500"></span> 🔒 Login Required (EPMS)
              </span>
              <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400 font-semibold">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span> ⚠️ Partial / Cloudflare
              </span>
              <span className="flex items-center gap-1 text-red-700 dark:text-red-400 font-semibold">
                <span className="w-2 h-2 rounded-full bg-red-500"></span> ❌ Domain Down / Expired TLS
              </span>
            </div>
            <span className="text-slate-400 font-mono text-[10px]">Click "Edit" on any portal to adjust URL</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {portals.map(portal => {
              const isEditing = editingPortalId === portal.portal_id;
              const isHitl = portal.status === 'hitl_required';
              const isBroken = portal.status === 'selector_broken';
              const isScanning = portal.status === 'scanning';

              if (isEditing) {
                return (
                  <div
                    key={portal.portal_id}
                    className="p-3.5 rounded-xl border border-blue-400 dark:border-blue-600 bg-blue-50/20 dark:bg-blue-950/20 shadow-xs space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-blue-200 dark:border-blue-800/60 pb-2">
                      <span className="font-bold text-slate-900 dark:text-white text-xs">
                        Edit: {portal.portal_name}
                      </span>
                      <button
                        onClick={() => setEditingPortalId(null)}
                        className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div>
                      <label className="block text-[10.5px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                        Portal Display Name
                      </label>
                      <input
                        type="text"
                        value={editForm.portal_name}
                        onChange={e => setEditForm(prev => ({ ...prev, portal_name: e.target.value }))}
                        className="w-full p-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                      />
                    </div>

                    <div>
                      <label className="block text-[10.5px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                        Direct Tenders / Procurement URL
                      </label>
                      <input
                        type="url"
                        value={editForm.tenders_url}
                        onChange={e => setEditForm(prev => ({ ...prev, tenders_url: e.target.value }))}
                        className="w-full p-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-[11px]"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10.5px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                          Crawler Tier
                        </label>
                        <select
                          value={editForm.tier}
                          onChange={e => setEditForm(prev => ({ ...prev, tier: e.target.value as any }))}
                          className="w-full p-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                        >
                          <option value="http">Fast HTTP (Tolerant TLS)</option>
                          <option value="playwright">Playwright Stealth Context</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10.5px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                          Access Mode
                        </label>
                        <select
                          value={editForm.access_mode}
                          onChange={e => setEditForm(prev => ({ ...prev, access_mode: e.target.value as any }))}
                          className="w-full p-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                        >
                          <option value="public">Public (No Login)</option>
                          <option value="login_required">🔒 Login Required</option>
                          <option value="cloudflare">🛡️ Cloudflare Bot-Shield</option>
                          <option value="offline_broken">⚠️ Host / SSL Down</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10.5px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                        Status / Operator Notes
                      </label>
                      <input
                        type="text"
                        value={editForm.verified_status}
                        onChange={e => setEditForm(prev => ({ ...prev, verified_status: e.target.value }))}
                        placeholder="e.g. Working — 865 live tenders"
                        className="w-full p-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-[11px]"
                      />
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
                        onClick={() => handleSaveEdit(portal.portal_id)}
                        className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1 shadow-sm"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Save Portal</span>
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={portal.portal_id}
                  className={`p-3.5 rounded-xl border transition-all ${
                    isHitl
                      ? 'border-purple-300 dark:border-purple-800 bg-purple-50/30 dark:bg-purple-950/20'
                      : isBroken
                      ? 'border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20'
                      : portal.status === 'error'
                      ? 'border-red-300 dark:border-red-900 bg-red-50/40 dark:bg-red-950/20'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/60 shadow-xs'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-slate-900 dark:text-white text-xs">
                          {portal.portal_name}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                          {portal.category}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span>Tier: <strong className="font-mono">{portal.tier.toUpperCase()}</strong></span>
                        <span>·</span>
                        <span>Found: <strong className="font-mono">{portal.last_items_found} live</strong></span>
                        {portal.access_mode === 'login_required' && (
                          <span className="text-[10px] font-semibold text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/60 px-1.5 py-0.2 rounded border border-purple-200 dark:border-purple-800">
                            🔒 Login Required
                          </span>
                        )}
                        {portal.access_mode === 'cloudflare' && (
                          <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/60 px-1.5 py-0.2 rounded border border-amber-200 dark:border-amber-800">
                            🛡️ Cloudflare Bot-Shield
                          </span>
                        )}
                        {portal.access_mode === 'offline_broken' && (
                          <span className="text-[10px] font-semibold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/60 px-1.5 py-0.2 rounded border border-red-200 dark:border-red-800">
                            ⚠️ Domain / SSL Issue
                          </span>
                        )}
                      </div>
                      {portal.verified_status && (
                        <div className="mt-1.5 text-[10.5px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/80 p-1.5 rounded border border-slate-200/60 dark:border-slate-700/60">
                          <strong className="text-slate-700 dark:text-slate-200">Status:</strong> {portal.verified_status}
                        </div>
                      )}
                    </div>

                    {/* Status Badge */}
                    <div className="shrink-0">
                      {isHitl ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300">
                          <AlertOctagon className="w-3 h-3" />
                          Credentials / HITL
                        </span>
                      ) : isBroken ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="w-3 h-3" />
                          Partial / Check
                        </span>
                      ) : isScanning ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 animate-pulse">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          Crawling
                        </span>
                      ) : portal.status === 'error' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
                          <AlertOctagon className="w-3 h-3" />
                          Unreachable
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="w-3 h-3" />
                          Verified Active
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions / HITL Launcher & Edit Button */}
                  <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-700/60 flex items-center justify-between gap-2">
                    <a
                      href={portal.tenders_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1 text-[11px]"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>Direct Tender Link</span>
                    </a>

                    <div className="flex items-center gap-1.5">
                      {/* Edit Button */}
                      <button
                        onClick={() => startEditing(portal)}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 font-medium text-[11px] flex items-center gap-1 cursor-pointer"
                        title="Edit portal URL, tier, or status"
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
                        <button
                          onClick={() => onScanSinglePortal(portal.portal_id)}
                          className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 font-medium text-[11px] flex items-center gap-1 cursor-pointer"
                        >
                          <RefreshCw className="w-3 h-3" />
                          <span>Scan</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-900 dark:bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
