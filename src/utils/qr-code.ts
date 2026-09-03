import qrcode from 'qrcode-generator';

/** A QR grid where `true` is a dark module. Includes the surrounding quiet zone. */
export type QrModules = readonly (readonly boolean[])[];

/** One styled run of cells inside a rendered QR row. */
export interface QrSegment {
  readonly text: string;
  readonly backgroundColor: 'black' | 'white';
  readonly color?: 'black' | 'white';
}

// The stock byte converter truncates each UTF-16 unit to `c & 0xff`, which
// silently corrupts any non-ASCII payment URL. Swap in UTF-8 so the original
// input is encoded byte-for-byte. This mirrors the upstream `qrcode_UTF8`
// bundle, which the package's `exports` map makes unimportable directly.
qrcode.stringToBytes = (value: string): number[] => Array.from(new TextEncoder().encode(value));

// Low correction keeps payment-link QR codes about 8-10% smaller than level M.
// The exact payment link remains visible as a fallback whenever scanning fails.
const ERROR_CORRECTION_LEVEL = 'L';

const QUIET_ZONE_MODULES = 4;

// Version 10 spans 57 modules. Payment URLs observed by the CLI sit far below
// its 271-byte budget at level L; bounding the grid avoids unexpectedly wide
// terminal output that cannot be rendered intact.
const MAX_MODULE_COUNT = 10 * 4 + 17;

/**
 * Encode text into a QR Model 2 grid using UTF-8 byte mode.
 *
 * Type number 0 selects the smallest version that fits, and the library scores
 * all eight mask patterns to pick the lowest-penalty one. Mask choice is what
 * decides whether the code survives a phone camera: a fixed mask can leave the
 * payload as a one-module checkerboard that blurs into flat grey at terminal
 * scale, which no amount of error correction recovers.
 *
 * The input is encoded byte-for-byte; it is never parsed, decoded, normalized,
 * or truncated.
 *
 * @param value Exact text to encode.
 * @returns A square grid padded with the mandatory four-module quiet zone.
 */
export function encodeQrModules(value: string): QrModules {
  if (value.length === 0) throw new Error('QR content must not be empty.');

  const qr = qrcode(0, ERROR_CORRECTION_LEVEL);
  qr.addData(value, 'Byte');
  qr.make();

  const size = qr.getModuleCount();
  if (size > MAX_MODULE_COUNT) {
    throw new Error('Payment URL is too long to encode as a terminal QR code.');
  }

  const total = size + QUIET_ZONE_MODULES * 2;
  return Array.from({ length: total }, (_, y) =>
    Array.from({ length: total }, (_, x) => {
      const row = y - QUIET_ZONE_MODULES;
      const column = x - QUIET_ZONE_MODULES;
      return row >= 0 && row < size && column >= 0 && column < size && qr.isDark(row, column);
    }),
  );
}

/** Append one cell, extending the previous run when it carries the same style. */
function pushCell(
  row: QrSegment[],
  text: string,
  backgroundColor: QrSegment['backgroundColor'],
  color?: QrSegment['color'],
): void {
  const last = row[row.length - 1];
  if (last && last.backgroundColor === backgroundColor && last.color === color) {
    row[row.length - 1] = { ...last, text: last.text + text };
    return;
  }
  row.push(color === undefined ? { text, backgroundColor } : { text, backgroundColor, color });
}

/**
 * Project two vertically stacked modules into merged colour runs.
 *
 * Every module pair uses the same upper-half-block glyph. The foreground
 * represents the upper module and the background represents the lower module;
 * assigning both colours even when they match prevents glyph padding from
 * exposing a contrasting seam. Adjacent cells with the same foreground and
 * background colours are merged into one segment.
 *
 * @param modules Grid produced by {@link encodeQrModules}.
 * @returns Compact rows using one terminal column for each module pair.
 */
export function toCompactQrRows(modules: QrModules): QrSegment[][] {
  const rows: QrSegment[][] = [];
  for (let y = 0; y < modules.length; y += 2) {
    const top = modules[y];
    const bottom = modules[y + 1];
    const segments: QrSegment[] = [];
    for (let x = 0; x < top.length; x += 1) {
      const topDark = top[x];
      const bottomDark = bottom?.[x] ?? false;
      pushCell(segments, '▀', bottomDark ? 'black' : 'white', topDark ? 'black' : 'white');
    }
    rows.push(segments);
  }
  return rows;
}

const BACKGROUND_QR_MODULE_COLUMNS = 2;

/**
 * Project each QR module onto a square terminal cell using only background colour.
 *
 * Two ordinary spaces provide the horizontal dimension and one terminal row
 * provides the vertical dimension. No glyph is painted, so font metrics,
 * ClearType, and text antialiasing cannot alter module boundaries.
 *
 * @param modules Grid produced by {@link encodeQrModules}.
 * @returns Full-height rows containing merged background-colour runs.
 */
export function toBackgroundQrRows(modules: QrModules): QrSegment[][] {
  return modules.map((moduleRow) => {
    const segments: QrSegment[] = [];
    for (const dark of moduleRow) {
      pushCell(segments, ' '.repeat(BACKGROUND_QR_MODULE_COLUMNS), dark ? 'black' : 'white');
    }
    return segments;
  });
}

/**
 * Project each QR module onto foreground glyphs so it survives a resize reflow.
 *
 * A light module (including the quiet zone) becomes two standard-white full
 * blocks and a dark module becomes two black full blocks. Painting both
 * polarities explicitly keeps the code independent of the terminal's default
 * background. Only foreground colours are emitted: no cell carries a
 * background SGR, so a terminal that reflows its buffer on resize (Windows
 * Terminal) keeps every glyph instead of dropping a background fill. Adjacent
 * modules with the same polarity share one colour run, and each row ends with
 * a reset so the colour never leaks into the next line.
 *
 * @param modules Grid produced by {@link encodeQrModules}.
 * @returns One ANSI-coloured string per module row, without indentation.
 */
export function toForegroundQrRows(modules: QrModules): string[] {
  const cell = '\u2588'.repeat(BACKGROUND_QR_MODULE_COLUMNS);
  return modules.map((moduleRow) => {
    let content = '';
    let previous: boolean | undefined;
    for (const isDark of moduleRow) {
      if (isDark !== previous) {
        content += isDark ? '\x1b[30m' : '\x1b[37m';
        previous = isDark;
      }
      content += cell;
    }
    return `${content}\x1b[0m`;
  });
}

/** Terminal columns occupied by one background-filled QR row. */
export function backgroundQrRenderedColumns(modules: QrModules): number {
  return (modules[0]?.length ?? 0) * BACKGROUND_QR_MODULE_COLUMNS;
}

/** Terminal columns occupied by one compact QR row. */
export function qrRenderedColumns(modules: QrModules): number {
  return modules[0]?.length ?? 0;
}
