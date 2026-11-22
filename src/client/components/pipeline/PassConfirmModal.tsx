import React from 'react';
import { AlertCircle } from 'lucide-react';
import { Tender, CachedDossier } from '../../../shared/types';
import { Button, Dialog } from '../../ui';
import { asList } from '../../utils/format';

interface PassConfirmModalProps {
  tender: Tender;
  isOpen: boolean;
  onClose: () => void;
  onConfirmPass: (tenderId: string) => Promise<void>;
}

export function PassConfirmModal({ tender, isOpen, onClose, onConfirmPass }: PassConfirmModalProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const dossiers = asList<CachedDossier>(tender.cached_dossiers);
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
    <Dialog
      open={isOpen}
      onClose={onClose}
      title="Pass Active Bid Pursuit?"
      subtitle={`Currently tracked in ${tender.pipeline_status}`}
      icon={
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-warn-soft text-warn">
          <AlertCircle className="h-5 w-5" />
        </div>
      }
      footer={
        <>
          <Button variant="secondary" autoFocus onClick={onClose} disabled={isSubmitting}>
            Keep Tracking
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={isSubmitting}>
            {isSubmitting ? 'Passing...' : 'Pass & Remove Files'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs text-ink-muted">
        <div className="rounded-xl border border-line bg-surface-2 p-3">
          <div className="font-semibold text-ink line-clamp-2">{tender.title}</div>
          <div className="mt-1 flex items-center gap-2 text-ink-muted">
            <span>Ref: {tender.reference_no || 'N/A'}</span>
            <span>•</span>
            <span>{tender.portal_name}</span>
          </div>
        </div>

        <p>
          This tender has <strong className="font-semibold text-ink">{dossiers.length} cached file(s)</strong>
          {hasNotes ? ' and operator notes' : ''}.
        </p>
        <p className="font-medium text-warn">
          Passing will archive this tender into the Passed list, slim its record, and permanently delete its cached files and private notes after 2 minutes.
        </p>
      </div>
    </Dialog>
  );
}
