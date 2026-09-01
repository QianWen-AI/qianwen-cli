import stripAnsi from 'strip-ansi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mediaView,
  metaFooter,
  readImages,
  renderInvocation,
  savedLines,
  submittedView,
  tokenSegment,
} from '../../src/output/invocation-view.js';
import type { SuccessEnvelope } from '../../src/types/invocation-params.js';

const ENVELOPE: SuccessEnvelope = {
  meta: {
    model: 'qwen-plus',
    request_id: 'req-123',
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
  },
  data: { text: '你好' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invocation view helpers', () => {
  it('builds the footer in model, extras, request_id order', () => {
    expect(metaFooter(ENVELOPE.meta, ['tokens 3 in / 5 out', 'finish stop'])).toBe(
      'model qwen-plus · tokens 3 in / 5 out · finish stop · request_id req-123',
    );
  });

  it('keeps zero token counters instead of treating them as missing', () => {
    expect(tokenSegment({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })).toBe(
      'tokens 0 in / 0 out / 0 total',
    );
  });

  it('renders multiple saved paths with a hanging indent', () => {
    expect(savedLines(['/tmp/a.png', '/tmp/b.png'])).toEqual([
      '  已保存 /tmp/a.png',
      '          /tmp/b.png',
    ]);
  });

  it('ignores non-object values in the images array', () => {
    expect(
      readImages({ images: [null, 'bad', 1, { url: 'https://mock-media.test.qianwenai.com/a' }] }),
    ).toEqual([{ url: 'https://mock-media.test.qianwenai.com/a' }]);
  });

  it('renders an asynchronous submission with task lookup guidance', () => {
    const view = submittedView(
      { task_id: 'task-42', task_status: 'PENDING' },
      '视频生成任务已提交',
      '，完成后可下载',
    );

    expect(view.body).toContain('视频生成任务已提交');
    expect(view.body).toContain('task_id task-42 · status PENDING');
    expect(view.body).toContain('`qianwen task get task-42` 查询进度，完成后可下载');
  });

  it('renders local media paths, remote URLs, expiry, and extra details', () => {
    const view = mediaView(
      {
        audio: { path: '/tmp/speech.wav', url: 'https://mock-media.test.qianwenai.com/speech.wav' },
      },
      {
        title: '语音合成完成',
        urlLabel: 'audio_url',
        expiresIn: '24h',
        extraLines: ['voice Cherry'],
        footerExtras: ['characters 6'],
      },
    );

    expect(view.body).toBe(
      [
        '语音合成完成',
        '  已保存 /tmp/speech.wav',
        '  audio_url  https://mock-media.test.qianwenai.com/speech.wav（24h 后失效）',
        '  voice Cherry',
      ].join('\n'),
    );
    expect(view.footerExtras).toEqual(['characters 6']);
  });
});

describe('renderInvocation', () => {
  it('prints the untouched envelope for JSON output and skips the text builder', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const build = vi.fn();

    renderInvocation(ENVELOPE, 'json', build);

    expect(build).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(ENVELOPE);
  });

  it('prints a human-readable body followed by the metadata footer for text output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    renderInvocation(ENVELOPE, 'text', () => ({
      body: '回答内容\n  你好',
      footerExtras: [tokenSegment(ENVELOPE.meta.usage)],
    }));

    expect(log).toHaveBeenCalledOnce();
    expect(stripAnsi(log.mock.calls[0]![0] as string)).toBe(
      '回答内容\n  你好\n\nmodel qwen-plus · tokens 3 in / 5 out / 8 total · request_id req-123',
    );
  });
});
