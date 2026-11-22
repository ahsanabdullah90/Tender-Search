import { useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Tender, CachedDossier } from '../../../shared/types';
import { Button, Dialog } from '../../ui';
import { asList, formatMegabytes } from '../../utils/format';

interface DeleteTenderModalProps {
  tender: Tender;
  isOpen: boolean;
  onClose: () => void;
  onConfirmDelete: (tenderId: string) => Promise<void>;
}

export function DeleteTenderModal({ tender, isOpen, onClose, onConfirmDelete }: DeleteTenderModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dossiers = asList<CachedDossier>(tender.cached_dossiers);
  const totalSizeBytes = dossiers.reduce((acc, d) => acc + (d.sizeBytes || 0), 0);
  const totalSizeMB = formatMegabytes(totalSizeBytes);

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await onConfirmDelete(tender.id);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete tender.');
      setIsDeleting(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title="Delete Tender Permanently?"
      subtitle="This action cannot be undone."
      icon={
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-danger-soft text-danger">
          <AlertTriangle className="h-5 w-5" />
        </div>
      }
      footer={
        <>
          <Button variant="secondary" autoFocus onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={isDeleting} className="gap-1.5">
            <Trash2 className="h-4 w-4" />
            {isDeleting ? 'Deleting...' : 'Delete Permanently'}
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
          This will permanently remove the tender from your database along with{' '}
          <strong className="font-semibold text-ink">{dossiers.length} document(s) ({totalSizeMB} MB)</strong> from disk.
        </p>

        <div className="rounded-lg bg-surface-2/60 p-2 text-[11px] leading-relaxed text-ink-muted">
          🛡️ <strong>Scraper suppression guard:</strong> This tender will be recorded in your suppression list and will not be re-imported during future automated scans.
        </div>

        {error && (
          <div className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
