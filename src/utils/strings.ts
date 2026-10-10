/**
 * Standard Levenshtein edit distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Return the closest candidate within a length-scaled edit-distance threshold, or null. */
export function didYouMean(input: string, candidates: string[]): string | null {
  if (!input || candidates.length === 0) return null;

  const q = input.toLowerCase();
  const best = candidates
    .map((c) => ({ c, d: levenshtein(q, c.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)[0];

  const threshold = Math.max(2, Math.floor(input.length * 0.5));
  return best.d <= threshold ? best.c : null;
}

const PAYMENT_REDACTION = '[REDACTED]';
declare const __NODE_ENV__: string;

/**
 * Structural redaction targets payment credential fields only.
 * Generic "token"-named business fields (e.g. nextPageToken, refreshToken used as
 * pagination cursors or non-credential context) are intentionally excluded to avoid
 * masking diagnostically useful data. Text-level redaction (redactPaymentText) still
 * catches Bearer tokens and access_token patterns in raw strings.
 */
const PAYMENT_FIELD_NAMES = new Set(['nbid', 'accesstoken', 'cliaccesstoken', 'authorization']);
/** Exact payment hosts accepted by URL validation. */
export const PAYMENT_URL_HOSTS: readonly string[] = [
  'account.qianwenai.com',
  'cashier.alipay.com',
  'excashier.alipay.com',
  'qr.alipay.com',
  ...(typeof __NODE_ENV__ === 'undefined' || __NODE_ENV__ !== 'production'
    ? ['pay.test.qianwenai.com']
    : []),
];
const LABELED_PAYMENT_VALUE_PATTERN = /\bNbid["']?\s*[:=]\s*["']?([^\s;,"'<>}]+)/giu;
const PAYMENT_ERROR_CONTEXTS = new WeakMap<Error, unknown[]>();

/**
 * Validate that a payment URL uses HTTPS and belongs to the exact host allowlist.
 * Host suffix matching is intentionally not supported because it would allow
 * lookalike domains such as `allowed.example.evil.test`.
 *
 * @param value Raw payment URL returned by the billing API.
 * @param allowedHosts Exact hostnames permitted to receive payment traffic.
 * @returns The parsed, validated URL.
 * @throws {Error} When the URL is malformed, non-HTTPS, contains credentials,
 * or is outside the allowlist.
 */
export function validatePaymentUrl(value: string, allowedHosts: readonly string[]): URL {
  if (value !== value.trim() || hasAsciiControlCharacter(value)) {
    throw new Error('Invalid payment URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid payment URL.');
  }

  const hosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !hosts.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error('Payment URL is not allowed.');
  }
  return parsed;
}

/**
 * Reject characters that the URL parser may silently strip or normalize.
 *
 * @param value Raw URL returned by the billing API.
 * @returns Whether the value contains a C0 control character or DEL.
 */
function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Recursively redact Nbid and credential values from a value before it is written to a
 * diagnostic, HTTP debug or error sink. Recharge order IDs and payment URLs
 * remain visible because they are user-facing payment results.
 *
 * The function performs a collection pass first so a value discovered under a
 * sensitive field is also removed when repeated inside an unrelated message,
 * including its URL-encoded representation. The input is never mutated.
 *
 * @param value Arbitrary diagnostic data, including nested objects and Errors.
 * @returns A detached representation with payment data replaced by a marker.
 */
export function redactPaymentData(value: unknown): unknown {
  const secrets = new Set<string>();
  collectPaymentSecrets(value, secrets, new WeakSet<object>());
  return redactPaymentValue(value, secrets, new WeakMap<object, unknown>());
}

/**
 * Associate request-bound payment data with an Error for later sink redaction.
 *
 * The Error is deliberately not mutated: classifiers and callers must retain
 * its original message, stack, code, custom fields, cause chain, and identity.
 * {@link redactPaymentData} discovers the associated context when the Error is
 * eventually copied at a diagnostic boundary.
 *
 * @param error Error whose diagnostic context should be registered.
 * @param context Optional request/response context used to discover bare values.
 * @returns The unchanged original error instance.
 */
export function redactPaymentError(error: Error, context?: unknown): Error {
  if (context !== undefined) {
    const contexts = PAYMENT_ERROR_CONTEXTS.get(error);
    if (contexts) contexts.push(context);
    else PAYMENT_ERROR_CONTEXTS.set(error, [context]);
  }
  return error;
}

/**
 * Collect known payment values without mutating the diagnostic input.
 *
 * @param value Value currently being inspected.
 * @param secrets Accumulator for sensitive values.
 * @param seen Cycle guard for nested objects.
 * @param fieldName Owning field name, when available.
 */
function collectPaymentSecrets(
  value: unknown,
  secrets: Set<string>,
  seen: WeakSet<object>,
  fieldName?: string,
): void {
  if (
    fieldName &&
    isPaymentField(fieldName) &&
    (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')
  ) {
    addSecret(secrets, String(value));
  }
  if (typeof value === 'string') {
    collectSecretsFromText(value, secrets, seen);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  if (value instanceof Error) {
    for (const context of PAYMENT_ERROR_CONTEXTS.get(value) ?? []) {
      collectPaymentSecrets(context, secrets, seen);
    }
    collectPaymentSecrets(value.message, secrets, seen, 'message');
    if (value.stack) collectPaymentSecrets(value.stack, secrets, seen, 'stack');
    collectPaymentSecrets(value.cause, secrets, seen, 'cause');
  }

  for (const key of Reflect.ownKeys(value)) {
    const keyName = String(key);
    let nested: unknown;
    try {
      nested = Reflect.get(value, key);
    } catch {
      continue;
    }
    collectPaymentSecrets(nested, secrets, seen, keyName);
  }
}

/**
 * Extract labeled Nbid values embedded in free-form error text.
 *
 * @param text Diagnostic text to inspect.
 * @param secrets Accumulator for discovered values.
 */
function collectSecretsFromText(text: string, secrets: Set<string>, seen: WeakSet<object>): void {
  for (const match of text.matchAll(LABELED_PAYMENT_VALUE_PATTERN)) {
    if (match[1]) addSecret(secrets, match[1]);
  }
  for (const match of text.matchAll(
    /\b(?:Bearer\s+|(?:cli[_-]?)?access[_-]?token["']?\s*[:=]\s*["']?)([^\s;&,"'<>}\]]+)/giu,
  )) {
    addSecret(secrets, match[1]);
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
  try {
    collectPaymentSecrets(JSON.parse(trimmed), secrets, seen);
  } catch {
    // Free-form diagnostic text is allowed to contain malformed JSON fragments.
  }
}

/**
 * Build a redacted copy while retaining enough safe context for diagnosis.
 *
 * @param value Value currently being copied.
 * @param secrets Sensitive raw and encoded values to remove.
 * @param seen Cycle and identity map for nested objects.
 * @param fieldName Owning field name, when available.
 * @returns Redacted detached value.
 */
function redactPaymentValue(
  value: unknown,
  secrets: ReadonlySet<string>,
  seen: WeakMap<object, unknown>,
  fieldName?: string,
): unknown {
  if (fieldName && isPaymentField(fieldName)) return PAYMENT_REDACTION;
  if (typeof value === 'string') return redactPaymentText(value, secrets);
  if (!value || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactPaymentValue(item, secrets, seen));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  if (value instanceof Error) {
    copy.name = value.name;
    copy.message = redactPaymentText(value.message, secrets);
    if (value.stack) copy.stack = redactPaymentText(value.stack, secrets);
    if (value.cause !== undefined) {
      copy.cause = redactPaymentValue(value.cause, secrets, seen, 'cause');
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    const keyName = String(key);
    let nested: unknown;
    try {
      nested = Reflect.get(value, key);
    } catch {
      continue;
    }
    copy[keyName] = redactPaymentValue(nested, secrets, seen, keyName);
  }
  return copy;
}

/**
 * Replace both raw and encoded forms, longest first to avoid partial leaks.
 *
 * @param text Text to sanitize.
 * @param secrets Sensitive values collected from the containing diagnostic.
 * @returns Redacted text.
 */
function redactPaymentText(text: string, secrets: ReadonlySet<string>): string {
  let result = text;
  const variants = new Set<string>();
  for (const secret of secrets) {
    variants.add(secret);
    try {
      variants.add(encodeURIComponent(secret));
    } catch {
      // Malformed surrogate pairs cannot be encoded but the raw form remains covered.
    }
  }
  for (const secret of [...variants].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = replacePaymentSecret(result, secret);
  }
  return result;
}

/** Replace a secret only as a complete token. */
function replacePaymentSecret(text: string, secret: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(secret, cursor);
    if (index < 0) {
      result += text.slice(cursor);
      break;
    }

    const before = index > 0 ? text[index - 1] : undefined;
    const afterIndex = index + secret.length;
    const after = afterIndex < text.length ? text[afterIndex] : undefined;
    const hasLeftBoundary = !isIdentifierCharacter(secret[0]) || !isIdentifierCharacter(before);
    const hasRightBoundary =
      !isIdentifierCharacter(secret[secret.length - 1]) || !isIdentifierCharacter(after);

    result += text.slice(cursor, index);
    if (hasLeftBoundary && hasRightBoundary) {
      result += PAYMENT_REDACTION;
    } else {
      result += secret;
    }
    cursor = afterIndex;
  }
  return result;
}

/** Whether a character can continue an unquoted identifier or numeric value. */
function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[a-z0-9_]/iu.test(value);
}

/**
 * Normalize an API field name before applying the sensitive-field allowlist.
 *
 * @param fieldName Source object field name.
 * @returns Whether the field directly carries payment-sensitive data.
 */
function isPaymentField(fieldName: string): boolean {
  return PAYMENT_FIELD_NAMES.has(fieldName.replace(/[^a-z0-9]/giu, '').toLowerCase());
}

/**
 * Record non-empty secrets only; masking empty strings would corrupt all text.
 *
 * @param secrets Sensitive-value accumulator.
 * @param value Candidate value.
 */
function addSecret(secrets: Set<string>, value: string): void {
  if (value) secrets.add(value);
}
