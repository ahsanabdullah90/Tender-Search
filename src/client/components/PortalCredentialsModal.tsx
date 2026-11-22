import React, { useState, useEffect, useRef } from 'react';
import { PortalHealth } from '../../shared/types';
import { Button, Dialog, FIELD_INPUT_CLASS } from '../ui';
import { ApiError, apiJson, apiMutate } from '../utils/apiClient';
import { KeyRound, ExternalLink, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

interface PortalCredentialsModalProps {
  portal: PortalHealth | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const PortalCredentialsModal: React.FC<PortalCredentialsModalProps> = ({
  portal,
  isOpen,
  onClose,
  onSuccess
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [hasExistingPassword, setHasExistingPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isOpen || !portal) return;

    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    setErrorMsg(null);
    setSuccessMsg(null);
    setIsFetching(true);
    setPassword('');

    const fallbackLoginUrl = portal.login_url || portal.tenders_url;
    apiJson<{ username?: string; loginUrl?: string; hasPassword?: boolean }>(
      `/api/portals/${portal.portal_id}/credentials`
    )
      .then(data => {
        setUsername(data.username || portal.auth_username || '');
        setLoginUrl(data.loginUrl || fallbackLoginUrl);
        setHasExistingPassword(Boolean(data.hasPassword || portal.has_credentials));
      })
      .catch(() => {
        setUsername(portal.auth_username || '');
        setLoginUrl(fallbackLoginUrl);
        setHasExistingPassword(Boolean(portal.has_credentials));
      })
      .finally(() => setIsFetching(false));
  }, [isOpen, portal]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!portal) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsLoading(true);

    try {
      const data = await apiMutate<{ success?: boolean; message?: string }>(
        `/api/portals/${portal.portal_id}/credentials`,
        'POST',
        {
          username: username.trim(),
          password,
          loginUrl: loginUrl.trim()
        }
      );

      setSuccessMsg(data.message || 'Credentials authenticated and saved successfully!');
      setHasExistingPassword(true);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        onSuccess();
        onClose();
      }, 1200);
    } catch (err: any) {
      const payload = err instanceof ApiError ? (err.data as { message?: string; error?: string } | null) : null;
      const serverMsg = payload?.message || payload?.error || (err instanceof ApiError ? '' : err?.message);
      setErrorMsg(serverMsg || 'Failed to authenticate portal credentials');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen || !portal) return null;

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title="Portal Credentials"
      subtitle={portal.portal_name}
      icon={
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <KeyRound className="h-5 w-5" />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {errorMsg && (
          <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="flex items-start gap-2.5 rounded-lg border border-ok/30 bg-ok-soft p-3 text-xs text-ok">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {isFetching ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-ink-muted">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
            <span className="text-xs">Loading portal credentials...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="portal-cred-login-url" className="text-xs font-semibold text-ink">
                  Login Page URL
                </label>
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] text-accent hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  <span>Open in Browser</span>
                </a>
              </div>
              <input
                id="portal-cred-login-url"
                type="url"
                value={loginUrl}
                onChange={e => setLoginUrl(e.target.value)}
                placeholder="https://portal.example.gov.pk/login"
                required
                className={`${FIELD_INPUT_CLASS} font-mono text-xs`}
              />
            </div>

            <div>
              <label htmlFor="portal-cred-username" className="mb-1 block text-xs font-semibold text-ink">
                {portal.portal_id === 'tender_services' ? 'Registered Email / Username' : 'Username / Email'}
              </label>
              <input
                id="portal-cred-username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder={portal.portal_id === 'tender_services' ? 'e.g. yourname@company.com' : 'Username or Email'}
                required
                className={`${FIELD_INPUT_CLASS} text-xs`}
              />
              {portal.portal_id === 'tender_services' && (
                <p className="mt-1 text-[10px] text-ink-muted">
                  The email address registered on your Tender Services Pakistan account.
                </p>
              )}
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="portal-cred-password" className="text-xs font-semibold text-ink">
                  Password / Key
                </label>
                {hasExistingPassword && !password && (
                  <span className="rounded bg-ok-soft px-1.5 py-0.5 text-[10px] font-medium text-ok">
                    Password Saved
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  id="portal-cred-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={hasExistingPassword ? '•••••••• (leave blank to keep current)' : 'Enter password or access key'}
                  required={!hasExistingPassword}
                  className={`${FIELD_INPUT_CLASS} pr-9 text-xs`}
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide secret' : 'Reveal secret'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 cursor-pointer p-0.5 text-ink-muted hover:text-ink"
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              {portal.portal_id === 'tender_services' && (
                <p className="mt-1 text-[10px] text-ink-muted">
                  The password or WhatsApp access key provided by Tender Services.
                </p>
              )}
            </div>

            <div className="mt-2 flex items-center justify-end gap-2 border-t border-line pt-3">
              <Button variant="secondary" size="sm" onClick={onClose} disabled={isLoading}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={isLoading || (!username.trim() && !password)}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Authenticating...</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="h-3.5 w-3.5" />
                    <span>Save &amp; Log In</span>
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
};
