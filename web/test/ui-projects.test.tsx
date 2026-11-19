// @vitest-environment jsdom
// Projects list: project rows carry the chevron, phases hang under them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectsNav } from '../src/components/ProjectsSidebar';
import { ProjectDetail } from '../src/components/ProjectDetail';
import { PHASES } from '../src/lib/phases';
import { PHASE_COUNTS } from '../src/lib/workitems';
import type { Agent } from '../src/lib/api';

afterEach(cleanup);

const AGENTS: Agent[] = [
  { name: 'greg', project: 'TaskFlow' },
  { name: 'ruben', project: 'TaskFlow' },
];

const renderNav = (props: Partial<React.ComponentProps<typeof ProjectsNav>> = {}) =>
  render(
    <ProjectsNav
      projects={['TaskFlow', 'ImmigApp']}
      agents={AGENTS}
      lastActivity={{}}
      selected={null}
      selectedPhase={0}
      expanded={new Set<string>()}
      onToggleExpand={() => {}}
      onSelect={() => {}}
      {...props}
    />,
  );

describe('ProjectsNav', () => {
  it('lists every project and hides phases until expanded', () => {
    renderNav();
    expect(screen.getByText('TaskFlow')).toBeTruthy();
    expect(screen.getByText('ImmigApp')).toBeTruthy();
    expect(screen.queryByText(/Phase 1 · Planning/)).toBeNull();
    expect(screen.getByLabelText('Expand TaskFlow')).toBeTruthy();
  });

  it('renders the eight phases under an expanded project', () => {
    renderNav({ expanded: new Set(['TaskFlow']) });
    for (let i = 0; i < PHASES.length; i += 1) {
      expect(screen.getByText(`Phase ${i + 1} · ${PHASES[i]}`)).toBeTruthy();
    }
  });

  it('selects a phase by index', () => {
    const onSelect = vi.fn();
    renderNav({ expanded: new Set(['TaskFlow']), onSelect });
    fireEvent.click(screen.getByText('Phase 4 · Implementation plan'));
    expect(onSelect).toHaveBeenCalledWith('TaskFlow', 3);
  });

  it('reports the chevron state through aria-expanded', () => {
    renderNav({ expanded: new Set(['TaskFlow']) });
    expect(screen.getByLabelText('Collapse TaskFlow').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the real phase number and index when the list is filtered', () => {
    // Regression: the offset came from the filtered array, so a search that
    // left only one phase renumbered it as "Phase 1" and selected phase 0.
    const onSelect = vi.fn();
    renderNav({ expanded: new Set(['TaskFlow']), onSelect });
    fireEvent.change(screen.getByPlaceholderText('Search projects and phases…'), {
      target: { value: 'test' },
    });
    fireEvent.click(screen.getByText('Phase 6 · Testing'));
    expect(onSelect).toHaveBeenCalledWith('TaskFlow', 5);
  });

  it('says "No matches" when a search finds nothing', () => {
    renderNav();
    fireEvent.change(screen.getByPlaceholderText('Search projects and phases…'), {
      target: { value: 'zzzz' },
    });
    expect(screen.getByText('No matches.')).toBeTruthy();
  });

  it('still shows seeded items for a project with no registered agents', () => {
    // Regression: the fallback agents existed in the data but the filter set
    // was empty, so a project without agents showed an empty board.
    render(
      <ProjectDetail project="first-project" phaseIndex={0} agents={[]} lastActivity={{}} />,
    );
    expect(screen.getByText(`${PHASE_COUNTS[0]} items`)).toBeTruthy();
  });

  it('says the projects could not be loaded when the read failed', () => {
    render(
      <ProjectsNav
        projects={[]}
        agents={[]}
        lastActivity={{}}
        error
        selected={null}
        selectedPhase={0}
        expanded={new Set<string>()}
        onToggleExpand={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/load projects/i)).toBeTruthy();
    expect(screen.queryByText('No projects found.')).toBeNull();
  });
});
