import type { Command } from 'commander';
import { registerAudioTranscribeCommand } from './transcribe.js';
import { registerAudioSpeechCommand } from './speech.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { audioTranscribeAction, registerAudioTranscribeCommand } from './transcribe.js';
export { audioSpeechAction, registerAudioSpeechCommand } from './speech.js';

export function registerAudioCommands(program: Command): void {
  const audio = program
    .command('audio')
    .description('Audio synthesis and transcription with Qwen models');

  const transcribe = registerAudioTranscribeCommand(audio);

  addExamples(transcribe, [
    formatCmd('audio transcribe meeting.mp3'),
    formatCmd('audio transcribe meeting.mp3 --language zh'),
    formatCmd(
      'audio transcribe --request \'{"model":"qwen-audio-3.0-asr-flash","input":{"messages":[{"role":"user","content":[{"audio":"https://host/a.wav"}]}]},"parameters":{"format":"wav"}}\'',
    ),
  ]);

  const speech = registerAudioSpeechCommand(audio);

  addExamples(speech, [
    formatCmd('audio speech "欢迎使用千问云"'),
    formatCmd('audio speech "欢迎使用千问云" --voice longanhuan_v3.6 --out hello.mp3'),
    formatCmd(
      'audio speech --request \'{"model":"qwen-audio-3.0-tts-plus","input":{"text":"你好","voice":"longanhuan_v3.6"}}\'',
    ),
  ]);

  audio.action(() => {
    audio.outputHelp();
    process.stdout.write('\n');
  });
}
