import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function projectTmpdir(): string {
  const root = path.resolve(process.cwd(), '.local-test-tmp');
  mkdirSync(root, { recursive: true });
  return root;
}
