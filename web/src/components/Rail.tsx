'use client';

import { useEffect, useState } from 'react';
import {
  AlignLeft,
  Building2,
  FolderKanban,
  MessageSquare,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import {
  ApiError,
  connectBrowser,
  disconnectBrowser,
  fetchAuthMode,
  fetchPrincipal,
  getHumanToken,
  isDisconnected,
  setHumanToken,
  type AuthMode,
} from '../lib/api';
import type { Theme } from '../lib/theme';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Separator } from './ui/separator';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

export type Module = 'chat' | 'projects' | 'office';

const MODULES: { id: Module; label: string; Icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat room', Icon: MessageSquare },
  { id: 'projects', label: 'Projects', Icon: FolderKanban },
  { id: 'office', label: 'Office', Icon: Building2 },
];

// The 60px rail: modules on top, settings pinned to the bottom. It replaces the
// old header tabs, so the header is only breadcrumb + trigger.
export function Rail({
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
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');
  const [identity, setIdentity] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');

  // Identity mode: connect this browser silently, unless the tab opted out.
  // Shared-token mode: keep the paste (it is the only browser path there).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await fetchAuthMode().catch(() => null);
      if (cancelled || current === null) return;
      setMode(current);
      if (current === 'identity') {
        if (isDisconnected()) return;
        setHumanToken(null);
        const principal = await fetchPrincipal().catch(() => connectBrowser().catch(() => null));
        if (!cancelled && principal !== null) setIdentity(`${principal.name} (${principal.kind})`);
        return;
      }
      if (getHumanToken() === null) return;
      const principal = await fetchPrincipal().catch(() => null);
      if (!cancelled && principal !== null) setIdentity(`${principal.name} (${principal.kind})`);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = async () => {
    if (mode === 'identity') {
      try {
        const p = await connectBrowser();
        setIdentity(`${p.name} (${p.kind})`);
        setConnectError('');
      } catch (err) {
        setIdentity(null);
        setConnectError(err instanceof ApiError ? err.message : 'Connect failed');
      }
      return;
    }
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

  const disconnect = async () => {
    setHumanToken(null);
    setIdentity(null);
    setConnectError('');
    setTokenDraft('');
    if (mode === 'identity') await disconnectBrowser().catch(() => null);
  };

  return (
    <nav className="flex w-[60px] shrink-0 flex-col items-center gap-2 border-r border-border bg-sidebar py-2.5">
      <div className="mb-1.5 grid size-9 place-items-center rounded-[9px] bg-blue-700 text-white">
        <AlignLeft size={18} />
      </div>

      {MODULES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onModule(m.id)}
          aria-label={m.label}
          aria-current={module === m.id ? 'page' : undefined}
          title={m.label}
          className={`grid size-9 cursor-pointer place-items-center rounded-[9px] transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
            module === m.id
              ? 'bg-blue-700 text-white'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          <m.Icon size={18} />
        </button>
      ))}

      <div className="flex-1" />

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="Settings" className="text-muted-foreground hover:bg-accent hover:text-foreground" />}
        >
          <Settings className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="right" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Settings</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={theme === 'dark'}
            onCheckedChange={(checked) => onTheme(checked ? 'dark' : 'light')}
          >
            Dark mode
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setConnectionOpen(true)}>Connection…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connection</DialogTitle>
            <DialogDescription>
              How this browser talks to the lobby. Identity mode connects silently; shared-token
              mode needs the token pasted here.
            </DialogDescription>
          </DialogHeader>

          {mode === null ? (
            <p className="text-sm text-muted-foreground">Checking…</p>
          ) : identity !== null ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">Connected as {identity}</p>
              <Button variant="outline" onClick={() => void disconnect()} className="w-full">
                Disconnect
              </Button>
            </div>
          ) : mode === 'identity' ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">Not connected</p>
              <Button onClick={() => void connect()} className="w-full">
                Connect this browser
              </Button>
            </div>
          ) : mode === 'shared-token' ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="human-token" className="text-sm">
                Human token
              </label>
              <Input
                id="human-token"
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void connect();
                }}
                placeholder="paste token"
                autoComplete="off"
              />
              <Button onClick={() => void connect()} className="w-full">
                Connect
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No identities configured — sends are open locally.
            </p>
          )}

          {connectError !== '' && <p className="text-sm text-destructive">{connectError}</p>}
        </DialogContent>
      </Dialog>
    </nav>
  );
}

export function RailSeparator() {
  return <Separator orientation="vertical" className="mx-1 h-4" />;
}
