/**
 * Tests for SkillsInstallService.installMember — defense-in-depth path
 * boundary check that rejects skill names resolving outside baseDir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillsInstallService } from '../../src/services/skills-install-service.js';
import type { SkillsHubService } from '../../src/services/skills-hub-service.js';
import { buildZip } from '../fixtures/zip-builder.js';

const memberZip = () =>
  buildZip([{ path: 'SKILL.md', data: '# Skill', method: 8, useDataDescriptor: true }]);

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'qianwen-install-member-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeService(): SkillsInstallService {
  const hub = {} as unknown as SkillsHubService;
  return new SkillsInstallService(hub);
}

describe('SkillsInstallService.installMember — path boundary defense', () => {
  it.each(['../../../../.ssh', '../../../tmp', 'valid/../../../escape'])(
    'throws INSTALL_FAILED when skillName %j escapes baseDir',
    async (maliciousSkillName) => {
      const svc = makeService();

      await expect(
        svc.installMember({
          provider: '@qianwen-ai',
          skillName: maliciousSkillName,
          version: '1.0.0',
          zipBuffer: memberZip(),
          baseDir,
        }),
      ).rejects.toMatchObject({
        code: 'INSTALL_FAILED',
        message: expect.stringContaining('resolves outside the base directory'),
        exitCode: 1,
      });
    },
  );

  it('allows a valid skillName within baseDir', async () => {
    const svc = makeService();
    const zip = memberZip();

    const result = await svc.installMember({
      provider: '@qianwen-ai',
      skillName: 'test-skill',
      version: '1.0.0',
      zipBuffer: zip,
      baseDir,
    });

    expect(result.targetDir).toBe(path.join(baseDir, 'test-skill'));
  });
});
