/**
 * Theme handling. The user chooses System, Light or Dark.
 * System (the default) follows the computer's setting and updates live.
 * The choice is saved in this browser only.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'tt_theme';
const systemQuery =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Storage can be blocked (private window). The choice then lasts for this visit only.
  }
}

export function systemPrefersDark(): boolean {
  return !!systemQuery?.matches;
}

export function resolveDark(pref: ThemePref, systemDark: boolean): boolean {
  return pref === 'dark' || (pref === 'system' && systemDark);
}

export function applyDarkClass(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark);
}

/** Calls cb when the computer's light/dark setting changes. Returns an unsubscribe function. */
export function onSystemThemeChange(cb: () => void): () => void {
  systemQuery?.addEventListener('change', cb);
  return () => systemQuery?.removeEventListener('change', cb);
}
