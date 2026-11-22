import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { DomainTrack } from '../../../shared/types';
import { Button, Chip, Dialog, EmptyState, FIELD_INPUT_CLASS, Panel } from '../../ui';
import { Field, SourcesScreenProps } from './shared';

const splitWords = (text: string) => text.split(/[,\n]/).map(s => s.trim()).filter(Boolean);

export function KeywordsTab({
  tracks,
  onSaveTrack,
  onDeleteTrack
}: Pick<SourcesScreenProps, 'tracks' | 'onSaveTrack' | 'onDeleteTrack'>) {
  const [editing, setEditing] = useState<{ id?: string; name: string; positive: string; negative: string } | null>(null);
  const [deleting, setDeleting] = useState<DomainTrack | null>(null);

  const save = () => {
    if (!editing || !editing.name.trim()) return;
    onSaveTrack({
      id: editing.id,
      name: editing.name.trim(),
      positive_keywords: splitWords(editing.positive),
      negative_keywords: splitWords(editing.negative),
    });
    setEditing(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-xl text-ink-muted">
          A tender is tagged with a domain when its text contains one of the domain's words. Words in the Ignore list rule a tender out.
        </p>
        <Button variant="primary" onClick={() => setEditing({ name: '', positive: '', negative: '' })}>
          <Plus className="h-4 w-4" /> Add domain
        </Button>
      </div>

      {tracks.length === 0 ? (
        <Panel><EmptyState title="No domains yet" body="Add a domain to start tagging tenders." /></Panel>
      ) : (
        <Panel>
          {tracks.map(t => (
            <div key={t.id} className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 last:border-b-0">
              <div className="min-w-0 space-y-2">
                <div className="font-semibold">{t.name}</div>
                <div className="flex flex-wrap gap-1.5">
                  {t.positive_keywords.map(k => <Chip key={k} tone="accent">{k}</Chip>)}
                </div>
                {t.negative_keywords.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-ink-muted">Ignore:</span>
                    {t.negative_keywords.map(k => <Chip key={k}>{k}</Chip>)}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${t.name}`}
                  onClick={() => setEditing({ id: t.id, name: t.name, positive: t.positive_keywords.join(', '), negative: t.negative_keywords.join(', ') })}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => setDeleting(t)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </Panel>
      )}

      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit domain' : 'Add domain'}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={!editing?.name.trim()}>Save</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Domain name">
              <input autoFocus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} className={FIELD_INPUT_CLASS} />
            </Field>
            <Field label="Words to look for" hint="Separate with commas.">
              <textarea rows={3} value={editing.positive} onChange={e => setEditing({ ...editing, positive: e.target.value })} className={FIELD_INPUT_CLASS} />
            </Field>
            <Field label="Ignore list" hint="Tenders containing these words are left out.">
              <textarea rows={2} value={editing.negative} onChange={e => setEditing({ ...editing, negative: e.target.value })} className={FIELD_INPUT_CLASS} />
            </Field>
          </div>
        )}
      </Dialog>

      <Dialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this domain?"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Keep it</Button>
            <Button variant="danger" onClick={() => { if (deleting) onDeleteTrack(deleting.id); setDeleting(null); }}>Delete</Button>
          </>
        }
      >
        <p>"{deleting?.name}" will stop tagging new tenders. Tenders already tagged stay as they are.</p>
      </Dialog>
    </div>
  );
}
