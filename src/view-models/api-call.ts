import { stripVTControlCharacters } from 'node:util';

export interface ApiCallViewModel {
  rows: Array<{ field: string; value: string }>;
}

function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
}

function displayValue(value: unknown): string {
  return terminalText(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
}

export function buildApiCallViewModel(data: unknown): ApiCallViewModel {
  const entries: Array<[string, unknown]> = Array.isArray(data)
    ? data.map((value, index) => [`[${index}]`, value])
    : data !== null && typeof data === 'object'
      ? Object.entries(data)
      : [];
  if (entries.length === 0) entries.push(['$', data]);
  return {
    rows: entries.map(([field, value]) => ({
      field: terminalText(field),
      value: displayValue(value),
    })),
  };
}
