import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DocsViewer } from '../../src/ui/DocsViewer.js';
import { AltScreenContext } from '../../src/ui/render.js';
import { visibleWidth } from '../../src/ui/textWrap.js';
import type { DocContentViewModel } from '../../src/view-models/docs/index.js';

vi.mock('../../src/utils/open-browser.js', () => ({
  openBrowser: vi.fn(),
}));

// resize 重渲染会重跑 ink useInput 的 raw-mode 副作用，而 ink-testing-library 的假
// stdin 没有 ref()/unref()，会把组件树炸成错误屏。本文件不测键盘交互，按
// InteractiveTable.test 的同一约定把 useInput 换成空实现。
vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: () => {},
  };
});

const ORIGINAL_COLUMNS = process.stdout.columns;
const ORIGINAL_ROWS = process.stdout.rows;

beforeEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: ORIGINAL_COLUMNS, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: ORIGINAL_ROWS, configurable: true });
});

const MOCK_URL = 'https://mock-docs.test.qianwenai.com/developer-guides/getting-started';

function makeContentVm(overrides: Partial<DocContentViewModel> = {}): DocContentViewModel {
  return {
    url: MOCK_URL,
    resolvedMarkdownUrl: `${MOCK_URL}.md`,
    content: '# Getting Started\n\nWelcome to the docs.',
    renderedLines: ['[H1] Getting Started', '', 'Welcome to the docs.'],
    error: null,
    anchor: null,
    anchorLine: null,
    ...overrides,
  };
}

function docsViewerLineCount(altScreen: boolean, vm?: DocContentViewModel): number {
  const inst = render(
    <AltScreenContext.Provider value={altScreen}>
      <DocsViewer vm={vm ?? makeContentVm()} url={MOCK_URL} onBack={() => {}} onQuit={() => {}} />
    </AltScreenContext.Provider>,
  );
  const count = stripAnsi(inst.lastFrame() ?? '').split('\n').length;
  inst.unmount();
  return count;
}

describe('DocsViewer alt-screen scrollback safety', () => {
  // rows is forced to 40 in beforeEach; the default doc is short (a few lines).
  it('pads to full terminal height when NOT on the alt-screen', () => {
    // Off the alt-screen (e.g. ConHost) the full-height padding is retained so
    // the redraw clears residue as before.
    expect(docsViewerLineCount(false)).toBeGreaterThanOrEqual(38);
  });

  it('does NOT pad to full height on the alt-screen (avoids Ink clearTerminal / \\x1b[3J)', () => {
    // On the alt-screen the buffer switch already guarantees a clean exit;
    // padding would push Ink into its clearTerminal path, whose \x1b[3J wipes
    // the terminal scrollback on Terminal.app/iTerm2. So the output stays at
    // chrome + content height only, well below the 40-row terminal.
    expect(docsViewerLineCount(true)).toBeLessThan(20);
  });

  it('renders fewer rows on the alt-screen than off it for the same document', () => {
    const vm = makeContentVm();
    expect(docsViewerLineCount(false, vm)).toBeGreaterThan(docsViewerLineCount(true, vm));
  });

  it('keeps height below the terminal for long docs that fill the viewport', () => {
    // A document taller than the viewport. Off the alt-screen it reaches full
    // terminal height; on the alt-screen one content row is reserved so the
    // total height stays < rows, keeping Ink off its clearTerminal (\x1b[3J) path.
    const longVm = makeContentVm({
      renderedLines: Array.from({ length: 80 }, (_, i) => `paragraph line ${i + 1}`),
      content: 'x',
    });
    expect(docsViewerLineCount(true, longVm)).toBeLessThan(docsViewerLineCount(false, longVm));
  });

  it('极小终端（rows=8）alt-screen 下帧总行数 ≤ termRows - 1', () => {
    // 旧逻辑的 viewHeight 下限 5 使 chrome(5)+content 恒 ≥ rows，每帧都命中
    // clearTerminal(\x1b[3J)。修复后下限压缩到 1，帧高保持 ≤ rows-1。
    Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true });
    const longVm = makeContentVm({
      renderedLines: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`),
      content: 'x',
    });
    expect(docsViewerLineCount(true, longVm)).toBeLessThanOrEqual(7);
  });
});

describe('DocsViewer 窄终端宽度自适应（任何行不超过终端宽度）', () => {
  // 行显示宽度超过终端宽度会发生物理 wrap，物理行数 > 逻辑行数导致 Ink 差分擦除
  // 错位、旧帧残留（与 InteractiveTable 同一根因）。标题/正文/代码/列表/footer
  // 均须显式截断到 ≤ termCols。
  function setTermSize(columns: number, rows: number): void {
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  }

  const wideVm = makeContentVm({
    renderedLines: [
      '[H1] 一个非常非常非常非常非常非常非常非常长的中文文档标题超出四十列宽度',
      '',
      'https://mock-docs.test.qianwen.com/very/long/path/segment/that/never/fits/in/forty/columns',
      '[CODE] const veryLongVariableName = await client.request({ product: "sfm_bailian" });',
      '[LIST] 列表项内容也很长很长很长很长很长很长很长很长很长很长很长很长很长',
      '段落[BOLD]加粗片段也非常非常非常非常非常长[/BOLD]结尾继续追加更多中文文字加长',
      '[H3] 三级标题同样是一条很长很长很长很长很长很长很长的标题行',
    ],
  });

  function wideFrame(): string {
    const inst = render(
      <AltScreenContext.Provider value={true}>
        <DocsViewer vm={wideVm} url={MOCK_URL} onBack={() => {}} onQuit={() => {}} />
      </AltScreenContext.Provider>,
    );
    const f = inst.lastFrame() ?? '';
    inst.unmount();
    return f;
  }

  it('40 列下每行显示宽度均 ≤ 40（含 CJK 标题/长 URL/长代码行/加粗段落/footer）', () => {
    setTermSize(40, 20);
    const out = wideFrame();
    for (const line of out.split('\n')) {
      // visibleWidth 剥离 ANSI 并按 CJK 2 列计宽。
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    // 超宽行以省略号截断而非换行。
    expect(out).toContain('…');
  });

  it('40 列下正文内容仍然可见（截断不丢整行）', () => {
    setTermSize(40, 20);
    const out = stripAnsi(wideFrame());
    expect(out).toContain('https://mock-docs.test.qianwen.com');
    expect(out).toContain('const veryLongVariableName');
    expect(out).toContain('段落');
    expect(out).toContain('列表项');
  });

  it('resize 缩窄后基于 useTerminalSize 重算，所有行 ≤ 新宽度', async () => {
    setTermSize(80, 20);
    const inst = render(
      <AltScreenContext.Provider value={true}>
        <DocsViewer vm={wideVm} url={MOCK_URL} onBack={() => {}} onQuit={() => {}} />
      </AltScreenContext.Provider>,
    );
    // 等 effect flush：useTerminalSize 在 useEffect 里才订阅 resize 事件。
    await new Promise((r) => setTimeout(r, 20));
    // 缩小窗口：更新 stdout 尺寸并触发 resize 事件，驱动 useTerminalSize 重渲染。
    setTermSize(40, 20);
    process.stdout.emit('resize');
    await new Promise((r) => setTimeout(r, 20));
    const out = inst.lastFrame() ?? '';
    inst.unmount();
    for (const line of out.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it('加载失败分支下 Section 标题行同样被截断到终端宽度', () => {
    setTermSize(40, 20);
    const errVm = makeContentVm({
      content: null,
      renderedLines: null,
      error: 'fetch failed',
    });
    const inst = render(
      <AltScreenContext.Provider value={true}>
        <DocsViewer vm={errVm} url={MOCK_URL} onBack={() => {}} onQuit={() => {}} />
      </AltScreenContext.Provider>,
    );
    const out = inst.lastFrame() ?? '';
    inst.unmount();
    // 标题行（首行，域名标题 + 破折号装饰）不得超宽；错误详情/URL 行走 Ink 默认
    // wrap 折成多条逻辑行，属安全路径，不在此断言。
    const firstLine = out.split('\n')[0] ?? '';
    expect(visibleWidth(firstLine)).toBeLessThanOrEqual(40);
  });
});
