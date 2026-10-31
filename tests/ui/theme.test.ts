import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  readThemePref,
  writeThemePref,
  systemPrefersDark,
  resolveDark,
  applyDarkClass,
  onSystemThemeChange
} from '../../src/theme.js';

describe('theme management', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readThemePref', () => {
    it('defaults to "system" when localStorage is empty', () => {
      expect(readThemePref()).toBe('system');
    });

    it('returns valid saved preferences ("light", "dark", "system")', () => {
      localStorage.setItem('tt_theme', 'light');
      expect(readThemePref()).toBe('light');

      localStorage.setItem('tt_theme', 'dark');
      expect(readThemePref()).toBe('dark');

      localStorage.setItem('tt_theme', 'system');
      expect(readThemePref()).toBe('system');
    });

    it('falls back to "system" for invalid stored values', () => {
      localStorage.setItem('tt_theme', 'neon-purple');
      expect(readThemePref()).toBe('system');
    });

    it('falls back to "system" if localStorage throws an error', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Storage access denied');
      });
      expect(readThemePref()).toBe('system');
    });
  });

  describe('writeThemePref', () => {
    it('persists preference to localStorage', () => {
      writeThemePref('dark');
      expect(localStorage.getItem('tt_theme')).toBe('dark');

      writeThemePref('light');
      expect(localStorage.getItem('tt_theme')).toBe('light');
    });

    it('catches and ignores localStorage write exceptions', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Quota exceeded');
      });

      expect(() => writeThemePref('dark')).not.toThrow();
    });
  });

  describe('systemPrefersDark', () => {
    it('returns a boolean matching the system media query', () => {
      const isDark = systemPrefersDark();
      expect(typeof isDark).toBe('boolean');
    });
  });

  describe('resolveDark', () => {
    it('resolves dark correctly based on explicit and system preference', () => {
      expect(resolveDark('dark', false)).toBe(true);
      expect(resolveDark('dark', true)).toBe(true);

      expect(resolveDark('light', false)).toBe(false);
      expect(resolveDark('light', true)).toBe(false);

      expect(resolveDark('system', true)).toBe(true);
      expect(resolveDark('system', false)).toBe(false);
    });
  });

  describe('applyDarkClass', () => {
    it('adds or removes "dark" class from document.documentElement', () => {
      applyDarkClass(true);
      expect(document.documentElement.classList.contains('dark')).toBe(true);

      applyDarkClass(false);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  describe('onSystemThemeChange', () => {
    it('subscribes and unsubscribes from change events on matchMedia', () => {
      const callback = vi.fn();
      const unsubscribe = onSystemThemeChange(callback);
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });
});
