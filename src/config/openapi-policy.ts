import { getPluginsDir, getPluginsManifestPath } from './paths.js';
import { getDefaultPlugins } from '../plugins/defaults.js';
import { readCommittedInstalledPlugin } from '../plugins/default-install.js';
import { readInstalledManifest } from '../plugins/manifest.js';
import { parsePluginApiPolicy, type OpenApiPolicyRule } from '../plugins/api-policy.js';
import { VERSION } from '../version.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export type { OpenApiPolicyRule } from '../plugins/api-policy.js';

let reservedNames: ReadonlySet<string> = new Set();

export function setOpenApiPolicyReservedNames(names: ReadonlySet<string>): void {
  reservedNames = new Set(names);
}

function policyPair(product: string, action: string): string {
  return JSON.stringify([product, action]);
}

/** Read current metadata without importing executable code or preparing missing plugins. */
function readConfiguredOpenApiPolicy(): {
  rules: OpenApiPolicyRule[];
  conflicts: Set<string>;
} {
  const context = {
    pluginsDir: getPluginsDir(),
    manifestPath: getPluginsManifestPath(),
    cliVersion: VERSION,
    definitions: getDefaultPlugins(),
    reservedNames: new Set(reservedNames),
  };
  const state = readInstalledManifest(context.manifestPath);
  const rules: OpenApiPolicyRule[] = [];
  for (const record of state.plugins) {
    try {
      const definition = context.definitions.find((item) => item.name === record.name);
      const installed = readCommittedInstalledPlugin(record, context, state, definition);
      if (installed) rules.push(...(installed.manifest.apiPolicy ?? []));
    } catch {
      // An unusable package cannot relax authentication or transform responses.
    }
  }
  const settingsByPair = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const rule of rules) {
    const settings = JSON.stringify([rule.auth, rule.response ?? null]);
    for (const action of rule.actions) {
      const pair = policyPair(rule.product, action);
      const previous = settingsByPair.get(pair);
      if (previous !== undefined && previous !== settings) conflicts.add(pair);
      settingsByPair.set(pair, settings);
    }
  }
  return {
    rules: parsePluginApiPolicy(
      rules
        .map((rule) => ({
          ...rule,
          actions: rule.actions.filter(
            (action) => !conflicts.has(policyPair(rule.product, action)),
          ),
        }))
        .filter((rule) => rule.actions.length > 0),
    ),
    conflicts,
  };
}

export function getConfiguredOpenApiRules(): readonly OpenApiPolicyRule[] {
  return readConfiguredOpenApiPolicy().rules;
}

export function findConfiguredOpenApiPolicy(
  product: string,
  action: string,
): OpenApiPolicyRule | undefined {
  const { rules, conflicts } = readConfiguredOpenApiPolicy();
  // Keep conflicts distinct from missing policy so built-in anonymous access cannot apply.
  if (conflicts.has(policyPair(product, action))) {
    throw new CliError({
      code: 'PLUGIN_API_POLICY_CONFLICT',
      message: 'Conflicting plugin API policies block this operation.',
      exitCode: EXIT_CODES.CONFIG_ERROR,
      hint: 'Disable or uninstall the conflicting plugin, then retry.',
    });
  }
  return rules.find((rule) => rule.product === product && rule.actions.includes(action));
}
