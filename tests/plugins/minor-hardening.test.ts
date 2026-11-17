import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import {
  validateManifest,
  writeInstalledManifest,
  type InstalledManifest,
  type PluginManifest,
} from '../../src/plugins/manifest.js';
import { registerPluginCommands } from '../../src/plugins/loader.js';
import { CliError, handleError } from '../../src/plugins/sdk.js';
import { HandledError } from '../../src/utils/errors.js';

const state = vi.hoisted(() => ({ handlers: {} as Record<string, unknown> }));
vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('./fixtures/argplugin/entry.mjs', () => ({ handlers: state.handlers }));

let root: string;
let stderr: string[];
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.plugin-minor-hardening-'));
  stderr = [];
  for (const key of Object.keys(state.handlers)) delete state.handlers[key];
  Object.setPrototypeOf(state.handlers, Object.prototype);
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  fs.rmSync(root, { recursive: true, force: true });
});

const first: InstalledManifest = {
  plugins: [{ name: 'first', version: '1.0.0', enabled: true, source: 'npm' }],
};
const second: InstalledManifest = {
  plugins: [{ name: 'second', version: '2.0.0', enabled: true, source: 'npm' }],
};

function caught(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('manifest atomic temporary files', () => {
  it.each(['file', 'symlink'] as const)('preserves an existing fixed .tmp %s', (kind) => {
    const target = path.join(root, 'plugins.json');
    const fixed = `${target}.tmp`;
    const sentinel = 'unrelated temporary contents';
    if (kind === 'symlink') {
      fs.writeFileSync(path.join(root, 'sentinel'), sentinel);
      fs.symlinkSync(path.join(root, 'sentinel'), fixed);
    } else {
      fs.writeFileSync(fixed, sentinel);
    }

    writeInstalledManifest(target, first);

    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(first);
    expect(fs.existsSync(fixed)).toBe(true);
    expect(fs.readFileSync(fixed, 'utf8')).toBe(sentinel);
    expect(fs.lstatSync(fixed).isSymbolicLink()).toBe(kind === 'symlink');
    if (kind === 'symlink') {
      expect(fs.readFileSync(path.join(root, 'sentinel'), 'utf8')).toBe(sentinel);
    }
  });

  it('uses distinct same-directory names when writes interleave before rename', () => {
    const target = path.join(root, 'plugins.json');
    const rename = fs.renameSync;
    const temporaryPaths: string[] = [];
    let interleaved = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      temporaryPaths.push(String(source));
      if (!interleaved) {
        interleaved = true;
        writeInstalledManifest(target, second);
        expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(second);
      }
      rename(source, destination);
    });

    writeInstalledManifest(target, first);

    expect(temporaryPaths).toHaveLength(2);
    expect(new Set(temporaryPaths).size).toBe(2);
    expect(temporaryPaths.every((temporary) => path.dirname(temporary) === root)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(first);
    expect(fs.readdirSync(root)).toEqual(['plugins.json']);
  });

  it('creates the renamed temporary file exclusively', () => {
    const target = path.join(root, 'plugins.json');
    const open = vi.spyOn(fs, 'openSync');
    const write = vi.spyOn(fs, 'writeFileSync');
    const rename = vi.spyOn(fs, 'renameSync');

    writeInstalledManifest(target, first);

    expect(rename).toHaveBeenCalledOnce();
    const temporary = String(rename.mock.calls[0][0]);
    const exclusiveOpen = open.mock.calls.some(([file, flags]) => {
      if (String(file) !== temporary) return false;
      return typeof flags === 'string'
        ? flags.includes('x')
        : (flags & fs.constants.O_EXCL) !== 0 && (flags & fs.constants.O_CREAT) !== 0;
    });
    const exclusiveWrite = write.mock.calls.some(([file, , options]) => {
      if (String(file) !== temporary || typeof options !== 'object' || options === null) {
        return false;
      }
      return typeof options.flag === 'string' && options.flag.includes('x');
    });
    expect(exclusiveOpen || exclusiveWrite).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(first);
  });

  it.each(['file', 'symlink'] as const)(
    'preserves the target and a conflicting temporary %s when exclusive creation fails with EEXIST',
    (kind) => {
      const target = path.join(root, 'plugins.json');
      const original = JSON.stringify(first);
      const sentinel = 'temporary file owned by another writer';
      const linkTarget = path.join(root, 'collision-sentinel');
      fs.writeFileSync(target, original);
      if (kind === 'symlink') fs.writeFileSync(linkTarget, sentinel);
      const open = fs.openSync;
      const write = fs.writeFileSync;
      const failure = Object.assign(new Error('injected exclusive creation collision'), {
        code: 'EEXIST',
      });
      let collisionPath = '';

      function isExclusive(flags: string | number | undefined): boolean {
        return typeof flags === 'string'
          ? flags.includes('x')
          : typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0;
      }

      function collide(file: fs.PathLike): never {
        collisionPath = String(file);
        expect(path.dirname(collisionPath)).toBe(root);
        expect(collisionPath).not.toBe(target);
        if (kind === 'symlink') fs.symlinkSync(linkTarget, collisionPath);
        else write(collisionPath, sentinel);
        throw failure;
      }

      vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
        if (!collisionPath && isExclusive(flags)) collide(file);
        return open(file, flags, mode);
      });
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
        const flag = typeof options === 'object' && options !== null ? options.flag : undefined;
        if (!collisionPath && typeof file !== 'number' && isExclusive(flag)) collide(file);
        return write(file, data, options);
      });

      try {
        expect(caught(() => writeInstalledManifest(target, second))).toBe(failure);
      } finally {
        expect(fs.readFileSync(target, 'utf8')).toBe(original);
        expect(collisionPath).not.toBe('');
        expect(fs.readFileSync(collisionPath, 'utf8')).toBe(sentinel);
        expect(fs.lstatSync(collisionPath).isSymbolicLink()).toBe(kind === 'symlink');
        if (kind === 'symlink') {
          expect(fs.readlinkSync(collisionPath)).toBe(linkTarget);
          expect(fs.readFileSync(linkTarget, 'utf8')).toBe(sentinel);
        }
      }
    },
  );

  it('cleans a partially written temporary file and preserves the original write error and target', () => {
    const target = path.join(root, 'plugins.json');
    fs.writeFileSync(target, JSON.stringify(first));
    const write = fs.writeFileSync;
    const failure = new Error('injected write failure');
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file) => {
      write(file, '{partial');
      throw failure;
    });

    expect(caught(() => writeInstalledManifest(target, second))).toBe(failure);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(first);
    expect(fs.readdirSync(root)).toEqual(['plugins.json']);
  });

  it('cleans the temporary file after rename failure while retaining the target and original error', () => {
    const target = path.join(root, 'plugins.json');
    fs.writeFileSync(target, JSON.stringify(first));
    const failure = new Error('injected rename failure');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw failure;
    });

    expect(caught(() => writeInstalledManifest(target, second))).toBe(failure);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(first);
    expect(fs.readdirSync(root)).toEqual(['plugins.json']);
  });

  it('does not replace the original rename error with a cleanup error', () => {
    const target = path.join(root, 'plugins.json');
    fs.writeFileSync(target, JSON.stringify(first));
    const failure = new Error('primary rename failure');
    const cleanupFailure = new Error('secondary cleanup failure');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw failure;
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw cleanupFailure;
    });
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw cleanupFailure;
    });

    expect(caught(() => writeInstalledManifest(target, second))).toBe(failure);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(first);
  });
});

function leaf(handlerKey: string): PluginManifest {
  return { command: 'minor-probe', entry: './entry.js', handlerKey, auth: 'optional' };
}

function validateUntrustedManifest(value: unknown): ReturnType<typeof validateManifest> {
  // Exercise malformed external metadata without weakening the typed valid-manifest API.
  return validateManifest(value as PluginManifest);
}

describe('nonblank leaf handler keys', () => {
  it.each([undefined, null, '', ' ', '\t\n', 1, true, {}, []])(
    'rejects malformed root and nested leaf handlerKey %j',
    (handlerKey) => {
      expect(validateUntrustedManifest({ ...leaf('run'), handlerKey })).not.toBeNull();
      expect(
        validateUntrustedManifest({
          command: 'minor-probe',
          entry: './entry.js',
          subcommands: [{ command: 'group', subcommands: [{ command: 'run', handlerKey }] }],
        }),
      ).not.toBeNull();
    },
  );

  it.each(['run', 'constructor', 'toString'])('accepts a nonblank dictionary key %s', (key) => {
    expect(validateManifest(leaf(key))).toBeNull();
  });
});

describe('minCliVersion type validation', () => {
  it.each([null, 1, true, {}, []])('rejects a non-string root and nested value %j', (value) => {
    expect(validateUntrustedManifest({ ...leaf('run'), minCliVersion: value })).not.toBeNull();
    expect(
      validateUntrustedManifest({
        command: 'minor-probe',
        entry: './entry.js',
        subcommands: [
          {
            command: 'group',
            subcommands: [{ command: 'run', handlerKey: 'run', minCliVersion: value }],
          },
        ],
      }),
    ).not.toBeNull();
  });

  it('accepts absent or string minCliVersion only at the root', () => {
    expect(validateManifest(leaf('run'))).toBeNull();
    expect(validateManifest({ ...leaf('run'), minCliVersion: '1.0.0' })).toBeNull();
    expect(
      validateManifest({
        command: 'minor-probe',
        entry: './entry.js',
        subcommands: [{ command: 'run', handlerKey: 'run', minCliVersion: '1.0.0' }],
      }),
    ).not.toBeNull();
  });
});

type HandlerMap = Record<string, unknown>;

function loaderCase(handlers: HandlerMap, key: string) {
  Object.setPrototypeOf(state.handlers, Object.getPrototypeOf(handlers));
  Object.assign(state.handlers, handlers);
  const program = new Command().option('--format <format>').exitOverride();
  registerPluginCommands(program, [
    {
      name: 'minor-probe-plugin',
      pkgDir: fileURLToPath(new URL('./fixtures/argplugin/', import.meta.url)),
      manifest: { ...leaf(key), entry: './entry.mjs' },
    },
  ]);
  return {
    async invoke(): Promise<unknown> {
      try {
        await program.parseAsync(['--format', 'json', 'minor-probe'], { from: 'user' });
        return undefined;
      } catch (error) {
        return error;
      }
    },
  };
}

describe('external handler dispatch', () => {
  it.each(['constructor', 'toString', 'inheritedRun'])(
    'rejects inherited function %s without executing it',
    async (key) => {
      const inherited = vi.fn(async () => undefined);
      const handlers = Object.create({ [key]: inherited }) as HandlerMap;
      const scenario = loaderCase(handlers, key);

      const error = await scenario.invoke();

      expect(inherited).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(HandledError);
      expect(stderr.join('')).toContain(key);
    },
  );

  it.each(['constructor', 'toString'])('rejects Object.prototype.%s', async (key) => {
    const scenario = loaderCase({}, key);

    const error = await scenario.invoke();

    expect(error).toBeInstanceOf(HandledError);
    expect(stderr.join('')).toContain(key);
  });

  it.each(['run', 'constructor', 'toString'])('runs an own function named %s once', async (key) => {
    const handler = vi.fn(async () => undefined);
    const scenario = loaderCase({ [key]: handler }, key);

    expect(await scenario.invoke()).toBeUndefined();

    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([null, 'not a function', 42, {}])(
    'rejects an own non-function value %j',
    async (value) => {
      const scenario = loaderCase({ run: value }, 'run');

      const error = await scenario.invoke();

      expect(error).toBeInstanceOf(HandledError);
      expect(stderr.join('')).toContain('"error"');
    },
  );

  it('propagates the SDK HandledError unchanged, preserves its exit code and prints only once', async () => {
    let handled: unknown;
    let outputAtThrow: string[] = [];
    const handler = vi.fn(async () => {
      try {
        handleError(
          new CliError({ code: 'MINOR_RATE_LIMIT', message: 'retry later', exitCode: 5 }),
          'json',
        );
      } catch (error) {
        handled = error;
        outputAtThrow = [...stderr];
        throw error;
      }
    });
    const scenario = loaderCase({ run: handler }, 'run');

    const error = await scenario.invoke();

    expect(handled).toBeInstanceOf(HandledError);
    expect(error).toBe(handled);
    expect(error).toMatchObject({ exitCode: 5 });
    expect(stderr).toEqual(outputAtThrow);
    expect(stderr.join('').match(/MINOR_RATE_LIMIT/g)).toHaveLength(1);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('formats an unhandled business error once without retrying the handler', async () => {
    const failure = new Error('minor unhandled business failure');
    const handler = vi.fn(async () => {
      throw failure;
    });
    const scenario = loaderCase({ run: handler }, 'run');

    const error = await scenario.invoke();

    expect(error).toBeInstanceOf(HandledError);
    expect(error).not.toBe(failure);
    expect(error).toMatchObject({ exitCode: 1 });
    expect(stderr.join('').match(/minor unhandled business failure/g)).toHaveLength(1);
    expect(handler).toHaveBeenCalledOnce();
  });
});
