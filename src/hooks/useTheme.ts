import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const apply = (t: Theme) => {
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.documentElement.style.colorScheme = t;
};

// Default follows the system; the buttons override and persist the choice.
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('lobby-theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => apply(theme), [theme]);

  const select = (t: Theme) => {
    localStorage.setItem('lobby-theme', t);
    setTheme(t);
  };

  return [theme, select];
}
