// Neutral error contract tests (integrations/opencode/errors.ts): rich
// transport failures map to PortError with a code and a safe message; rich
// details (pathname/status/body/URL) are logged inside the adapter and NEVER
// carried on the thrown value.
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeRequestError } from '../src/integrations/opencode/client.js';
import { PortError, toPortError } from '../src/integrations/opencode/errors.js';

describe('toPortError (neutral error contract at the port boundary)', () => {
  it('maps HTTP upstream errors to code "upstream-error" without leaking pathname/status/body', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rich = new OpenCodeRequestError('/api/session/ses_1/prompt', 500, 'secret upstream body');
    const neutral = toPortError('prompt delivery to ses_1', rich);
    expect(neutral).toBeInstanceOf(PortError);
    expect(neutral.code).toBe('upstream-error');
    // Safe message: no URL, no pathname, no raw body.
    expect(neutral.message).not.toMatch(/https?:\/\//);
    expect(neutral.message).not.toContain('/api/');
    expect(neutral.message).not.toContain('secret upstream body');
    // Rich details logged inside the adapter, never attached to the thrown error.
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('maps missing discovery / network failures to code "unavailable"', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toPortError('op', new OpenCodeRequestError('/p', 0, 'no url')).code).toBe('unavailable');
    expect(toPortError('op', new OpenCodeRequestError('/p', 0, 'ECONNREFUSED', new Error('fetch failed'))).code).toBe('unavailable');
    errSpy.mockRestore();
  });

  it('maps aborted/timed-out requests to code "timeout"', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toPortError('op', new OpenCodeRequestError('/p', 0, 'aborted', { name: 'TimeoutError' })).code).toBe('timeout');
    expect(toPortError('op', new OpenCodeRequestError('/p', 0, 'aborted', { name: 'AbortError' })).code).toBe('timeout');
    errSpy.mockRestore();
  });

  it('maps validation failures at the trust boundary to code "invalid-response"', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toPortError('op', new Error('malformed payload')).code).toBe('invalid-response');
    errSpy.mockRestore();
  });

  it('PortError itself carries only code + message — no transport fields, no cause', () => {
    const err = new PortError('unavailable', 'op failed (unavailable)');
    // `message`/`stack` are non-enumerable own props on Error; `name`/`code`
    // are the assigned own fields. Enumerability itself proves nothing extra
    // is bolted on.
    expect(Object.keys(err).sort()).toEqual(['code', 'name']);
    expect(err.code).toBe('unavailable');
    expect(err.message).toBe('op failed (unavailable)');
    expect(err).not.toHaveProperty('pathname');
    expect(err).not.toHaveProperty('status');
    expect(err).not.toHaveProperty('body');
    expect(err).not.toHaveProperty('cause');
    expect(err.message).not.toMatch(/https?:\/\//);
  });
});
