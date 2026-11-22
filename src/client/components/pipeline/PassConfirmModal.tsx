import React from 'react';
import { AlertCircle, X } from 'lucide-react';
import { Tender, CachedDossier } from '../../../shared/types';
import { Button } from '../../ui';

interface PassConfirmModalProps {
  tender: Tender;
  isOpen: boolean;
  onClose: () => void;
  onConfirmPass: (tenderId: string) => Promise<void>;
}

export function PassConfirmModal({ tender, isOpen, onClose, onConfirmPass }: PassConfirmModalProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  if (!isOpen) return null;

  const dossiers: CachedDossier[] = Array.isArray(tender.cached_dossiers) ? tender.cached_dossiers : [];
  const hasNotes = Boolean(tender.status_notes && tender.status_notes.trim());

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirmPass(tender.id);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-warn-soft text-warn">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-ink">Pass Active Bid Pursuit?</h3>
              <p className="text-xs text-ink-muted">Currently tracked in {tender.pipeline_status}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-line bg-surface-2 p-3 text-xs">
          <div className="font-semibold text-ink line-clamp-2">{tender.title}</div>
          <div className="mt-1 flex items-center gap-2 text-ink-muted">
            <span>Ref: {tender.reference_no || 'N/A'}</span>
            <span>•</span>
            <span>{tender.portal_name}</span>
          </div>
        </div>

        <div className="mt-3 text-xs text-ink-muted space-y-2">
          <p>
            This tender has <strong className="text-ink font-semibold">{dossiers.length} cached file(s)</strong>
            {hasNotes ? ' and operator notes' : ''}.
          </p>
          <p className="text-warn font-medium">
            Passing will archive this tender into the Passed list, slim its record, and permanently delete its cached files and private notes after 2 minutes.
          </p>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Keep Tracking
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={isSubmitting}>
            {isSubmitting ? 'Passing...' : 'Pass & Remove Files'}
          </Button>
        </div>
      </div>
    </div>
  );
}
