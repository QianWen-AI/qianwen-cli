/**
 * Login-gate tests (per architecture design §2.7-L).
 *
 * Verify that every model-invocation command enforces an authentication
 * pre-check BEFORE resolving credentials or constructing its service. The
 * gate must:
 *   - reject with exit 2 + "Not authenticated" when unauthenticated,
 *   - reject even when a Key is supplied via --api-key (gate precedes Key
 *     resolution, so the "Missing API key" path is never reached),
 *   - reject with exit 2 + "Token expired" when the token is expired,
 *   - allow the command through (service factory invoked) once authenticated.
 *
 * The ordering assertion (service factory NOT invoked while unauthenticated)
 * is the falsifiable core: an implementation that authenticates AFTER building
 * the service would invoke the factory and turn these red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../helpers/run-command.js';
import { authRequiredError, tokenExpiredError } from '../../src/utils/errors.js';

// ── Auth boundary (external dependency of every command action) ──────
const authHolder: { fn: ReturnType<typeof vi.fn> } = { fn: vi.fn() };
vi.mock('../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => authHolder.fn(),
}));

// ── Service factory boundaries (observe whether they were constructed) ─
const factory: Record<string, ReturnType<typeof vi.fn>> = {
  chat: vi.fn(),
  image: vi.fn(),
  video: vi.fn(),
  asr: vi.fn(),
  tts: vi.fn(),
  model3d: vi.fn(),
  music: vi.fn(),
  task: vi.fn(),
};

vi.mock('../../src/services/chat-runtime.js', () => ({
  createChatService: (o?: unknown) => {
    factory.chat(o);
    return {
      create: async () => ({ meta: {}, data: {} }),
      createStream: () => (async function* () {})(),
    };
  },
}));
vi.mock('../../src/services/image-runtime.js', () => ({
  createImageService: (o?: unknown) => {
    factory.image(o);
    return { generate: async () => ({ meta: {}, data: {} }) };
  },
}));
vi.mock('../../src/services/video-runtime.js', () => ({
  createVideoService: (o?: unknown) => {
    factory.video(o);
    return { generate: async () => ({ envelope: { meta: {}, data: {} }, completed: true }) };
  },
}));
vi.mock('../../src/services/asr-runtime.js', () => ({
  createASRService: (o?: unknown) => {
    factory.asr(o);
    return { generate: async () => ({ envelope: { meta: {}, data: {} }, completed: true }) };
  },
}));
vi.mock('../../src/services/tts-runtime.js', () => ({
  createTTSService: (o?: unknown) => {
    factory.tts(o);
    return { generate: async () => ({ meta: {}, data: {} }) };
  },
}));
vi.mock('../../src/services/model3d-runtime.js', () => ({
  createModel3dService: (o?: unknown) => {
    factory.model3d(o);
    return { generate: async () => ({ envelope: { meta: {}, data: {} }, completed: true }) };
  },
}));
vi.mock('../../src/services/music-runtime.js', () => ({
  createMusicService: (o?: unknown) => {
    factory.music(o);
    return { generate: async () => ({ meta: {}, data: {} }) };
  },
}));
vi.mock('../../src/services/task-runtime.js', () => ({
  createTaskService: (o?: unknown) => {
    factory.task(o);
    return { get: async () => ({ meta: {}, data: {} }) };
  },
}));

const { registerChatCommands } = await import('../../src/commands/chat/index.js');
const { registerImageCommands } = await import('../../src/commands/image/index.js');
const { registerVideoCommands } = await import('../../src/commands/video/index.js');
const { registerAudioCommands } = await import('../../src/commands/audio/index.js');
const { registerModel3dCommands } = await import('../../src/commands/model3d/index.js');
const { registerMusicCommands } = await import('../../src/commands/music/index.js');
const { registerTaskCommands } = await import('../../src/commands/task/index.js');

interface Cmd {
  name: string;
  register: (program: import('commander').Command) => void;
  argv: string[];
  factoryKey: keyof typeof factory;
}

const COMMANDS: Cmd[] = [
  {
    name: 'chat create',
    register: registerChatCommands,
    argv: ['chat', 'create', 'hi'],
    factoryKey: 'chat',
  },
  {
    name: 'image generate',
    register: registerImageCommands,
    argv: ['image', 'generate', 'a cat'],
    factoryKey: 'image',
  },
  {
    name: 'video generate',
    register: registerVideoCommands,
    argv: ['video', 'generate', 'a cat'],
    factoryKey: 'video',
  },
  {
    name: 'audio transcribe',
    register: registerAudioCommands,
    argv: ['audio', 'transcribe', 'https://mock-api.test.qianwenai.com/a.wav'],
    factoryKey: 'asr',
  },
  {
    name: 'audio speech',
    register: registerAudioCommands,
    argv: ['audio', 'speech', 'hello'],
    factoryKey: 'tts',
  },
  {
    name: 'model3d generate',
    register: registerModel3dCommands,
    argv: ['model3d', 'generate', 'a cat'],
    factoryKey: 'model3d',
  },
  {
    name: 'music generate',
    register: registerMusicCommands,
    argv: ['music', 'generate', 'a song'],
    factoryKey: 'music',
  },
  {
    name: 'task get',
    register: registerTaskCommands,
    argv: ['task', 'get', 'task-123'],
    factoryKey: 'task',
  },
];

beforeEach(() => {
  authHolder.fn = vi.fn();
  for (const k of Object.keys(factory)) factory[k] = vi.fn();
});

describe('login gate — unauthenticated is rejected before service construction', () => {
  for (const c of COMMANDS) {
    it(`${c.name}: exit 2 + "Not authenticated", factory not invoked`, async () => {
      authHolder.fn = vi.fn(() => {
        throw authRequiredError();
      });
      const result = await runCommand((p) => c.register(p), c.argv);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Not authenticated');
      expect(factory[c.factoryKey]).not.toHaveBeenCalled();
    });
  }
});

describe('login gate — precedes Key resolution (--api-key does not bypass)', () => {
  for (const c of COMMANDS) {
    it(`${c.name}: unauthenticated + --api-key still exit 2, no "Missing API key"`, async () => {
      authHolder.fn = vi.fn(() => {
        throw authRequiredError();
      });
      const result = await runCommand((p) => c.register(p), [...c.argv, '--api-key', 'sk-mock']);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Not authenticated');
      expect(result.stderr).not.toContain('Missing API key');
      expect(factory[c.factoryKey]).not.toHaveBeenCalled();
    });
  }
});

describe('login gate — expired token is rejected before service construction', () => {
  for (const c of COMMANDS) {
    it(`${c.name}: exit 2 + "Token expired", factory not invoked`, async () => {
      authHolder.fn = vi.fn(() => {
        throw tokenExpiredError();
      });
      const result = await runCommand((p) => c.register(p), c.argv);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Token expired');
      expect(factory[c.factoryKey]).not.toHaveBeenCalled();
    });
  }
});

describe('login gate — authenticated is allowed through to the service', () => {
  for (const c of COMMANDS) {
    it(`${c.name}: ensureAuthenticated called, factory invoked, not exit 2`, async () => {
      authHolder.fn = vi.fn(() => ({}));
      const result = await runCommand((p) => c.register(p), c.argv);
      expect(authHolder.fn).toHaveBeenCalled();
      expect(factory[c.factoryKey]).toHaveBeenCalled();
      expect(result.exitCode).not.toBe(2);
    });
  }
});
