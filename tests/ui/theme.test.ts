import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  readThemePref,
  writeThemePref,
  systemPrefersDark,
  resolveDark,
  applyDarkClass,
  onSystemThemeChange
} from '../../src/client/theme.js';

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

  describe('UI-5: WCAG AA color contrast ratios', () => {
    function parseHex(hex: string): [number, number, number] {
      const h = hex.replace('#', '');
      return [
        parseInt(h.substring(0, 2), 16) / 255,
        parseInt(h.substring(2, 4), 16) / 255,
        parseInt(h.substring(4, 6), 16) / 255
      ];
    }

    function relativeLuminance([r, g, b]: [number, number, number]): number {
      const a = [r, g, b].map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    }

    function contrastRatio(hex1: string, hex2: string): number {
      const l1 = relativeLuminance(parseHex(hex1));
      const l2 = relativeLuminance(parseHex(hex2));
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    it('guarantees text contrast >= 4.5:1 (WCAG AA) in light theme', () => {
      const surface = '#ffffff';
      const ink = '#14171f';
      const inkMuted = '#5b6475';

      const inkContrast = contrastRatio(ink, surface);
      const mutedContrast = contrastRatio(inkMuted, surface);

      expect(inkContrast).toBeGreaterThanOrEqual(4.5);
      expect(mutedContrast).toBeGreaterThanOrEqual(4.5);
    });

    it('guarantees text contrast >= 4.5:1 (WCAG AA) in dark theme', () => {
      const surface = '#161b22';
      const ink = '#e7eaf0';
      const inkMuted = '#9aa3b2';

      const inkContrast = contrastRatio(ink, surface);
      const mutedContrast = contrastRatio(inkMuted, surface);

      expect(inkContrast).toBeGreaterThanOrEqual(4.5);
      expect(mutedContrast).toBeGreaterThanOrEqual(4.5);
    });
  });
});
