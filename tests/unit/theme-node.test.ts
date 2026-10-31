import { describe, it, expect } from 'vitest';
import {
  readThemePref,
  writeThemePref,
  systemPrefersDark,
  resolveDark,
  onSystemThemeChange
} from '../../src/theme.js';

describe('theme in node environment (SSR / headless without window)', () => {
  it('handles missing window/matchMedia gracefully', () => {
    expect(systemPrefersDark()).toBe(false);

    const unsub = onSystemThemeChange(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('handles missing localStorage gracefully in read and write', () => {
    expect(readThemePref()).toBe('system');
    expect(() => writeThemePref('dark')).not.toThrow();
  });

  it('resolves dark correctly without DOM', () => {
    expect(resolveDark('dark', false)).toBe(true);
    expect(resolveDark('light', true)).toBe(false);
    expect(resolveDark('system', true)).toBe(true);
    expect(resolveDark('system', false)).toBe(false);
  });
});
