import React, { useState } from 'react';
import { X, Plus, Trash2, Check, SlidersHorizontal } from 'lucide-react';
import { DomainTrack } from '../types';

interface TrackManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tracks: DomainTrack[];
  onSaveTrack: (track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[] }) => void;
  onDeleteTrack: (id: string) => void;
}

export const TrackManagerModal: React.FC<TrackManagerModalProps> = ({
  isOpen,
  onClose,
  tracks,
  onSaveTrack,
  onDeleteTrack
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [newTrackName, setNewTrackName] = useState('');
  const [positiveKeywords, setPositiveKeywords] = useState('');
  const [negativeKeywords, setNegativeKeywords] = useState('');

  if (!isOpen) return null;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTrackName.trim()) return;

    onSaveTrack({
      name: newTrackName.trim(),
      positive_keywords: positiveKeywords.split(',').map(s => s.trim()).filter(Boolean),
      negative_keywords: negativeKeywords.split(',').map(s => s.trim()).filter(Boolean)
    });

    setNewTrackName('');
    setPositiveKeywords('');
    setNegativeKeywords('');
    setIsAdding(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[85vh]">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Dynamic Domain Tracks &amp; Keyword Rules
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs flex-1">
          <p className="text-slate-500 dark:text-slate-400">
            Configure target sectors and active search synonyms. Sentinel automatically scans all 16+ procurement portals using these exact terms and excludes notices matching negative keywords.
          </p>

          {/* Add New Track Button / Form */}
          {!isAdding ? (
            <button
              onClick={() => setIsAdding(true)}
              className="w-full py-2.5 px-3 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 text-blue-600 dark:text-blue-400 font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Create New Domain Track</span>
            </button>
          ) : (
            <form onSubmit={handleCreate} className="p-4 rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50/30 dark:bg-blue-950/20 space-y-3">
              <h4 className="font-semibold text-slate-900 dark:text-white">New Domain Track</h4>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Domain Name
                </label>
                <input
                  type="text"
                  required
                  value={newTrackName}
                  onChange={e => setNewTrackName(e.target.value)}
                  placeholder="e.g. Media Production, Documentary & Communications"
                  className="w-full p-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Positive Keywords (comma-separated synonyms)
                </label>
                <input
                  type="text"
                  required
                  value={positiveKeywords}
                  onChange={e => setPositiveKeywords(e.target.value)}
                  placeholder="e.g. documentary, video production, animation, advocacy campaign"
                  className="w-full p-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Negative Keywords (comma-separated exclusions)
                </label>
                <input
                  type="text"
                  value={negativeKeywords}
                  onChange={e => setNegativeKeywords(e.target.value)}
                  placeholder="e.g. cctv, surveillance camera"
                  className="w-full p-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1 shadow-sm"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Save Track</span>
                </button>
              </div>
            </form>
          )}

          {/* Current Tracks List */}
          <div className="space-y-2.5">
            {tracks.map(track => (
              <div
                key={track.id}
                className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/80 flex items-start justify-between gap-3 shadow-xs"
              >
                <div>
                  <div className="font-semibold text-slate-900 dark:text-white text-xs">
                    {track.name}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
                    <strong className="text-slate-700 dark:text-slate-300">Matching:</strong> {track.positive_keywords.join(' · ')}
                  </div>
                  {track.negative_keywords && track.negative_keywords.length > 0 && (
                    <div className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                      <strong>Excluding:</strong> {track.negative_keywords.join(', ')}
                    </div>
                  )}
                </div>

                <button
                  onClick={() => onDeleteTrack(track.id)}
                  title="Delete Track"
                  className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-slate-400 hover:text-red-600 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-900 dark:bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 dark:hover:bg-slate-700 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
