import { useEffect, useRef, useState } from 'react';
import type { Theme } from '../lib/theme';
import { Button } from './ui/button';

export type Module = 'chat' | 'projects' | 'office';

const MODULES: { id: Module; label: string }[] = [
  { id: 'chat', label: 'Chat room' },
  { id: 'projects', label: 'Projects' },
  { id: 'office', label: 'Office' },
];

export function TopNav({
  module,
  onModule,
  theme,
  onTheme,
}: {
  module: Module;
  onModule: (m: Module) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click (the icon re-click closes via its own handler).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.parentElement?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <nav className="relative flex items-center border-b border-gray-300 bg-gray-100 px-3 py-1.5 dark:border-gray-700 dark:bg-[#161616]">
      <h1 className="text-sm font-bold text-gray-900 dark:text-white">
        Agents Lobby
      </h1>
      <div className="mx-3 h-4 w-px bg-gray-300 dark:bg-gray-600" />
      <div className="flex items-center gap-1">
      {MODULES.map((m) => (
        <Button
          key={m.id}
          variant={module === m.id ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onModule(m.id)}
          aria-current={module === m.id ? 'page' : undefined}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
            module === m.id
              ? 'bg-blue-700 text-white dark:bg-blue-600'
              : 'text-gray-900 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {m.label}
        </Button>
      ))}
      </div>
      <div className="ml-auto">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          title="Settings"
          aria-haspopup="menu"
          aria-expanded={open}
          className={`px-2 py-1 text-sm ${
            open
              ? 'bg-gray-300 dark:bg-gray-600'
              : 'text-gray-900 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          ⚙
        </Button>
        {open && (
          <div
            ref={menuRef}
            className="absolute right-2 top-full z-10 mt-1 w-48 rounded-md border border-gray-300 bg-white p-2 shadow-lg dark:border-gray-600 dark:bg-[#222]"
          >
            <div className="flex items-center justify-between gap-2 px-1 py-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
                role="switch"
                aria-label="Toggle dark or light theme"
                aria-checked={theme === 'dark'}
                title="Toggle theme"
                className={`relative h-5 w-10 rounded-full ${
                  theme === 'dark' ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-500'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow ${
                    theme === 'dark' ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </Button>
              <span className="text-xs text-gray-900 dark:text-gray-200">Dark / Light</span>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
