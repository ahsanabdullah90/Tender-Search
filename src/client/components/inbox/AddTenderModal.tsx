import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Tender } from '../../../shared/types';
import { Button, Dialog, FIELD_INPUT_CLASS } from '../../ui';
import { apiMutate } from '../../utils/apiClient';
import { fileToBase64 } from '../../utils/format';

interface AddTenderModalProps {
  open: boolean;
  onClose: () => void;
  onTenderCreated?: (tender: Tender) => void;
}

export function AddTenderModal({ open, onClose, onTenderCreated }: AddTenderModalProps) {
  const [creatingManual, setCreatingManual] = useState(false);
  const [extractingManualAi, setExtractingManualAi] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualFile, setManualFile] = useState<{ filename: string; mimeType: string; dataBase64: string } | null>(null);
  const [manualForm, setManualForm] = useState({
    title: '',
    organization: '',
    reference_no: '',
    closing_date: '',
    estimated_value: '',
    portal_name: 'Manual Entry',
    direct_url: '',
    description: '',
  });

  const resetForm = () => {
    setManualFile(null);
    setManualError(null);
    setManualForm({
      title: '',
      organization: '',
      reference_no: '',
      closing_date: '',
      estimated_value: '',
      portal_name: 'Manual Entry',
      direct_url: '',
      description: '',
    });
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleManualFilePicked = async (file: File) => {
    setManualError(null);
    try {
      const b64 = await fileToBase64(file);
      setManualFile({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64: b64,
      });
    } catch {
      setManualError('Could not read the uploaded file.');
    }
  };

  const handleAutoFillManualWithAi = async () => {
    if (!manualFile) return;
    setExtractingManualAi(true);
    setManualError(null);
    try {
      const data = await apiMutate<{ extracted?: { title?: string; organization?: string; referenceNo?: string; closingDate?: string; estimatedValue?: string; summaryScope?: string } }>(
        '/api/ai/extract-file',
        'POST',
        { dataBase64: manualFile.dataBase64, mimeType: manualFile.mimeType }
      );
      if (data.extracted) {
        const ext = data.extracted;
        setManualForm(prev => ({
          ...prev,
          title: ext.title || prev.title,
          organization: ext.organization || prev.organization,
          reference_no: ext.referenceNo || prev.reference_no,
          closing_date: ext.closingDate && /^\d{4}-\d{2}-\d{2}/.test(ext.closingDate) ? ext.closingDate.slice(0, 10) : prev.closing_date,
          estimated_value: ext.estimatedValue || prev.estimated_value,
          description: ext.summaryScope || prev.description,
        }));
      } else {
        setManualError('Could not extract fields from file.');
      }
    } catch (err: any) {
      setManualError(err?.message && !/^HTTP \d+$/.test(err.message) ? err.message : 'Failed to reach AI extraction service.');
    } finally {
      setExtractingManualAi(false);
    }
  };

  const handleCreateManualTender = async () => {
    if (!manualForm.title.trim()) return;
    setCreatingManual(true);
    setManualError(null);
    try {
      const data = await apiMutate<{ tender?: Tender }>('/api/tenders', 'POST', {
        ...manualForm,
        fileBase64: manualFile?.dataBase64,
        filename: manualFile?.filename,
        mimeType: manualFile?.mimeType,
      });
      if (data.tender) {
        onTenderCreated?.(data.tender);
        resetForm();
        onClose();
      } else {
        setManualError('Failed to create tender.');
      }
    } catch (err: any) {
      setManualError(err?.message && !/^HTTP \d+$/.test(err.message) ? err.message : 'Failed to create tender.');
    } finally {
      setCreatingManual(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} title="Add tender">
      <div className="space-y-4">
        {manualError && (
          <div className="rounded-lg bg-danger-soft p-3 text-xs text-danger">
            {manualError}
          </div>
        )}

        <div className="rounded-lg border border-dashed border-line p-4 text-center">
          <input
            type="file"
            accept="image/*,.pdf"
            id="manual-file-input"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void handleManualFilePicked(f);
              e.target.value = '';
            }}
          />
          {manualFile ? (
            <div className="flex items-center justify-between">
              <span className="truncate text-xs font-medium">{manualFile.filename}</span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void handleAutoFillManualWithAi()}
                  disabled={extractingManualAi}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {extractingManualAi ? 'Extracting…' : 'Extract with AI'}
                </Button>
                <button
                  type="button"
                  onClick={() => setManualFile(null)}
                  className="cursor-pointer text-ink-muted hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : (
            <label htmlFor="manual-file-input" className="cursor-pointer text-xs text-ink-muted hover:text-ink">
              Upload image or PDF to extract details with AI
            </label>
          )}
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-muted">Title *</span>
          <input
            value={manualForm.title}
            onChange={e => setManualForm({ ...manualForm, title: e.target.value })}
            placeholder="e.g. Procurement of Solar PV System for DHQ Hospital"
            className={FIELD_INPUT_CLASS}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Organization *</span>
            <input
              value={manualForm.organization}
              onChange={e => setManualForm({ ...manualForm, organization: e.target.value })}
              placeholder="Procuring agency"
              className={FIELD_INPUT_CLASS}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Reference No</span>
            <input
              value={manualForm.reference_no}
              onChange={e => setManualForm({ ...manualForm, reference_no: e.target.value })}
              placeholder="e.g. PPRA-2026-104"
              className={`${FIELD_INPUT_CLASS} font-mono`}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Closing Date</span>
            <input
              type="date"
              value={manualForm.closing_date}
              onChange={e => setManualForm({ ...manualForm, closing_date: e.target.value })}
              className={`${FIELD_INPUT_CLASS} font-mono`}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-muted">Estimated Value</span>
            <input
              value={manualForm.estimated_value}
              onChange={e => setManualForm({ ...manualForm, estimated_value: e.target.value })}
              placeholder="e.g. PKR 25,000,000"
              className={FIELD_INPUT_CLASS}
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-muted">Direct Portal URL</span>
          <input
            value={manualForm.direct_url}
            onChange={e => setManualForm({ ...manualForm, direct_url: e.target.value })}
            placeholder="https://..."
            className={FIELD_INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-muted">Summary / Scope</span>
          <textarea
            rows={4}
            value={manualForm.description}
            onChange={e => setManualForm({ ...manualForm, description: e.target.value })}
            placeholder="Enter tender scope, requirements…"
            className={FIELD_INPUT_CLASS}
          />
        </label>

        <div className="flex justify-end gap-2">
          <Button onClick={handleClose}>Cancel</Button>
          <Button variant="primary" disabled={creatingManual || !manualForm.title.trim()} onClick={() => void handleCreateManualTender()}>
            {creatingManual ? 'Creating…' : 'Create tender'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
