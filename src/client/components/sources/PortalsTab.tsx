import { useState } from 'react';
import { ExternalLink, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import type { PortalHealth } from '../../../shared/types';
import { Button, Chip, Dialog, FIELD_INPUT_CLASS, Panel } from '../../ui';
import { apiMutate } from '../../utils/apiClient';
import { formatRelativeAge, isPortalOffline } from '../../utils/format';
import { PortalCredentialsModal } from '../PortalCredentialsModal';
import { Field, SourcesScreenProps } from './shared';

type PortalState = 'working' | 'verify' | 'offline';

function portalState(p: PortalHealth): PortalState {
  if (p.status === 'hitl_required') return 'verify';
  if (isPortalOffline(p)) return 'offline';
  return 'working';
}

export function PortalsTab(
  props: Pick<
    SourcesScreenProps,
    'portals' | 'onUpdatePortal' | 'onAddPortal' | 'onDeletePortal' | 'onLaunchHitl' | 'onVerifyHitl' | 'onScanSinglePortal'
  >
) {
  const { portals } = props;
  const [editing, setEditing] = useState<PortalHealth | null>(null);
  const [form, setForm] = useState({ portal_name: '', website_url: '' });
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({
    portal_name: '',
    website_url: '',
    category: 'Provincial',
    tier: 'http',
    access_mode: 'public',
    login_url: ''
  });
  const [addError, setAddError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PortalHealth | null>(null);
  const [credentialsFor, setCredentialsFor] = useState<PortalHealth | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [healing, setHealing] = useState(false);
  const [healMessage, setHealMessage] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const working = portals.filter(p => portalState(p) === 'working').length;

  const startEdit = (p: PortalHealth) => {
    setEditing(p);
    setHealMessage(null);
    setForm({
      portal_name: p.portal_name,
      website_url: p.tenders_url || p.base_url || ''
    });
  };

  const runAutoHealInDialog = async () => {
    if (!editing) return;
    setHealing(true);
    setHealMessage(null);
    try {
      const data = await apiMutate<{ tendersUrl?: string; message?: string }>(
        `/api/portals/${editing.portal_id}/heal`,
        'POST',
        { baseUrl: form.website_url.trim() }
      );
      if (data.tendersUrl) {
        setForm(prev => ({ ...prev, website_url: data.tendersUrl! }));
        setHealMessage(data.message || `Found tender page: ${data.tendersUrl}`);
      } else {
        setHealMessage(data.message || 'Could not auto-detect tender page from this address.');
      }
    } catch (err) {
      const errData = (err as { data?: { message?: string } } | null)?.data;
      setHealMessage(
        errData !== undefined
          ? errData?.message || 'Could not auto-detect tender page from this address.'
          : 'Auto-discovery request failed.'
      );
    } finally {
      setHealing(false);
    }
  };

  const resetToDefaultUrl = async () => {
    if (!editing) return;
    setResetting(true);
    setHealMessage(null);
    try {
      const data = await apiMutate<{
        portal_name?: string;
        tenders_url?: string;
        base_url?: string;
        message?: string;
      }>(`/api/portals/${editing.portal_id}/reset-default`, 'POST');
      setForm({
        portal_name: data.portal_name || form.portal_name,
        website_url: data.tenders_url || form.website_url
      });
      setHealMessage(data.message || 'Restored official default URL.');
      props.onUpdatePortal(editing.portal_id, {
        tenders_url: data.tenders_url,
        base_url: data.base_url,
        status: 'online',
        last_error_message: null
      });
    } catch (err) {
      const errData = (err as { data?: { message?: string } } | null)?.data;
      setHealMessage(
        errData !== undefined
          ? errData?.message || 'Could not reset portal to default URL.'
          : 'Failed to reset default URL.'
      );
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-line bg-surface p-4">
        <div>
          <h2 className="text-base font-bold text-ink flex items-center gap-2">
            Procurement Portals
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-muted">{portals.length}</span>
          </h2>
          <p className="text-xs text-ink-muted mt-0.5">
            <span className="font-semibold text-ink">{working} of {portals.length} portals are working.</span>{' '}
            Automated crawlers monitor these endpoints. Add new provincial/federal portals or delete portals at any time.
          </p>
        </div>
        <Button variant="primary" className="shrink-0" onClick={() => { setAdding(true); setAddError(null); }}>
          <Plus className="h-4 w-4" /> Add portal
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
        <div>
          <span className="font-semibold text-ink">{portals.filter(p => p.status === 'online').length} of {portals.length}</span> sources checked successfully
          {(() => {
            const latestSuccess = portals.map(p => p.last_success_at).filter((x): x is string => Boolean(x)).sort().reverse()[0];
            return latestSuccess ? <span> · {formatRelativeAge(latestSuccess, { prefix: 'Last success' })}</span> : null;
          })()}
        </div>
      </div>

      <Panel>
        {[...portals]
          .sort((a, b) => ['verify', 'offline', 'working'].indexOf(portalState(a)) - ['verify', 'offline', 'working'].indexOf(portalState(b)))
          .map(p => {
            const state = portalState(p);
            const website = p.tenders_url || p.base_url;
            const isAutoHealed = Boolean(p.verified_status && p.verified_status.startsWith('Auto-healed'));
            return (
              <div key={p.portal_id} className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{p.portal_name}</span>
                    {isAutoHealed && <Chip tone="accent">Auto-healed</Chip>}
                    {p.consecutive_zero_yields > 0 && p.status === 'online' && (
                      <Chip tone="warn">0 tenders — check URL</Chip>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px]">
                    {website ? (
                      <a
                        href={website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-[12px] text-accent hover:underline"
                        onClick={e => e.stopPropagation()}
                      >
                        <span className="truncate max-w-[280px] sm:max-w-[420px]">{website}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                      </a>
                    ) : (
                      <span className="font-mono text-[12px] font-medium text-danger">⚠️ Missing website address</span>
                    )}
                    <span className="text-ink-muted">
                      · {p.category} · {formatRelativeAge(p.last_scan_at, { prefix: 'Checked', empty: 'Never checked' })}
                      {p.last_items_found > 0 ? ` · ${p.last_items_found} matched` : ''}
                    </span>
                  </div>
                  {(p.last_error_message || p.last_error_code) && (
                    <div className={`mt-1 flex flex-wrap items-center gap-1.5 text-[12px] ${state === 'working' ? 'text-amber-700 dark:text-amber-400' : 'text-danger'}`}>
                      {p.last_error_code && (
                        <Chip tone={state === 'working' ? 'warn' : 'danger'}>{p.last_error_code}</Chip>
                      )}
                      {p.last_error_message && (
                        <>
                          <span className="font-semibold">{state === 'working' ? 'Notice:' : 'Reason:'}</span>
                          <span className="truncate max-w-[500px]">{p.last_error_message}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {p.status === 'scanning' ? (
                    <Chip tone="accent">Scanning…</Chip>
                  ) : (
                    <>
                      {state === 'working' && <Chip tone="ok">Working</Chip>}
                      {state === 'verify' && <Chip tone="warn">Needs verification</Chip>}
                      {state === 'offline' && <Chip tone="danger">Offline</Chip>}
                    </>
                  )}

                  {state === 'verify' && verifying !== p.portal_id && (
                    <Button size="sm" variant="primary" onClick={() => { props.onLaunchHitl(p.portal_id); setVerifying(p.portal_id); }}>Verify now</Button>
                  )}
                  {state === 'verify' && verifying === p.portal_id && (
                    <Button size="sm" variant="primary" onClick={() => { props.onVerifyHitl(p.portal_id); setVerifying(null); }}>I've finished</Button>
                  )}
                  {state === 'offline' && <Button size="sm" onClick={() => props.onScanSinglePortal(p.portal_id)}>Retry</Button>}
                  {state === 'working' && p.status !== 'scanning' && (
                    <Button size="sm" variant="ghost" onClick={() => props.onScanSinglePortal(p.portal_id)}>Scan</Button>
                  )}
                  <Button size="sm" variant="ghost" aria-label={`Edit ${p.portal_name}`} onClick={() => startEdit(p)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title={`Delete ${p.portal_name}`}
                    aria-label={`Delete ${p.portal_name}`}
                    className="text-ink-muted hover:bg-danger-soft hover:text-danger"
                    onClick={() => setDeleting(p)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
      </Panel>

      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.portal_name}` : ''}
        footer={
          <div className="flex w-full items-center justify-between">
            <Button
              variant="danger"
              onClick={() => {
                const toDel = editing;
                setEditing(null);
                setDeleting(toDel);
              }}
            >
              <Trash2 className="h-4 w-4" /> Delete portal
            </Button>
            <div className="flex items-center gap-2">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  if (editing) {
                    const url = form.website_url.trim();
                    props.onUpdatePortal(editing.portal_id, {
                      portal_name: form.portal_name.trim(),
                      tenders_url: url,
                      base_url: url
                    });
                  }
                  setEditing(null);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label="Portal name">
            <input
              value={form.portal_name}
              onChange={e => setForm({ ...form, portal_name: e.target.value })}
              className={FIELD_INPUT_CLASS}
              placeholder="e.g. Punjab PPRA"
            />
          </Field>
          <Field label="Website address">
            <input
              value={form.website_url}
              onChange={e => setForm({ ...form, website_url: e.target.value })}
              className={`${FIELD_INPUT_CLASS} font-mono text-[13px]`}
              placeholder="https://..."
            />
          </Field>
          {healMessage && (
            <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-muted">
              {healMessage}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={healing || !form.website_url.trim()} onClick={() => void runAutoHealInDialog()}>
              {healing ? 'Searching website…' : 'Auto-find tender page'}
            </Button>
            <Button disabled={resetting} variant="ghost" onClick={() => void resetToDefaultUrl()}>
              {resetting ? 'Resetting…' : 'Reset to default URL'}
            </Button>
            <Button onClick={() => { setCredentialsFor(editing); setEditing(null); }}>
              <KeyRound className="h-4 w-4" /> Login details
            </Button>
          </div>
        </div>
      </Dialog>

      <PortalCredentialsModal
        portal={credentialsFor}
        isOpen={Boolean(credentialsFor)}
        onClose={() => setCredentialsFor(null)}
        onSuccess={() => { if (credentialsFor) props.onUpdatePortal(credentialsFor.portal_id, { status: 'online' }); }}
      />

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add procurement portal"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!addForm.portal_name.trim() || !addForm.website_url.trim()}
              onClick={async () => {
                if (!addForm.portal_name.trim() || !addForm.website_url.trim()) return;
                try {
                  if (props.onAddPortal) {
                    await props.onAddPortal({
                      portal_name: addForm.portal_name.trim(),
                      tenders_url: addForm.website_url.trim(),
                      base_url: addForm.website_url.trim(),
                      category: addForm.category,
                      tier: addForm.tier,
                      access_mode: addForm.access_mode,
                      login_url: addForm.login_url.trim() || undefined
                    });
                  } else {
                    await apiMutate('/api/portals', 'POST', {
                      portal_name: addForm.portal_name.trim(),
                      tenders_url: addForm.website_url.trim(),
                      category: addForm.category,
                      tier: addForm.tier,
                      access_mode: addForm.access_mode,
                      login_url: addForm.login_url.trim() || undefined
                    });
                  }
                  setAdding(false);
                  setAddForm({
                    portal_name: '',
                    website_url: '',
                    category: 'Provincial',
                    tier: 'http',
                    access_mode: 'public',
                    login_url: ''
                  });
                } catch (err: any) {
                  setAddError(err?.message || 'Failed to add portal');
                }
              }}
            >
              Add portal
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Portal name">
            <input
              autoFocus
              value={addForm.portal_name}
              onChange={e => setAddForm({ ...addForm, portal_name: e.target.value })}
              className={FIELD_INPUT_CLASS}
              placeholder="e.g. Sindh Irrigation Department"
            />
          </Field>
          <Field label="Tenders website address">
            <input
              value={addForm.website_url}
              onChange={e => setAddForm({ ...addForm, website_url: e.target.value })}
              className={`${FIELD_INPUT_CLASS} font-mono text-[13px]`}
              placeholder="https://example.gov.pk/tenders"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Category">
              <select
                value={addForm.category}
                onChange={e => setAddForm({ ...addForm, category: e.target.value })}
                className={FIELD_INPUT_CLASS}
              >
                <option value="Federal">Federal</option>
                <option value="Provincial">Provincial</option>
                <option value="Regulatory">Regulatory</option>
                <option value="Energy & Power">Energy & Power</option>
                <option value="Education & Skills">Education & Skills</option>
                <option value="Autonomous">Autonomous</option>
                <option value="Multilateral">Multilateral</option>
              </select>
            </Field>
            <Field label="Access type">
              <select
                value={addForm.access_mode}
                onChange={e => setAddForm({ ...addForm, access_mode: e.target.value })}
                className={FIELD_INPUT_CLASS}
              >
                <option value="public">Public / Open</option>
                <option value="login_required">Login Required</option>
                <option value="cloudflare">Cloudflare / CAPTCHA</option>
              </select>
            </Field>
          </div>
          {addForm.access_mode === 'login_required' && (
            <Field label="Login page URL (optional)">
              <input
                value={addForm.login_url}
                onChange={e => setAddForm({ ...addForm, login_url: e.target.value })}
                className={`${FIELD_INPUT_CLASS} font-mono text-[13px]`}
                placeholder="https://example.gov.pk/login"
              />
            </Field>
          )}
          {addError && (
            <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              {addError}
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this portal?"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (deleting) {
                  if (props.onDeletePortal) {
                    await props.onDeletePortal(deleting.portal_id);
                  } else {
                    await apiMutate(`/api/portals/${deleting.portal_id}`, 'DELETE');
                  }
                }
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-ink-muted">
          Are you sure you want to remove <span className="font-semibold text-ink">{deleting?.portal_name}</span>?
          This will exclude it from future scans and crawler runs.
        </p>
      </Dialog>
    </div>
  );
}
