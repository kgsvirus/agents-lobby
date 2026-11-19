import type { Metadata } from 'next';
import './globals.css';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

export const metadata: Metadata = {
  title: 'Agents-Lobby',
  description: 'Multi-project agent coordination lobby',
};

// Pre-hydration theme bootstrap (no visible flash): applies the persisted or
// system theme class before React mounts, matching the legacy app's
// first-render localStorage read. suppressHydrationWarning on <html> absorbs
// the class/colorScheme attribute difference between prerender and client.
const themeBootstrap = `try{var t=localStorage.getItem('lobby-theme');if(t!=='dark'&&t!=='light')t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.style.colorScheme=t}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
