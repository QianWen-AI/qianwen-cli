import { createHash } from 'node:crypto';
import { vi } from 'vitest';

export function stubRegistry(opts: {
  pkg: string;
  version: string;
  tag?: string;
  tgz: Buffer;
  integrity?: string;
  tarballUrl?: string;
}): typeof fetch {
  const tarballUrl = opts.tarballUrl ?? `https://registry.npmjs.org/${opts.pkg}/-/pkg.tgz`;
  const integrity =
    opts.integrity ?? `sha512-${createHash('sha512').update(opts.tgz).digest('base64')}`;
  const packument = {
    'dist-tags': { [opts.tag ?? 'latest']: opts.version },
    versions: { [opts.version]: { dist: { tarball: tarballUrl, integrity } } },
  };
  return vi.fn<typeof fetch>(async (url) => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href === tarballUrl) return new Response(new Uint8Array(opts.tgz), { status: 200 });
    return new Response(JSON.stringify(packument), { status: 200 });
  });
}
