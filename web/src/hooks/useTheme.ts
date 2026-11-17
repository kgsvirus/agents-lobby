'use client';
import { useEffect, useState } from 'react';
import {
  applyTheme,
  persistTheme,
  prefersDarkTheme,
  readStoredTheme,
  type Theme,
} from '../lib/theme';

// Default follows the system; the toggle overrides and persists the choice.
// Static-export note: the page is prerendered at build time (no DOM), so the
// stored/system theme is read in a mount effect, never in the initializer.
// The inline bootstrap script in app/layout.tsx has already applied the right
// `dark` class before hydration, so there is no visible flash.
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readStoredTheme(localStorage, prefersDarkTheme()));
  }, []);

  useEffect(() => {
    if (theme !== null) applyTheme(theme);
  }, [theme]);

  const select = (t: Theme) => {
    persistTheme(localStorage, t);
    setTheme(t);
  };

  return [theme ?? 'light', select];
}
