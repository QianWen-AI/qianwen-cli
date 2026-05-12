import { isPublicKey, validateConfigValue } from '../../config/schema.js';
import { setConfigValue, getConfigValue } from '../../config/manager.js';
import { resolveFormat, outputJSON } from '../../output/format.js';
import { theme } from '../../ui/theme.js';
import { site } from '../../site.js';
import { handleError, configError } from '../../utils/errors.js';
import type { ConfigKey, OutputFormat } from '../../types/config.js';

export interface ConfigSetOptions {
  format?: string;
}

export function configSet(
  key: string,
  value: string,
  opts: ConfigSetOptions,
  parentFormat?: string,
): void {
  const format = resolveFormat(
    opts.format ?? parentFormat,
    getConfigValue('output.format') as OutputFormat,
  );

  if (!isPublicKey(key)) {
    const msg = `Unknown config key '${key}'. Run \`${site.cliName} config list\` to see available keys.`;
    handleError(configError(msg), format);
  }

  const validationError = validateConfigValue(key as ConfigKey, value);
  if (validationError) {
    handleError(configError(validationError), format);
  }

  setConfigValue(key as ConfigKey, value);

  if (format === 'json') {
    outputJSON({ ok: true, key, value });
  } else {
    console.log(`${theme.success(theme.symbols.pass)}  Set ${key} = ${value}`);
  }
}
