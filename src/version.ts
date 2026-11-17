import packageMetadata from '../package.json';

// Bundles receive an injected version; direct source runs use the same package version.
declare const __VERSION__: string;
export const VERSION: string =
  typeof __VERSION__ !== 'undefined' ? __VERSION__ : packageMetadata.version;
