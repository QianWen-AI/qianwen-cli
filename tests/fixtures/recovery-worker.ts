import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

export interface RecoveryWorker<Result> {
  child: ChildProcess;
  boundaryPath: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  result(): Promise<Result>;
}

export function recoveryWorker<Result extends { fetchCalls: number }>(
  root: string,
  workerPath: string,
  configPath: string,
  boundaryPath: string,
): RecoveryWorker<Result> {
  const child = fork(workerPath, [configPath], {
    cwd: root,
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
    env: {
      ...process.env,
      TSX_DISABLE_CACHE: '1',
      QIANWEN_CONFIG_DIR: root,
      QIANWEN_KEYRING: 'no',
      TMPDIR: root,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let message: Result | undefined;
  let diagnostic = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  child.on('message', (value: Result) => {
    message = value;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    boundaryPath,
    exited,
    async result() {
      expect(await exited, diagnostic).toEqual({ code: 0, signal: null });
      if (!message) throw new Error(`Worker did not return a result: ${diagnostic}`);
      expect(message.fetchCalls).toBe(0);
      return message;
    },
  };
}
