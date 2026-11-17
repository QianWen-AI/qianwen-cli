/** Supported plugin imports: errors, output helpers, version utilities, and PluginContext. */

// Errors — CliError has no `cause` field; use `detail` for diagnostics.
export {
  CliError,
  HandledError,
  handleError,
  authRequiredError,
  tokenExpiredError,
  modelNotFoundError,
  networkError,
  configError,
  invalidArgError,
  ticketNotFoundError,
  invalidDateRangeError,
  type CliErrorOptions,
} from '../utils/errors.js';

// Exit codes
export { EXIT_CODES, type ExitCode } from '../utils/exit-codes.js';

// Output helpers (pure, no react/ink)
export {
  outputJSON,
  outputText,
  formatTextTable,
  resolveFormatFromCommand,
} from '../output/format.js';

// Version + semver
export { VERSION } from '../version.js';
export { parseSemVer, isSemVerGreater, type ParsedSemVer } from '../utils/semver.js';

// Plugin context (config, directory, abort and the host-mediated OpenAPI proxy)
export type { PluginContext } from './loader.js';
