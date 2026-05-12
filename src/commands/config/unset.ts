import { isPublicKey } from '../../config/schema.js';
import { unsetConfigValue, getConfigValue } from '../../config/manager.js';
import { resolveFormat, outputJSON } from '../../output/format.js';
import { theme } from '../../ui/theme.js';
import { site } from '../../site.js';
import { handleError, configError } from '../../utils/errors.js';
import type { ConfigKey, OutputFormat } from '../../types/config.js';

export interface ConfigUnsetOptions {
  format?: string;
}

export function configUnset(key: string, opts: ConfigUnsetOptions, parentFormat?: string): void {
  const format = resolveFormat(
    opts.format ?? parentFormat,
    getConfigValue('output.format') as OutputFormat,
  );

  if (!isPublicKey(key)) {
    const msg = `Unknown config key '${key}'. Run \`${site.cliName} config list\` to see available keys.`;
    handleError(configError(msg), format);
  }

  unsetConfigValue(key as ConfigKey);

  if (format === 'json') {
    outputJSON({ ok: true, key, removed: true });
  } else {
    console.log(`${theme.success(theme.symbols.pass)}  Unset ${key}`);
  }
}
