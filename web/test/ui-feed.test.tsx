// @vitest-environment jsdom
// Feed error state: a failed initial fetch must say so instead of spinning.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatFeed } from '../src/components/ChatFeed';

afterEach(cleanup);

describe('ChatFeed error state', () => {
  it('replaces the skeleton with an error and a Retry control', () => {
    const onRetry = vi.fn();
    render(<ChatFeed msgs={[]} ready={false} error onRetry={onRetry} resetKey="boss" />);

    expect(screen.getByText(/load messages/i)).toBeTruthy();
    expect(screen.queryByText(/No messages for this view yet/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('still shows the empty state when the fetch succeeded with no rows', () => {
    render(<ChatFeed msgs={[]} ready resetKey="boss" />);
    expect(screen.getByText(/No messages for this view yet/i)).toBeTruthy();
    expect(screen.queryByText(/load messages/i)).toBeNull();
  });
});
