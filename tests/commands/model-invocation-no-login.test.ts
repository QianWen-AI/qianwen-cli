/**
 * Model-invocation commands do not require login. Each command resolves its
 * credential from --api-key / env / config and constructs its service without
 * consulting the login boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../helpers/run-command.js';

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

describe('model invocation — no login required', () => {
  for (const c of COMMANDS) {
    it(`${c.name}: reaches the service with --api-key, without consulting login`, async () => {
      const result = await runCommand((p) => c.register(p), [...c.argv, '--api-key', 'sk-mock']);
      expect(authHolder.fn).not.toHaveBeenCalled();
      expect(factory[c.factoryKey]).toHaveBeenCalled();
      expect(result.exitCode).not.toBe(2);
    });
  }
});
