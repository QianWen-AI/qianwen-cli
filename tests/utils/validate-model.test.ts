import { describe, it, expect } from 'vitest';
import { validateModelId, modelNotFoundWithSuggestion } from '../../src/utils/validate-model.js';
import { CliError } from '../../src/utils/errors.js';

function makeClient(ids: string[]) {
  return {
    listModels: async () => ({
      models: ids.map((id) => ({ id })),
      total: ids.length,
    }),
  } as any;
}

describe('validateModelId', () => {
  it('returns the matched Model when the ID exists', async () => {
    const client = makeClient(['qwen3-max', 'qwen3.6-plus']);
    const model = await validateModelId(client, 'qwen3-max');
    expect(model.id).toBe('qwen3-max');
  });

  it('throws MODEL_NOT_FOUND with did-you-mean when close', async () => {
    const client = makeClient(['qwen3-max', 'qwen3.6-plus']);
    await expect(validateModelId(client, 'qwen3-ma')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      message: "Model 'qwen3-ma' not found. Did you mean 'qwen3-max'?",
    });
  });

  it('throws MODEL_NOT_FOUND without suggestion when far from any candidate', async () => {
    const client = makeClient(['qwen3-max', 'qwen3.6-plus']);
    await expect(validateModelId(client, 'totally-bogus')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      message: "Model 'totally-bogus' not found.",
    });
  });

  it('rejects empty model id with INVALID_ARGUMENT', async () => {
    const client = makeClient(['qwen3-max']);
    await expect(validateModelId(client, '')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('thrown error is a CliError instance', async () => {
    const client = makeClient(['qwen3-max']);
    let thrown: unknown;
    try { await validateModelId(client, 'nope'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CliError);
  });
});

describe('modelNotFoundWithSuggestion', () => {
  it('appends a Did-you-mean clause when a candidate is close', () => {
    const err = modelNotFoundWithSuggestion('qwen3-ma', ['qwen3-max']);
    expect(err.code).toBe('MODEL_NOT_FOUND');
    expect(err.message).toBe("Model 'qwen3-ma' not found. Did you mean 'qwen3-max'?");
  });

  it('omits suggestion when nothing is close', () => {
    const err = modelNotFoundWithSuggestion('zzz', ['qwen3-max']);
    expect(err.message).toBe("Model 'zzz' not found.");
  });
});
