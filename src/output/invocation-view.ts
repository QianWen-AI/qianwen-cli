/**
 * Human-readable rendering for the model-invocation commands.
 *
 * Every one of these commands returns the same `{meta, data}` success envelope,
 * so the presentation rules live here once instead of in seven command files:
 *   - `--format json`  -> the raw envelope, for Agent pipelines.
 *   - text / table     -> a short summary plus a dim trailing meta line.
 *
 * The PRD fixes *which fields* appear; the exact colouring/alignment is left to
 * the implementation, so we keep it to two-space indentation and dim accents.
 */

import { outputJSON, outputText } from './format.js';
import { theme } from '../ui/theme.js';
import { site } from '../site.js';
import type { SuccessEnvelope } from '../types/invocation-params.js';
import type { ResolvedFormat } from '../types/config.js';

/** Terminal output gets color/icon accents; piped output stays plain for scripts and tests. */
function styled(): boolean {
  return process.stdout.isTTY === true;
}

/** Completion headline: a green ✓ and bold title on a TTY, plain title otherwise. */
export function title(text: string): string {
  return styled() ? `${theme.success(theme.symbols.pass)} ${theme.bold(text)}` : text;
}

/** Dim a fixed-width field label (e.g. `audio_url`) so the value stands out. */
export function labelText(text: string): string {
  return styled() ? theme.dim(text) : text;
}

/** Emphasize a saved local path. */
function pathText(text: string): string {
  return styled() ? theme.accent(text) : text;
}

/** Dim a parenthetical hint such as the URL-expiry note. */
export function hintText(text: string): string {
  return styled() ? theme.dim(text) : text;
}

/** Color an async task status: PENDING/RUNNING amber, SUCCEEDED green, FAILED red. */
export function statusText(status: string): string {
  if (!styled()) return status;
  if (status === 'SUCCEEDED') return theme.success(status);
  if (status === 'FAILED') return theme.error(status);
  return theme.warning(status);
}

/** A dim middle-dot separator on a TTY, plain otherwise. */
export function dot(): string {
  return styled() ? theme.dim('·') : '·';
}

/** One artifact as produced by the services: a remote URL plus optional local path. */
export interface Artifact {
  url?: string;
  path?: string;
  b64?: string;
  type?: string;
  expires_in?: string;
  index?: number;
}

export interface RenderedView {
  /** Human-readable body; may span multiple lines. */
  body: string;
  /** Extra footer segments inserted between `model` and `request_id`. */
  footerExtras?: string[];
}

export function readString(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readNumber(
  source: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Read the normalized `images[]` array (`{index, url, path, expires_in}`). */
export function readImages(data: Record<string, unknown>): Artifact[] {
  const raw = data.images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is Artifact => Boolean(a) && typeof a === 'object');
}

/**
 * Trailing status line, e.g.
 *   `model qwen-image-2.0 · size 2048*2048 · request_id d0250a3d-...`
 *
 * `extra` segments are appended after `model` and before `request_id`, which is
 * the ordering the PRD examples use. Empty segments are dropped rather than
 * rendered blank. The request id is printed in full so it stays copy-pasteable
 * into a bug report.
 */
export function metaFooter(
  meta: SuccessEnvelope['meta'],
  extra: string[] = [],
): string | undefined {
  const segments: string[] = [];
  if (meta.model !== undefined) segments.push(`model ${meta.model}`);
  segments.push(...extra.filter((s) => s.length > 0));
  if (meta.request_id !== undefined) segments.push(`request_id ${meta.request_id}`);
  return segments.length > 0 ? segments.join(' · ') : undefined;
}

/** Token usage segment shared by the text modalities. */
export function tokenSegment(usage: Record<string, unknown> | undefined): string {
  const input = readNumber(usage, 'input_tokens');
  const output = readNumber(usage, 'output_tokens');
  const total = readNumber(usage, 'total_tokens');
  if (input === undefined && output === undefined && total === undefined) return '';
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${input} in`);
  if (output !== undefined) parts.push(`${output} out`);
  if (total !== undefined) parts.push(`${total} total`);
  return `tokens ${parts.join(' / ')}`;
}

/** Indent a detail line by two spaces, as the PRD examples do. */
export function detail(line: string): string {
  return `  ${line}`;
}

/**
 * Hint written to stderr when a chat response carries no content because the
 * generation was cut short. `length` means the token budget ran out (often the
 * reasoning phase consumed it all); `content_filter` means the output was
 * blocked. Returns undefined when no hint applies.
 */
export function emptyContentHint(
  content: string,
  finishReason: string | undefined,
): string | undefined {
  if (content.length > 0) return undefined;
  if (finishReason === 'length') {
    return 'No content returned: output was truncated by the token budget. Raise --max-tokens and retry.';
  }
  if (finishReason === 'content_filter') {
    return 'No content returned: output was blocked by the content filter.';
  }
  return undefined;
}

/** `已保存 <path>` style lines, hanging-indented when several paths follow. */
export function savedLines(paths: string[]): string[] {
  if (paths.length === 0) return [];
  const label = '已保存 ';
  const pad = ' '.repeat(8);
  return paths.map((p, i) => detail(`${i === 0 ? labelText(label) : pad}${pathText(p)}`));
}

/** URL-expiry hint reused by the media commands. */
export function expiryNote(expiresIn: string | undefined): string {
  return expiresIn !== undefined ? hintText(`（${expiresIn} 后失效）`) : '';
}

/** Shared "submitted" view for the asynchronous commands (`--no-wait`). */
export function submittedView(
  data: Record<string, unknown>,
  heading: string,
  note = '',
): RenderedView {
  const taskId = readString(data, 'task_id');
  const status = (readString(data, 'task_status') ?? 'PENDING').toUpperCase();
  const lines = [title(heading)];
  if (taskId !== undefined) {
    lines.push(
      detail(
        `${labelText('task_id')} ${taskId} ${dot()} ${labelText('status')} ${statusText(status)}`,
      ),
    );
    lines.push(detail(`可用 \`${site.cliName} task get ${taskId}\` 查询进度${note}`));
  } else {
    lines.push(detail(`${labelText('status')} ${statusText(status)}`));
  }
  return { body: lines.join('\n') };
}

/**
 * Print a rendered view, or the JSON envelope when the caller asked for JSON.
 * The body and the dim footer are separated by a blank line, per the examples.
 */
export interface MediaViewOptions {
  /** Headline, e.g. `语音合成完成`. */
  title: string;
  /** Label for the remote URL line, e.g. `audio_url`. */
  urlLabel: string;
  /** Validity window shown next to the URL, e.g. `24h`. */
  expiresIn?: string;
  /** Extra indented lines appended after the URL. */
  extraLines?: string[];
  /** Extra footer segments. */
  footerExtras?: string[];
}

/**
 * Shared view for the single-media commands (TTS, music): a headline, the local
 * path when the file was downloaded, and the origin URL with its expiry.
 */
export function mediaView(data: Record<string, unknown>, options: MediaViewOptions): RenderedView {
  const audio = data.audio && typeof data.audio === 'object' ? (data.audio as Artifact) : undefined;
  const lines = [title(options.title)];

  const path = typeof audio?.path === 'string' && audio.path.length > 0 ? audio.path : undefined;
  if (path !== undefined) lines.push(...savedLines([path]));

  if (typeof audio?.url === 'string' && audio.url.length > 0) {
    const expires = audio.expires_in ?? options.expiresIn;
    lines.push(detail(`${labelText(options.urlLabel)}  ${audio.url}${expiryNote(expires)}`));
  }

  if (options.extraLines) lines.push(...options.extraLines.map(detail));

  const view: RenderedView = { body: lines.join('\n') };
  if (options.footerExtras !== undefined) view.footerExtras = options.footerExtras;
  return view;
}

export function renderInvocation(
  envelope: SuccessEnvelope,
  format: ResolvedFormat,
  build: (data: Record<string, unknown>, meta: SuccessEnvelope['meta']) => RenderedView,
): void {
  if (format === 'json') {
    outputJSON(envelope);
    return;
  }

  const view = build(envelope.data, envelope.meta);
  const footer = metaFooter(envelope.meta, view.footerExtras ?? []);
  const blocks = [view.body];
  if (footer !== undefined) blocks.push(theme.dim(footer));
  outputText(blocks.filter((b) => b.length > 0).join('\n\n'));
}
