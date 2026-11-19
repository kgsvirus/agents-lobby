import { useEffect, useState } from 'react';
import {
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
import { SidebarTrigger } from './ui/sidebar';
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
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');
  const [identity, setIdentity] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');

  // Identity mode: connect this browser silently, unless the tab opted out.
  // Shared-token mode: keep the paste (it is the only browser path there).
  // Open mode: nothing to connect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await fetchAuthMode().catch(() => null);
      if (cancelled || current === null) return; // status unknown: render nothing
      setMode(current);
      if (current === 'identity') {
        if (isDisconnected()) return;
        // A token pasted in a previous (shared-token) life must not override
        // the browser session: clear it so the cookie is the only credential.
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
    if (mode === 'identity') {
      // Sticky for this tab: a reload must not silently sign back in.
      await disconnectBrowser().catch(() => null);
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <h1 className="text-sm font-bold text-foreground">Agents Lobby</h1>

      <div className="ml-3 flex items-center gap-1">
        {MODULES.map((m) => (
          <Button
            key={m.id}
            variant={module === m.id ? 'default' : 'ghost'}
            size="sm"
            onClick={() => onModule(m.id)}
            aria-current={module === m.id ? 'page' : undefined}
            className={`items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${
              module === m.id
                ? 'bg-blue-700 text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-600'
                : 'text-gray-900 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            <m.Icon size={14} className="shrink-0" />
            {m.label}
          </Button>
        ))}
      </div>

      <div className="ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Settings" />}
          >
            <Settings className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
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
      </div>

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
    </header>
  );
}
