/** `audio speech` — synchronous text-to-speech synthesis with tier 2 convenience flags and tier 3 passthrough. */

import type { Command } from 'commander';
import { getEffectiveConfig } from '../../config/manager.js';
import { resolveFormatFromCommand, resolveExplicitFormat } from '../../output/format.js';
import {
  mediaView,
  readNumber,
  readString,
  renderInvocation,
} from '../../output/invocation-view.js';
import { handleError } from '../../utils/errors.js';
import { preflightOutPath } from '../../utils/out-path.js';
import { createTTSService } from '../../services/tts-runtime.js';
import type { AudioSpeechInput } from '../../services/tts-service.js';
import type { SuccessEnvelope } from '../../types/invocation-params.js';
import type { ResolvedFormat } from '../../types/config.js';
import { withSpinner } from '../../ui/spinner.js';

export function audioSpeechAction(
  cmd: Command,
): (this: Command, text: string | undefined, options: Record<string, unknown>) => Promise<void> {
  return async function (
    this: Command,
    text: string | undefined,
    options: Record<string, unknown>,
  ) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      const input: AudioSpeechInput = {};
      if (typeof text === 'string' && text.length > 0) input.text = text;
      if (typeof options.model === 'string') input.model = options.model;
      if (typeof options.voice === 'string') input.voice = options.voice;
      if (typeof options.out === 'string') input.out = options.out;
      if (typeof options.request === 'string') input.request = options.request;

      preflightOutPath(input.out);
      const runtimeOptions: { apiKey?: string; silentGuard?: boolean } = {
        silentGuard: resolveExplicitFormat(this ?? cmd) === 'json',
      };
      if (typeof options.apiKey === 'string') runtimeOptions.apiKey = options.apiKey;
      const service = createTTSService(runtimeOptions);
      const envelope = await withSpinner('语音合成中', () => service.generate(input), format);
      if (service.lastDeprecationNotice) {
        envelope.meta.model_offline_warning = service.lastDeprecationNotice;
      }
      renderSpeech(envelope, format, typeof options.voice === 'string' ? options.voice : undefined);
    } catch (error) {
      handleError(error, format);
    }
  };
}

/** `语音合成完成` + saved path + audio_url, footer `model · voice · characters`. */
function renderSpeech(
  envelope: SuccessEnvelope,
  format: ResolvedFormat,
  requestedVoice: string | undefined,
): void {
  renderInvocation(envelope, format, (data, meta) => {
    const audio =
      data.audio && typeof data.audio === 'object'
        ? (data.audio as Record<string, unknown>)
        : undefined;
    const voice = readString(audio, 'voice') ?? requestedVoice;
    const characters = readNumber(meta.usage, 'characters');
    return mediaView(data, {
      title: '语音合成完成',
      urlLabel: 'audio_url',
      expiresIn: '24h',
      footerExtras: [
        voice !== undefined ? `voice ${voice}` : '',
        characters !== undefined ? `characters ${characters}` : '',
      ],
    });
  });
}

export function registerAudioSpeechCommand(parent: Command): Command {
  const speech = parent
    .command('speech [text]')
    .description('Synthesize speech from text')
    .option('--model <id>', 'Model to use (tier 1)')
    .option('--voice <name>', 'Voice id or name (tier 2)')
    .option('--out <path>', 'Output file or directory for the downloaded audio (tier 2)')
    .option('--request <json|@file|->', 'Native request body passthrough (tier 3)')
    .option('--api-key <key>', 'API key for this invocation (tier 0)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  speech.action(audioSpeechAction(speech));
  return speech;
}
