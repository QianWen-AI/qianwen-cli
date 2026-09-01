/**
 * Unit tests for the site-availability guard — decides whether the current
 * deployment site offers any model for a given command, and raises a clear
 * not-available error otherwise.
 */
import { describe, it, expect } from 'vitest';
import { SiteAvailabilityGuard } from '../../src/services/site-availability.js';

function makeGuard(site: string, available: string[]): SiteAvailabilityGuard {
  return new SiteAvailabilityGuard({
    site: () => site,
    availableSites: new Set(available),
    command: 'model3d generate',
  });
}

describe('SiteAvailabilityGuard.assertAvailable', () => {
  it('passes when the current site offers a model', () => {
    const guard = makeGuard('qianwen', ['qianwen']);

    expect(() => guard.assertAvailable()).not.toThrow();
  });

  it('raises an INVALID_ARGUMENT error when the current site has no model', () => {
    const guard = makeGuard('qwencloud', ['qianwen']);

    expect(() => guard.assertAvailable()).toThrowError();
  });

  it('tags the not-available error with exit code 4', () => {
    const guard = makeGuard('qwencloud', ['qianwen']);

    try {
      guard.assertAvailable();
      throw new Error('expected assertAvailable to throw');
    } catch (error) {
      expect((error as { exitCode?: number }).exitCode).toBe(4);
      expect((error as { code?: string }).code).toBe('INVALID_ARGUMENT');
    }
  });

  it('names the command in the not-available message', () => {
    const guard = makeGuard('qwencloud', ['qianwen']);

    try {
      guard.assertAvailable();
      throw new Error('expected assertAvailable to throw');
    } catch (error) {
      expect((error as { message: string }).message).toContain('model3d generate');
    }
  });

  it('names the supported site and suggests the concrete CLI to use', () => {
    const guard = makeGuard('qwencloud', ['qianwen']);

    try {
      guard.assertAvailable();
      throw new Error('expected assertAvailable to throw');
    } catch (error) {
      const message = (error as { message: string }).message;
      expect(message).toContain('only available on qianwen');
      expect(message).toContain('qianwen model3d generate');
      expect(message).not.toContain('--request');
    }
  });

  it('falls back gracefully when no site offers the model', () => {
    const guard = makeGuard('qwencloud', []);

    try {
      guard.assertAvailable();
      throw new Error('expected assertAvailable to throw');
    } catch (error) {
      expect((error as { message: string }).message).toContain('no site currently offers a model');
    }
  });
});
