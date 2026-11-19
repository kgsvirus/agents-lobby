// @vitest-environment jsdom
// Settings menu and connection dialog: the shell's only stateful controls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SidebarProvider } from '../src/components/ui/sidebar';
import { TopNav } from '../src/components/TopNav';

afterEach(cleanup);

beforeEach(() => {
  // The header probes the auth mode on mount; no server in tests.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
});

// TopNav renders the SidebarTrigger, which needs the provider.
const renderNav = (props: Partial<React.ComponentProps<typeof TopNav>> = {}) =>
  render(
    <SidebarProvider>
      <TopNav module="chat" onModule={() => {}} theme="dark" onTheme={() => {}} {...props} />
    </SidebarProvider>,
  );

describe('TopNav settings', () => {
  it('opens the menu and then the connection dialog', async () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const item = await screen.findByText('Connection…');
    fireEvent.click(item);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText(/How this browser talks to the lobby/)).toBeTruthy();
  });

  it('toggles the theme from the menu', async () => {
    const onTheme = vi.fn();
    renderNav({ onTheme });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByText('Dark mode'));
    expect(onTheme).toHaveBeenCalledWith('light');
  });
});
