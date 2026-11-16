import { useEffect, useRef, useState } from 'react';
import { Theme } from '../hooks/useTheme';

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
    <nav className="relative flex items-center gap-1 border-b border-gray-300 bg-gray-100 px-3 py-1.5 dark:border-gray-700 dark:bg-[#161616]">
      {MODULES.map((m) => (
        <button
          key={m.id}
          onClick={() => onModule(m.id)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
            module === m.id
              ? 'bg-blue-700 text-white dark:bg-blue-600'
              : 'text-gray-900 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {m.label}
        </button>
      ))}
      <div className="ml-auto">
        <button
          onClick={() => setOpen((o) => !o)}
          title="Settings"
          className={`rounded-md px-2 py-1 text-sm ${
            open
              ? 'bg-gray-300 dark:bg-gray-600'
              : 'text-gray-900 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          ⚙
        </button>
        {open && (
          <div
            ref={menuRef}
            className="absolute right-2 top-full z-10 mt-1 w-48 rounded-md border border-gray-300 bg-white p-2 shadow-lg dark:border-gray-600 dark:bg-[#222]"
          >
            <div className="flex items-center justify-between gap-2 px-1 py-1">
              <button
                onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
                title="Toggle theme"
                className={`relative h-5 w-10 rounded-full transition-colors ${
                  theme === 'dark' ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-500'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                    theme === 'dark' ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </button>
              <span className="text-xs text-gray-900 dark:text-gray-200">Dark / Light</span>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
