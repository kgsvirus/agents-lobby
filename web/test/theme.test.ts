// Theme persistence (legacy storage semantics): 'lobby-theme' holds
// 'dark' | 'light'; absent/invalid falls back to the system preference.
import { describe, expect, it } from 'vitest';
import { THEME_KEY, persistTheme, readStoredTheme } from '../src/lib/theme';

const storage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    entries: () => Object.fromEntries(map),
  };
};

describe('readStoredTheme', () => {
  it('uses the persisted choice when valid', () => {
    expect(readStoredTheme(storage({ [THEME_KEY]: 'dark' }), false)).toBe('dark');
    expect(readStoredTheme(storage({ [THEME_KEY]: 'light' }), true)).toBe('light');
  });

  it('falls back to the system preference when absent or invalid', () => {
    expect(readStoredTheme(storage(), true)).toBe('dark');
    expect(readStoredTheme(storage(), false)).toBe('light');
    expect(readStoredTheme(storage({ [THEME_KEY]: 'sepia' }), true)).toBe('dark');
    expect(readStoredTheme(storage({ [THEME_KEY]: '' }), false)).toBe('light');
  });
});

describe('persistTheme', () => {
  it('writes the legacy key', () => {
    const s = storage();
    persistTheme(s, 'dark');
    expect(s.entries()).toEqual({ [THEME_KEY]: 'dark' });
  });
});
