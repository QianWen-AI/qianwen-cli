import { isPublicKey } from '../../config/schema.js';
import { getConfigValue, getConfigValueWithSource } from '../../config/manager.js';
import { resolveFormat, outputJSON, outputText } from '../../output/format.js';
import { handleError, configError } from '../../utils/errors.js';
import { site } from '../../site.js';
import type { ConfigKey, OutputFormat } from '../../types/config.js';

export function configGet(key: string, opts: { format?: string }, parentFormat?: string): void {
  const format = resolveFormat(
    opts.format ?? parentFormat,
    getConfigValue('output.format') as OutputFormat,
  );

  if (!isPublicKey(key)) {
    handleError(
      configError(
        `Unknown config key '${key}'. Run \`${site.cliName} config list\` to see available keys.`,
      ),
      format,
    );
  }

  const resolved = getConfigValueWithSource(key as ConfigKey);

  if (format === 'json') {
    outputJSON({
      key,
      value: resolved.value,
      source: resolved.source,
      ...(resolved.sourcePath ? { source_path: resolved.sourcePath } : {}),
    });
    return;
  }

  outputText(resolved.value);
}
