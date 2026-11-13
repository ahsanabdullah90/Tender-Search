import React, { useState, useEffect } from 'react';
import { PortalHealth } from '../../shared/types';
import { X, KeyRound, ExternalLink, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

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

  useEffect(() => {
    if (!isOpen || !portal) return;

    setErrorMsg(null);
    setSuccessMsg(null);
    setIsFetching(true);
    setPassword('');

    // Fetch existing credentials
    fetch(`/api/portals/${portal.portal_id}/credentials`)
      .then(res => res.json())
      .then(data => {
        setUsername(data.username || portal.auth_username || '');
        setLoginUrl(data.loginUrl || portal.login_url || (portal.portal_id === 'tender_services' ? 'https://tenderservice.pk/permits/login.php' : portal.tenders_url));
        setHasExistingPassword(Boolean(data.hasPassword || portal.has_credentials));
      })
      .catch(() => {
        setUsername(portal.auth_username || '');
        setLoginUrl(portal.login_url || (portal.portal_id === 'tender_services' ? 'https://tenderservice.pk/permits/login.php' : portal.tenders_url));
        setHasExistingPassword(Boolean(portal.has_credentials));
      })
      .finally(() => setIsFetching(false));
  }, [isOpen, portal]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !portal) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsLoading(true);

    try {
      const res = await fetch(`/api/portals/${portal.portal_id}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password: password,
          loginUrl: loginUrl.trim()
        })
      });

      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.message || 'Failed to authenticate portal credentials');
      }

      setSuccessMsg(data.message || 'Credentials authenticated and saved successfully!');
      setHasExistingPassword(true);
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1200);
    } catch (err: any) {
      setErrorMsg(err.message || 'Authentication error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 text-slate-800 dark:text-slate-100"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 rounded-lg">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white leading-tight">
                Portal Credentials
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {portal.portal_name}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-md cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Feedback Alerts */}
        {errorMsg && (
          <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg flex items-start gap-2.5 text-xs text-red-700 dark:text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 rounded-lg flex items-start gap-2.5 text-xs text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{successMsg}</span>
          </div>
        )}

        {isFetching ? (
          <div className="py-8 flex flex-col items-center justify-center gap-2 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin text-purple-600" />
            <span className="text-xs">Loading portal credentials...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
            {/* Login URL */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="portal-cred-login-url" className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Login Page URL
                </label>
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>Open in Browser</span>
                </a>
              </div>
              <input
                id="portal-cred-login-url"
                type="url"
                value={loginUrl}
                onChange={e => setLoginUrl(e.target.value)}
                placeholder="https://tenderservice.pk/permits/login.php"
                required
                className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 focus:outline-hidden focus:ring-2 focus:ring-purple-500 font-mono"
              />
            </div>

            {/* Username / Email */}
            <div>
              <label htmlFor="portal-cred-username" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {portal.portal_id === 'tender_services' ? 'Registered Email / Username' : 'Username / Email'}
              </label>
              <input
                id="portal-cred-username"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder={portal.portal_id === 'tender_services' ? 'e.g. yourname@company.com' : 'Username or Email'}
                required
                className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 focus:outline-hidden focus:ring-2 focus:ring-purple-500"
              />
              {portal.portal_id === 'tender_services' && (
                <p className="text-[10px] text-slate-400 mt-1">
                  The email address registered on your Tender Services Pakistan account.
                </p>
              )}
            </div>

            {/* Password / Access Key */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="portal-cred-password" className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Password / Key
                </label>
                {hasExistingPassword && !password && (
                  <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.5 rounded">
                    Password Saved
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  id="portal-cred-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={hasExistingPassword ? '•••••••• (leave blank to keep current)' : 'Enter password or access key'}
                  required={!hasExistingPassword}
                  className="w-full text-xs px-3 py-2 pr-9 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-0.5"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              {portal.portal_id === 'tender_services' && (
                <p className="text-[10px] text-slate-400 mt-1">
                  The password or WhatsApp access key provided by Tender Services.
                </p>
              )}
            </div>

            {/* Form Actions */}
            <div className="mt-2 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isLoading}
                className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading || (!username.trim() && !password)}
                className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Authenticating...</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Save &amp; Log In</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
