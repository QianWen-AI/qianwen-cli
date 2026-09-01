export interface ImageDownloaderDeps {
  fetchBytes: (url: string) => Promise<Uint8Array>;
  writeFile: (path: string, bytes: Uint8Array) => void;
  ensureDir: (dir: string) => void;
  fileExists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
}

const SEPARATOR = '/';

function lastSegment(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '';
  const segments = withoutQuery.split(SEPARATOR);
  return segments[segments.length - 1] ?? '';
}

function hasExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1;
}

function joinPath(dir: string, name: string): string {
  const normalized = dir.endsWith(SEPARATOR) ? dir.slice(0, -1) : dir;
  return `${normalized}${SEPARATOR}${name}`;
}

function parentDir(path: string): string | undefined {
  const trimmed = path.endsWith(SEPARATOR) ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf(SEPARATOR);
  if (idx <= 0) return undefined;
  return trimmed.slice(0, idx);
}

function suffixWithIndex(name: string, index: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}-${index}`;
  return `${name.slice(0, dot)}-${index}${name.slice(dot)}`;
}

function normalizeExtension(ext?: string): string {
  if (typeof ext !== 'string') return '';
  const trimmed = ext.trim().replace(/^\.+/, '');
  return trimmed.length > 0 ? `.${trimmed.toLowerCase()}` : '';
}

function replaceExtension(name: string, ext?: string): string {
  const normalized = normalizeExtension(ext);
  if (normalized.length === 0) return name;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}${normalized}`;
  if (name.slice(dot).toLowerCase() === normalized) return name;
  return `${name.slice(0, dot)}${normalized}`;
}

export class ImageDownloader {
  constructor(private readonly deps: ImageDownloaderDeps) {}

  inferFileName(url: string, index: number, fallbackExtension?: string): string {
    const segment = lastSegment(url);
    if (segment.length > 0 && hasExtension(segment)) return segment;
    const ext = normalizeExtension(fallbackExtension) || '.png';
    const stem = ext === '.png' ? 'image' : 'file';
    return `${stem}-${index}${ext}`;
  }

  fetchBytes(url: string): Promise<Uint8Array> {
    return this.deps.fetchBytes(url);
  }

  async download(
    url: string,
    index: number,
    out?: string,
    fallbackExtension?: string,
  ): Promise<string> {
    const bytes = await this.deps.fetchBytes(url);
    const target = this.resolveTarget(url, index, out, fallbackExtension);
    this.deps.writeFile(target, bytes);
    return target;
  }

  writeBytes(bytes: Uint8Array, index: number, out?: string, fallbackExtension?: string): string {
    const target = this.resolveTarget('', index, out, fallbackExtension);
    this.deps.writeFile(target, bytes);
    return target;
  }

  private resolveTarget(
    url: string,
    index: number,
    out?: string,
    fallbackExtension?: string,
  ): string {
    const name = this.inferFileName(url, index, fallbackExtension);

    if (out === undefined || out.length === 0) {
      return name;
    }

    if (out.endsWith(SEPARATOR) || this.deps.isDirectory(out)) {
      this.deps.ensureDir(out.endsWith(SEPARATOR) ? out.slice(0, -1) : out);
      return joinPath(out, name);
    }

    const outHasExtension = hasExtension(lastSegment(out));
    const withExt = outHasExtension ? out : `${out}${normalizeExtension(fallbackExtension)}`;
    const indexed = index === 0 ? withExt : suffixWithIndex(withExt, index);
    const target =
      index === 0 || !outHasExtension ? indexed : replaceExtension(indexed, fallbackExtension);
    const dir = parentDir(target);
    if (dir) this.deps.ensureDir(dir);
    return target;
  }
}
