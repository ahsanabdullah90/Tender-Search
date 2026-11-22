import { useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { Tender, CachedDossier } from '../../../shared/types';
import { Button } from '../../ui';

interface DeleteTenderModalProps {
  tender: Tender;
  isOpen: boolean;
  onClose: () => void;
  onConfirmDelete: (tenderId: string) => Promise<void>;
}

export function DeleteTenderModal({ tender, isOpen, onClose, onConfirmDelete }: DeleteTenderModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const dossiers: CachedDossier[] = Array.isArray(tender.cached_dossiers) ? tender.cached_dossiers : [];
  const totalSizeBytes = dossiers.reduce((acc, d) => acc + (d.sizeBytes || 0), 0);
  const totalSizeMB = (totalSizeBytes / (1024 * 1024)).toFixed(2);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-danger-soft text-danger">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-ink">Delete Tender Permanently?</h3>
              <p className="text-xs text-ink-muted">This action cannot be undone.</p>
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

        <div className="mt-3 space-y-2 text-xs text-ink-muted">
          <p>
            This will permanently remove the tender from your database along with{' '}
            <strong className="text-ink font-semibold">{dossiers.length} document(s) ({totalSizeMB} MB)</strong> from disk.
          </p>
          <div className="rounded-lg bg-surface-2/60 p-2 text-[11px] leading-relaxed text-ink-muted">
            🛡️ <strong>Scraper suppression guard:</strong> This tender will be recorded in your suppression list and will not be re-imported during future automated scans.
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-lg bg-danger-soft p-2.5 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={isDeleting} className="gap-1.5">
            <Trash2 className="h-4 w-4" />
            {isDeleting ? 'Deleting...' : 'Delete Permanently'}
          </Button>
        </div>
      </div>
    </div>
  );
}
