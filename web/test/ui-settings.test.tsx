// @vitest-environment jsdom
// Settings now live in the rail (the header is breadcrumb only).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Rail } from '../src/components/Rail';

afterEach(cleanup);

beforeEach(() => {
  // The rail probes the auth mode on mount; no server in tests.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
});

const renderRail = (props: Partial<React.ComponentProps<typeof Rail>> = {}) =>
  render(<Rail module="chat" onModule={() => {}} theme="dark" onTheme={() => {}} {...props} />);

describe('Rail', () => {
  it('switches modules from the rail', () => {
    const onModule = vi.fn();
    renderRail({ onModule });
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(onModule).toHaveBeenCalledWith('projects');
  });

  it('opens the settings menu and then the connection dialog', async () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const item = await screen.findByText('Connection…');
    fireEvent.click(item);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText(/How this browser talks to the lobby/)).toBeTruthy();
  });

  it('toggles the theme from the menu', async () => {
    const onTheme = vi.fn();
    renderRail({ onTheme });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByText('Dark mode'));
    expect(onTheme).toHaveBeenCalledWith('light');
  });
});
