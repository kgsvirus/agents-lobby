// Theme persistence helpers (extracted from the legacy useTheme for testing).
// Storage key and semantics are byte-compatible with the legacy app:
// 'lobby-theme' holds 'dark' | 'light'; absent/invalid falls back to the
// system preference.
export type Theme = 'dark' | 'light';

export const THEME_KEY = 'lobby-theme';

export const readStoredTheme = (
  storage: Pick<Storage, 'getItem'>,
  prefersDark: boolean,
): Theme => {
  const saved = storage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return prefersDark ? 'dark' : 'light';
};

export const persistTheme = (storage: Pick<Storage, 'setItem'>, t: Theme): void => {
  storage.setItem(THEME_KEY, t);
};

export const applyTheme = (t: Theme): void => {
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.documentElement.style.colorScheme = t;
};

export const prefersDarkTheme = (): boolean =>
  window.matchMedia('(prefers-color-scheme: dark)').matches;
