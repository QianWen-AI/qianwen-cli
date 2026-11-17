import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenApiPolicyRule } from '../../src/config/openapi-policy.js';

export function apiPolicyFixtureRules(): OpenApiPolicyRule[] {
  return [
    {
      product: 'WebsitePortal',
      actions: ['SearchHub'],
      auth: 'optional',
      response: 'success-code-envelope',
    },
    { product: 'WebsitePortal', actions: ['GetHubSkill'], auth: 'optional' },
  ];
}

export function createApiPolicyTestRoot(prefix: string): string {
  const temporaryRoot = fileURLToPath(new URL('../../.local-test-tmp/', import.meta.url));
  mkdirSync(temporaryRoot, { recursive: true });
  return mkdtempSync(join(temporaryRoot, prefix));
}

export function seedApiPolicyPlugin(
  configRoot: string,
  rules: OpenApiPolicyRule[] = apiPolicyFixtureRules(),
): void {
  const name = '@qianwenai/api-policy-fixture';
  const command = 'policyfixture';
  const directory = join(configRoot, 'plugins', 'node_modules', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      qianwen: {
        command,
        entry: './index.mjs',
        handlerKey: 'run',
        minCliVersion: '1.0.0',
        auth: 'optional',
        apiPolicy: rules,
      },
    }),
  );
  writeFileSync(
    join(directory, 'index.mjs'),
    'throw new Error("API policy lookup must not import the fixture entry");\nexport const handlers = { run() {} };\n',
  );
  const manifestPath = join(configRoot, 'plugins.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      plugins: [{ name, command, version: '1.0.0', enabled: true, source: 'npm' }],
    }),
  );
}

export function removeApiPolicyPluginRecord(configRoot: string): void {
  writeFileSync(join(configRoot, 'plugins.json'), JSON.stringify({ plugins: [] }));
}
