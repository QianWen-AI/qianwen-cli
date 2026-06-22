/**
 * File-input resolver — classify user-supplied resource strings and
 * verify local-path existence. Pure functions only; no network or
 * filesystem state retained between calls.
 */

import { existsSync, statSync } from 'node:fs';

import { CliError } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';
import type { FileResourceType } from '../types/file-input.js';

const HTTP_RE = /^https?:\/\//i;

/**
 * Categorise an input token into a resource type. The classification
 * is purely syntactic: callers are responsible for asserting the
 * physical preconditions (e.g., local file existence).
 */
export function classifyResource(input: string): FileResourceType {
  if (typeof input !== 'string') return 'local';
  const trimmed = input.trim();
  if (trimmed.startsWith('oss://')) return 'oss';
  if (HTTP_RE.test(trimmed)) return 'http';
  return 'local';
}

/**
 * Assert that the supplied path exists and is a regular file. Surfaces
 * a CliError mapped to the input-validation exit code so the command
 * layer can render a user-friendly message and terminate with the
 * documented status.
 */
export function assertLocalExists(path: string): void {
  if (!path || typeof path !== 'string') {
    throw new CliError({
      code: 'FILE_NOT_FOUND',
      message: 'File path is empty.',
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }

  if (!existsSync(path)) {
    throw new CliError({
      code: 'FILE_NOT_FOUND',
      message: `File not found: ${path}`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new CliError({
      code: 'FILE_NOT_FOUND',
      message: `File not accessible: ${path}`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
  if (!stat.isFile()) {
    throw new CliError({
      code: 'FILE_NOT_FOUND',
      message: `Path is not a regular file: ${path}`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
}

/**
 * Infer modality from a URL's terminal extension. Used for already-public
 * resources (http/oss) where MIME detection via magic-bytes is not viable
 * without an extra round-trip. Returns null when the extension is
 * unrecognised; callers fall back to a default modality.
 */
export function inferModalityFromUrl(url: string): 'image' | 'video' | 'audio' | null {
  const cleaned = url.split('?')[0]?.split('#')[0] ?? '';
  const idx = cleaned.lastIndexOf('.');
  if (idx < 0) return null;
  const ext = cleaned.slice(idx + 1).toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return 'audio';
  return null;
}
