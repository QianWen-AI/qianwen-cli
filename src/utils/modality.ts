import type { Modality, ModalityType } from '../types/model.js';
import { CliError } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';

/** Runtime whitelist of valid modality values for --input / --output. */
export const MODALITY_VALUES = ['text', 'image', 'video', 'audio', 'vector'] as const;

/**
 * Validate a --input / --output flag value. Throws CliError(INVALID_MODALITY)
 * for unknown values so Agents can distinguish "no matching models" from
 * "you passed an unsupported modality value".
 */
export function validateModalityFlag(flag: string, value: string): string {
  if (!(MODALITY_VALUES as readonly string[]).includes(value)) {
    throw new CliError({
      code: 'INVALID_MODALITY',
      message: `Invalid value for ${flag}: '${value}'. Allowed: ${MODALITY_VALUES.join(', ')}`,
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });
  }
  return value;
}

/**
 * Format modality for table display.
 * Example: "Text+Img+Video→Text"
 */
export function formatModality(modality: Modality): string {
  const input = modality.input.map(abbreviateModality).join('+');
  const output = modality.output.map(abbreviateModality).join('+');
  return `${input}→${output}`;
}

/**
 * Abbreviate modality type for compact display.
 */
export function abbreviateModality(type: ModalityType): string {
  switch (type) {
    case 'text':
      return 'Text';
    case 'image':
      return 'Img';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'vector':
      return 'Vector';
    default:
      return type;
  }
}

/**
 * Format modality types for info display (full names, sorted).
 * Example: "Image  Text  Video"
 */
export function formatModalityList(types: ModalityType[]): string {
  return types
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .sort()
    .join('  ');
}
