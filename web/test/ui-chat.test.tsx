// @vitest-environment jsdom
// Rendered-behaviour tests for the chat list, composer gating and bubbles.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { ChatNav } from '../src/components/Sidebar';
import { Composer } from '../src/components/Composer';
import { MessageBubble } from '../src/components/MessageBubble';
import type { Agent, View } from '../src/lib/api';

afterEach(cleanup);

const AGENTS: Agent[] = [
  { name: 'greg', project: 'TaskFlow' },
  { name: 'marvin', project: 'ImmigApp' },
];

const renderNav = (props: Partial<React.ComponentProps<typeof ChatNav>> = {}) =>
  render(
    <ChatNav
      agents={AGENTS}
      recents={[]}
      lastActivity={{}}
      view={{ kind: 'boss' } as View}
      collapsed={new Set<string>()}
      onToggleExpand={() => {}}
      onSelect={() => {}}
      {...props}
    />,
  );

describe('ChatNav', () => {
  it('renders boss, all projects, each project and its agents', () => {
    renderNav();
    expect(screen.getByText('Boss')).toBeTruthy();
    expect(screen.getByText('All projects')).toBeTruthy();
    expect(screen.getByText('TaskFlow')).toBeTruthy();
    expect(screen.getByText('greg')).toBeTruthy();
    expect(screen.getByText('marvin')).toBeTruthy();
  });

  it('selects a project with the project view', () => {
    const onSelect = vi.fn();
    renderNav({ onSelect });
    fireEvent.click(screen.getByText('TaskFlow').closest('button')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toEqual({ kind: 'project', name: 'TaskFlow' });
  });

  it('hides the agents of a collapsed project and reports aria-expanded', () => {
    renderNav({ collapsed: new Set(['TaskFlow']) });
    expect(screen.queryByText('greg')).toBeNull();
    expect(screen.getByText('marvin')).toBeTruthy();
    expect(screen.getByLabelText('Expand TaskFlow').getAttribute('aria-expanded')).toBe('false');
  });

  it('toggles a project from its own control', () => {
    const onToggleExpand = vi.fn();
    renderNav({ onToggleExpand });
    fireEvent.click(screen.getByLabelText('Collapse TaskFlow'));
    expect(onToggleExpand).toHaveBeenCalledWith('TaskFlow');
  });

  it('filters the list by name', () => {
    renderNav();
    fireEvent.change(screen.getByPlaceholderText('Search conversations…'), {
      target: { value: 'ImmigApp' },
    });
    expect(screen.queryByText('TaskFlow')).toBeNull();
    expect(screen.getByText('ImmigApp')).toBeTruthy();
  });
});

describe('Composer gating', () => {
  it('disables Send when no recipient is selected', () => {
    render(<Composer agents={AGENTS} view={{ kind: 'project', name: 'Nope' }} onSent={() => {}} />);
    expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables the recipient picker in the boss view', () => {
    render(<Composer agents={AGENTS} view={{ kind: 'boss' }} onSent={() => {}} />);
    expect(
      (screen.getByRole('button', { name: /recipients/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('MessageBubble', () => {
  const msg = (id: number, from: string, text = 'hello') => ({
    id,
    time: '2026-11-20T00:27:00.000Z',
    from,
    to: from === 'human' ? 'boss' : null,
    text,
  });

  it('labels the boss bubble and floats the human bubble right', () => {
    const { container } = render(
      <TooltipProvider>
        <MessageBubble m={msg(1, 'boss')} />
        <MessageBubble m={msg(2, 'human')} />
      </TooltipProvider>,
    );
    expect(screen.getByText(/^Boss · \d{2}:\d{2}$/)).toBeTruthy();
    expect(container.querySelector('[data-id="1"]')!.className).not.toContain('ml-auto');
    expect(container.querySelector('[data-id="2"]')!.className).toContain('ml-auto');
  });

  it('renders markdown instead of raw markers', () => {
    const { container } = render(
      <TooltipProvider>
        <MessageBubble m={msg(3, 'boss', '**bold** and `code`')} />
      </TooltipProvider>,
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.textContent).not.toContain('**');
  });

  it('opens links in a new tab and does not embed remote images', () => {
    const { container } = render(
      <TooltipProvider>
        <MessageBubble m={msg(5, 'boss', '[site](https://example.com) ![shot](https://t.example/p.png)')} />
      </TooltipProvider>,
    );
    const link = screen.getByRole('link', { name: 'site' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[image: shot]');
  });

  it('no longer renders an avatar chip in the label', () => {
    const { container } = render(
      <TooltipProvider>
        <MessageBubble m={msg(4, 'boss')} />
      </TooltipProvider>,
    );
    expect(container.querySelector('[data-slot="avatar"]')).toBeNull();
  });
});
