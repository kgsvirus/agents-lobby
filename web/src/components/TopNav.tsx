import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchPrincipal,
  getHumanToken,
  setHumanToken,
} from '../lib/api';
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
  const [tokenDraft, setTokenDraft] = useState('');
  const [identity, setIdentity] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');

  // A stored token is only known to be valid once the server confirms it.
  useEffect(() => {
    if (getHumanToken() === null) return;
    fetchPrincipal()
      .then((p) => setIdentity(`${p.name} (${p.kind})`))
      .catch(() => setIdentity(null));
  }, []);

  const connect = async () => {
    const token = tokenDraft.trim();
    if (token === '') return;
    setHumanToken(token);
    try {
      const p = await fetchPrincipal();
      setIdentity(`${p.name} (${p.kind})`);
      setConnectError('');
      setTokenDraft('');
    } catch (err) {
      setHumanToken(null);
      setIdentity(null);
      setConnectError(err instanceof ApiError ? err.message : 'Connect failed');
    }
  };

  const disconnect = () => {
    setHumanToken(null);
    setIdentity(null);
    setConnectError('');
    setTokenDraft('');
  };

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
            <div className="mt-1 border-t border-gray-200 px-1 pt-2 dark:border-gray-600">
              <label
                htmlFor="human-token"
                className="block text-xs text-gray-900 dark:text-gray-200"
              >
                Human token
              </label>
              {identity === null ? (
                <>
                  <input
                    id="human-token"
                    type="password"
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void connect();
                    }}
                    placeholder="paste token"
                    autoComplete="off"
                    className="mt-1 w-full rounded border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-[#1b1b1b] dark:text-gray-100"
                  />
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void connect()}
                    className="mt-1 w-full rounded-md px-2 py-1 text-xs font-semibold"
                  >
                    Connect
                  </Button>
                </>
              ) : (
                <>
                  <p className="mt-1 text-xs text-gray-900 dark:text-gray-200">
                    Connected as {identity}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={disconnect}
                    className="mt-1 w-full rounded-md px-2 py-1 text-xs font-semibold"
                  >
                    Disconnect
                  </Button>
                </>
              )}
              {connectError !== '' && (
                <p className="mt-1 text-xs text-red-700 dark:text-red-500">{connectError}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
