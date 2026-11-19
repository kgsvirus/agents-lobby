// @vitest-environment jsdom
// Flow board: seeded items, filters and the header controls.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FlowBoard } from '../src/components/FlowBoard';
import { seedWorkItems, PHASE_COUNTS, TOTAL_COUNT, STATUSES } from '../src/lib/workitems';

afterEach(cleanup);

const AGENTS = ['greg', 'ruben', 'Dummy'];

const renderBoard = (phaseIndex = 0) => {
  const items = seedWorkItems('TaskFlow', phaseIndex, AGENTS);
  const utils = render(
    <FlowBoard
      phaseIndex={phaseIndex}
      phaseLabel="Planning"
      agentNames={AGENTS}
      items={items}
    />,
  );
  return { ...utils, items };
};

describe('seeded work items', () => {
  it('is deterministic and matches the published per-phase counts', () => {
    const a = seedWorkItems('TaskFlow', 0, AGENTS);
    const b = seedWorkItems('TaskFlow', 0, AGENTS);
    expect(a).toEqual(b);
    expect(a).toHaveLength(PHASE_COUNTS[0]);
    expect(PHASE_COUNTS.reduce((x, y) => x + y, 0)).toBe(TOTAL_COUNT);
  });

  it('gives every item a unique id and a known status', () => {
    const all = PHASE_COUNTS.flatMap((_, i) => seedWorkItems('TaskFlow', i, AGENTS));
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    expect(all.every((i) => (STATUSES as readonly string[]).includes(i.status))).toBe(true);
  });

  it('falls back to stand-in agents when the project has none', () => {
    const items = seedWorkItems('Empty', 0, []);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.agent.length > 0)).toBe(true);
  });
});

describe('FlowBoard', () => {
  it('renders the count and every status column', () => {
    const { items } = renderBoard(0);
    expect(screen.getByText(`${items.length} items`)).toBeTruthy();
    for (const status of STATUSES) {
      expect(screen.getByText(status, { selector: 'h3' })).toBeTruthy();
    }
  });

  it('filters by status through the dropdown', () => {
    const { items } = renderBoard(0);
    fireEvent.click(screen.getByRole('button', { name: /Filter:/ }));
    fireEvent.click(screen.getByLabelText('To do'));

    const todoCount = items.filter((i) => i.status === 'To do').length;
    expect(screen.queryByText('To do', { selector: 'h3' })).toBeNull();
    expect(screen.getByText(`${items.length - todoCount} items`)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Filter: 1/ })).toBeTruthy();
  });

  it('filters by tag and by search text', () => {
    const { items } = renderBoard(0);
    fireEvent.click(screen.getByRole('button', { name: /Filter:/ }));
    fireEvent.click(screen.getByLabelText('spec'));
    fireEvent.click(screen.getByRole('button', { name: /Filter:/ })); // close panel
    const specCount = items.filter((i) => i.tag !== 'spec').length;
    expect(screen.getByText(`${specCount} items`)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Filter work items…'), {
      target: { value: 'zzzz-no-match' },
    });
    expect(screen.getByText('0 items')).toBeTruthy();
  });

  it('Clear restores search and every facet', () => {
    renderBoard(0);
    fireEvent.click(screen.getByRole('button', { name: /Filter:/ }));
    fireEvent.click(screen.getByLabelText('To do'));
    fireEvent.change(screen.getByPlaceholderText('Filter work items…'), {
      target: { value: 'agent' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByRole('button', { name: /Filter: all/ })).toBeTruthy();
    expect((screen.getByPlaceholderText('Filter work items…') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(`${PHASE_COUNTS[0]} items`)).toBeTruthy();
  });

  it('shows the sample badge and the phase label', () => {
    renderBoard(1);
    expect(screen.getByText('sample')).toBeTruthy();
    const header = screen.getByText(/Flow board/);
    expect(header.parentElement?.textContent).toContain('Phase 2');
  });

  it('marks a column empty instead of drawing a card', () => {
    // Phase 3 (index 2) has an empty "Ready for testing" column by design.
    renderBoard(2);
    const column = screen.getByText('Ready for testing', { selector: 'h3' }).closest('section');
    expect(column).toBeTruthy();
    expect(within(column as HTMLElement).getByText('No items')).toBeTruthy();
  });

  it('re-checks the agent facet when the project roster changes', () => {
    // Regression: the agent set was seeded once, so a project switch (or an
    // agent registering mid-session) filtered every card out.
    const first = seedWorkItems('TaskFlow', 0, ['greg']);
    const { rerender } = render(
      <FlowBoard phaseIndex={0} phaseLabel="Planning" agentNames={['greg']} items={first} />,
    );
    expect(screen.getByText(`${first.length} items`)).toBeTruthy();

    const second = seedWorkItems('ImmigApp', 0, ['marvin']);
    rerender(
      <FlowBoard phaseIndex={0} phaseLabel="Planning" agentNames={['marvin']} items={second} />,
    );
    expect(screen.getByText(`${second.length} items`)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Filter: all/ })).toBeTruthy();
  });

  it('never shows a negative filter count', () => {
    const items = seedWorkItems('TaskFlow', 0, ['greg', 'ruben']);
    const { rerender } = render(
      <FlowBoard phaseIndex={0} phaseLabel="Planning" agentNames={['greg', 'ruben']} items={items} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Filter:/ }));
    fireEvent.click(screen.getByLabelText('ruben'));
    fireEvent.click(screen.getByRole('button', { name: /Filter:/ }));
    // Roster shrinks below the current selection.
    rerender(<FlowBoard phaseIndex={0} phaseLabel="Planning" agentNames={['greg']} items={items} />);
    expect(screen.queryByText(/Filter: -/)).toBeNull();
  });
});
