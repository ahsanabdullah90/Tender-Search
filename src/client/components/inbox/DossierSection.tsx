import { useEffect, useRef, useState } from 'react';
import { Download, FileText, RotateCw, Upload } from 'lucide-react';
import { Button } from '../../ui';
import type { TenderDocProcessingState } from './detailHelpers';

export interface DossierFileEntry {
  label?: string;
  localPath: string;
  mimeType?: string;
  docType?: string;
  sizeBytes?: number;
}

interface DossierSectionProps {
  tenderId: string;
  files: DossierFileEntry[];
  docState: TenderDocProcessingState;
  fetchingDocs: boolean;
  uploadingFile: boolean;
  onUploadFile: (file: File) => void | Promise<void>;
}

export function DossierSection({
  tenderId,
  files,
  docState,
  fetchingDocs,
  uploadingFile,
  onUploadFile,
}: DossierSectionProps) {
  const [previewPdfIndex, setPreviewPdfIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPreviewPdfIndex(null);
  }, [tenderId]);

  return (
    <div
      onPaste={e => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/') || items[i].type === 'application/pdf') {
            const f = items[i].getAsFile();
            if (f) {
              e.preventDefault();
              void onUploadFile(f);
              break;
            }
          }
        }
      }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted">Saved documents ({files.length})</h3>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf"
            aria-label="Upload tender notice image or PDF"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void onUploadFile(f);
              e.target.value = '';
            }}
          />
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile}>
            <Upload className="h-3.5 w-3.5" />
            {uploadingFile ? 'Uploading…' : 'Upload image / PDF'}
          </Button>
        </div>
      </div>
      <div
        data-testid="tender-doc-status"
        className={`mb-2.5 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
          docState.tone === 'accent'
            ? 'border-accent/30 bg-accent-soft text-accent'
            : docState.tone === 'warn'
              ? 'border-warn/30 bg-warn-soft text-warn'
              : docState.tone === 'ok'
                ? 'border-ok/30 bg-ok-soft text-ok'
                : 'border-line bg-surface-2 text-ink-muted'
        }`}
      >
        {docState.kind === 'processing' && (
          <>
            <RotateCw aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
            <progress className="sr-only" aria-label={docState.bannerTitle} />
          </>
        )}
        <div className="min-w-0">
          <div className="font-semibold">{docState.bannerTitle}</div>
          <div className="mt-0.5 text-[11px] opacity-90">{docState.bannerDetail}</div>
        </div>
      </div>
      {files.length === 0 ? (
        fetchingDocs ? (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted">
            <RotateCw aria-hidden="true" className="h-4 w-4 shrink-0 motion-safe:animate-spin text-accent" />
            <span>Downloading documents from portal…</span>
            <progress className="sr-only" aria-label="Downloading tender documents" />
          </div>
        ) : docState.kind === 'processing' || docState.kind === 'queued' ? (
          <p className="text-ink-muted">
            Queued for automatic download — documents will appear here shortly, or click Fetch Documents to pull them now.
          </p>
        ) : (
          <p className="text-ink-muted">
            No documents saved yet. Click Fetch Documents to check the portal now, or upload a tender image/PDF manually.
          </p>
        )
      ) : (
        <div className="space-y-3">
          {files.map((file, i) => {
            const fileUrl = file.localPath.startsWith('/')
              ? file.localPath
              : `/api/dossiers/${tenderId}/${encodeURIComponent(file.localPath.replace(/\\/g, '/').split('/').pop() || '')}`;
            const isImage =
              file.mimeType?.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(file.localPath);
            const isPdf = file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.localPath);

            return (
              <div key={i} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between gap-3">
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-w-0 flex-1 items-center gap-3 hover:underline"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-ink-muted" />
                    <span className="truncate font-semibold">{file.label || `Document ${i + 1}`}</span>
                    {file.docType && (
                      <span className="rounded bg-chip px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-muted">
                        {file.docType}
                      </span>
                    )}
                  </a>
                  <div className="flex items-center gap-2">
                    {isPdf && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setPreviewPdfIndex(previewPdfIndex === i ? null : i)}
                      >
                        {previewPdfIndex === i ? 'Hide preview' : 'Preview PDF'}
                      </Button>
                    )}
                    <a
                      href={`${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=1`}
                      download
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-2"
                    >
                      <Download className="h-3 w-3" />
                      Download
                    </a>
                  </div>
                </div>
                {isImage && (
                  <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block">
                    <img
                      src={fileUrl}
                      alt={file.label || `Tender notice ${i + 1}`}
                      className="max-h-96 w-full rounded-lg border border-line bg-surface-2 object-contain"
                      loading="lazy"
                    />
                  </a>
                )}
                {isPdf && previewPdfIndex === i && (
                  <iframe
                    src={fileUrl}
                    title={file.label || `PDF Preview ${i + 1}`}
                    className="mt-3 h-96 w-full rounded-lg border border-line bg-surface"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
