import * as readline from 'readline';
import { homedir } from 'os';
import { createProgram } from './cli.js';
import { resolveCredentials } from './auth/credentials.js';
import { getEffectiveConfig } from './config/manager.js';
import { VERSION } from './index.js';
import { flushDebugReport, clearDebugBuffer } from './api/debug-buffer.js';
import { SUBCOMMANDS, tabCompleter, getGhostSuffix, unknownCommandMsg } from './repl/completer.js';
import { setReplMode } from './utils/runtime-mode.js';
import chalk from 'chalk';
import { site } from './site.js';
import { theme, colors } from './ui/theme.js';
import { CliError, getErrorVerbosity } from './utils/errors.js';
import { classifyHttpError } from './utils/api-errors.js';

// Brand color for prompt — resolved from site config at runtime
const brand = chalk.hex(site.uiTheme.brand);

/**
 * Display an error in the REPL respecting the current error verbosity.
 * - suppress: no output
 * - graceful: user-friendly message only
 * - verbose: full diagnostic info
 */
function replErrorDisplay(err: unknown): void {
  const verbosity = getErrorVerbosity();
  if (verbosity === 'suppress') return;

  const cliError = err instanceof CliError ? err : classifyHttpError(err);

  if (verbosity === 'verbose') {
    const detail = cliError.detail ?? '';
    const output = detail
      ? `  Error: ${cliError.message}\n  ${detail.split('\n').join('\n  ')}`
      : `  Error: ${cliError.message}`;
    console.error(output);
  } else {
    // graceful (default)
    console.error(`  ${theme.error(theme.symbols.fail)} Error: ${cliError.message}`);
  }
}

async function resolveUserDisplay(): Promise<string> {
  const creds = resolveCredentials();
  if (!creds) return '';

  const user = creds.credentials?.user;
  const local = user?.email || user?.aliyunId || '';
  if (local) return local;

  // local credentials have no user info; fetch from server with timeout
  try {
    const config = getEffectiveConfig();
    const baseUrl = (config['api.endpoint'] as string).replace(/\/+$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${baseUrl}/api/account/info.json`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) {
      const json = (await response.json()) as { data?: { aliyunId?: string } };
      return json.data?.aliyunId ?? '';
    }
  } catch {
    // ignore — logo shows empty
  }
  return '';
}

export async function startRepl(): Promise<void> {
  // Mark runtime as REPL mode so error messages use short command hints
  setReplMode();

  // Print logo
  const userDisplay = await resolveUserDisplay();
  printLogo(userDisplay);

  // Track whether we're currently executing a command (for process.exit interception)
  let executingCommand = false;
  const realExit = process.exit;

  // Override process.exit once — intercept only during command execution
  (process as any).exit = ((code?: number) => {
    if (executingCommand) {
      throw Object.assign(new Error('process.exit intercepted'), {
        code: 'repl.exit.intercepted',
        exitCode: code ?? 0,
      });
    }
    // Not executing a command — allow real exit
    realExit(code as any);
  }) as typeof process.exit;

  // Create readline interface with history and Tab completion
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 100,
    prompt: getPrompt(),
    completer: tabCompleter,
  });

  // ── Ghost text (inline suggestion) ─────────────────────────────────────────
  let ghostSuffix = '';

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', (_str: string | undefined, key: any) => {
      if (!key) return;
      // Right arrow / End at end-of-line → accept the ghost text
      if ((key.name === 'right' || key.name === 'end') && ghostSuffix) {
        const ghost = ghostSuffix;
        ghostSuffix = '';
        setImmediate(() => {
          const cursor: number = (rl as any).cursor ?? 0;
          const line: string = (rl as any).line ?? '';
          if (cursor >= line.length) rl.write(ghost);
        });
        return;
      }
      // Any other key → recompute ghost after readline has processed the keystroke
      setImmediate(() => {
        const line: string = (rl as any).line ?? '';
        ghostSuffix = getGhostSuffix(line);
        if (ghostSuffix) {
          // Save cursor pos, write dim ghost, restore cursor pos
          process.stdout.write('\x1b7' + chalk.italic.hex(colors.ghost)(ghostSuffix) + '\x1b8');
        }
      });
    });
  }

  // Ctrl+C double-press handling
  let ctrlCCount = 0;
  let ctrlCTimer: NodeJS.Timeout | null = null;

  rl.on('SIGINT', () => {
    if (ctrlCCount === 0) {
      ctrlCCount = 1;
      console.log('\n  Press Ctrl+C again to exit.');
      ctrlCTimer = setTimeout(() => {
        ctrlCCount = 0;
      }, 2000);
      rl.prompt();
    } else {
      // Second Ctrl+C within 2 seconds
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      console.log('');
      realExit(0);
    }
  });

  // Ctrl+D (EOF) - silent exit
  // Guard: Ink's render/unmount cycle may pause stdin and trigger a spurious
  // 'close' event on readline while a command is still executing. In that
  // case we must NOT exit — the command's finally block will restore stdin.
  rl.on('close', () => {
    if (executingCommand) return;
    realExit(0);
  });

  // Main input loop
  rl.on('line', async (line) => {
    ghostSuffix = ''; // clear any ghost when a line is submitted
    const input = line.trim();

    // Empty input - just reprompt
    if (!input) {
      rl.prompt();
      return;
    }

    // Clear screen
    if (['clear', 'cls'].includes(input.toLowerCase())) {
      process.stdout.write('\x1b[2J\x1b[H');
      rl.setPrompt(getPrompt());
      rl.prompt();
      return;
    }

    // Exit commands
    if (['exit', 'quit', 'q'].includes(input.toLowerCase())) {
      console.log('  Goodbye!');
      rl.close();
      return;
    }

    // Parse and execute command
    try {
      // Create a fresh program for each command to avoid state leakage
      const program = createProgram();

      // Split input into argv-style tokens (handle quoted strings)
      const args = parseArgs(input);

      // Handle "help" as a special REPL command
      // "help" → show top-level help
      // "help <cmd>" → show that command's help
      // "help <cmd> <sub>" → show subcommand help
      // Helper: append REPL-only built-ins after Commander's top-level help
      const printReplBuiltins = () => {
        console.log('');
        console.log(`  REPL built-ins:`);
        console.log(`  ${'clear, cls'.padEnd(24)}Clear the terminal screen`);
        console.log(`  ${'exit, quit, q'.padEnd(24)}Exit the REPL`);
        console.log('');
      };

      if (args[0] === 'help') {
        if (args.length === 1) {
          // Top-level help — capture output so we can reorder the footer
          let helpOutput = '';
          const origWrite = process.stdout.write.bind(process.stdout);
          try {
            (process.stdout as any).write = (chunk: any) => {
              helpOutput += String(chunk);
              return true;
            };
            program.outputHelp();
          } finally {
            (process.stdout as any).write = origWrite;
          }

          // Separate the footer line ("Run … --help for command-specific help.")
          const helpLines = helpOutput.split('\n');
          const footerIdx = helpLines.findIndex((l) =>
            l.includes('--help for command-specific help'),
          );
          let footerLine = '';
          if (footerIdx !== -1) {
            footerLine = helpLines[footerIdx];
            helpLines.splice(footerIdx, 1);
          }
          process.stdout.write(helpLines.join('\n'));
          printReplBuiltins();
          if (footerLine) console.log(footerLine + '\n');
        } else {
          // Find the target command and show its help
          program.exitOverride();
          program.configureOutput({
            writeErr: () => {},
            writeOut: (str) => process.stdout.write(str),
          });
          try {
            await program.parseAsync(['node', site.cliName, ...args.slice(1), '--help']);
          } catch (err: any) {
            if (err.code !== 'commander.helpDisplayed') {
              console.log(unknownCommandMsg(args.slice(1).join(' ')));
            }
          }
        }
        rl.setPrompt(getPrompt());
        rl.prompt();
        return;
      }

      // Prevent Commander from calling process.exit on errors
      program.exitOverride();

      // Detect if this is a top-level help flag (-h / --help with no subcommand)
      const isTopLevelHelpFlag =
        (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) ||
        (args.length === 2 && !SUBCOMMANDS[args[0]] && (args[1] === '-h' || args[1] === '--help'));

      // Buffer to capture Commander's output when we need to reorder the footer
      let capturedOut = isTopLevelHelpFlag ? '' : null;

      // Suppress Commander's default error output in REPL
      program.configureOutput({
        writeErr: (str) => {
          // Filter out Commander's boilerplate, show useful errors
          if (!str.includes('error: unknown command')) {
            process.stderr.write(str);
          }
        },
        writeOut: (str) => {
          if (capturedOut !== null) {
            capturedOut += str;
          } else {
            process.stdout.write(str);
          }
        },
      });

      try {
        executingCommand = true;
        // Execute - prepend dummy argv[0] and argv[1] for Commander
        await program.parseAsync(['node', site.cliName, ...args]);
      } catch (err: any) {
        if (err.code === 'repl.exit.intercepted') {
          // Swallow — command tried to exit, we just continue the REPL
        } else if (err.code === 'commander.helpDisplayed') {
          if (capturedOut !== null) {
            // Reorder: main help → REPL built-ins → footer
            const helpLines = capturedOut.split('\n');
            const footerIdx = helpLines.findIndex((l) =>
              l.includes('--help for command-specific help'),
            );
            let footerLine = '';
            if (footerIdx !== -1) {
              footerLine = helpLines[footerIdx];
              helpLines.splice(footerIdx, 1);
            }
            process.stdout.write(helpLines.join('\n'));
            printReplBuiltins();
            if (footerLine) console.log(footerLine + '\n');
          }
        } else if (err.code === 'commander.version') {
          // Version was displayed, that's fine
        } else if (err.code === 'commander.unknownCommand') {
          console.log(unknownCommandMsg(input));
        } else if (err.exitCode !== undefined && err.exitCode !== 0) {
          // HandledError — handleError() already printed the message
        } else {
          // Unexpected error — format according to verbosity
          replErrorDisplay(err);
        }
      } finally {
        executingCommand = false;
        flushDebugReport();
        clearDebugBuffer();
      }
    } catch (err: any) {
      replErrorDisplay(err);
    }

    // Restore REPL prompt after command execution.
    //
    // Ink's render/unmount cycle writes ANSI escape sequences to stdout
    // (cursor hide/show, eraseLines) that desync readline's internal
    // cursor position tracking. As a result, rl.prompt() may write the
    // prompt string to a position readline thinks is correct but the
    // terminal disagrees — making the prompt invisible.
    //
    // Reliable fix: use setTimeout to defer prompt restoration until
    // after ALL of Ink's teardown (log-update.done, cliCursor.show,
    // reconciler cleanup) has completed and stdout has been flushed.
    // Then restore stdin state and call rl.prompt().
    await new Promise<void>((resolve) => setTimeout(resolve, 32));
    rl.setPrompt(getPrompt());
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    // Re-ref stdin after Ink's unmount calls stdin.unref(), which would
    // otherwise let the event loop drain and exit the process silently.
    process.stdin.ref();
    (rl as any).line = '';
    (rl as any).cursor = 0;
    rl.prompt();
  });

  // Start
  rl.prompt();
}

function getPrompt(): string {
  return brand(site.replPrompt);
}

/** Returns the terminal display width of a string (CJK chars count as 2 columns). */
function displayWidth(str: string): number {
  let w = 0;
  for (const char of str) {
    const cp = char.codePointAt(0)!;
    // Wide character ranges (CJK, fullwidth, etc.)
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2ceaf)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Truncate a path from the left so its display width ≤ maxW, prefixing with '…'. */
function truncatePathLeft(path: string, maxW: number): string {
  if (displayWidth(path) <= maxW) return path;
  const chars = [...path];
  for (let i = 1; i < chars.length; i++) {
    const candidate = '…' + chars.slice(i).join('');
    if (displayWidth(candidate) <= maxW) return candidate;
  }
  return '…';
}

function printLogo(userDisplay: string): void {
  // Gradient: purple → magenta → periwinkle (from user-provided reference)
  function hexToRgb(hex: string): [number, number, number] {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  function gradientLine(text: string, startHex: string, endHex: string): string {
    const start = hexToRgb(startHex);
    const end = hexToRgb(endHex);
    const len = text.length;
    return [...text]
      .map((char, i) => {
        const t = len > 1 ? i / (len - 1) : 0;
        const r = Math.round(start[0] + (end[0] - start[0]) * t);
        const g = Math.round(start[1] + (end[1] - start[1]) * t);
        const b = Math.round(start[2] + (end[2] - start[2]) * t);
        return chalk.rgb(r, g, b)(char);
      })
      .join('');
  }

  // ANSI Shadow font — site-specific art (side by side)
  const { leftLines, rightLines, leftWidth, rightWidth, combinedWidth: INNER } = site.asciiArt;

  // Merge left + right into single lines
  const combined = leftLines.map((l, i) => l.padEnd(leftWidth) + ' ' + (rightLines[i] ?? '').padEnd(rightWidth));

  // Box inner width must fit both the ASCII art and the bottom split row (84 chars).
  const BOX_INNER = Math.max(INNER, 84);

  const logo = site.uiTheme.logo;
  const box = chalk.hex(logo.border);

  const emptyRow = `  ${box('║')}${' '.repeat(BOX_INNER + 2)}${box('║')}`;
  const topRow = `  ${box('╔' + '═'.repeat(BOX_INNER + 2) + '╗')}`;
  const dividerRow = `  ${box('╠' + '═'.repeat(BOX_INNER + 2) + '╣')}`;
  const bottomRow = `  ${box('╚' + '═'.repeat(BOX_INNER + 2) + '╝')}`;

  // Full-width gradient across the combined line, centered in BOX_INNER
  const artRow = (line: string) => {
    const pad = Math.max(0, BOX_INNER - line.length);
    const leftPad = Math.floor(pad / 2);
    const rightPad = pad - leftPad;
    const padded = ' '.repeat(leftPad) + line.padEnd(INNER) + ' '.repeat(rightPad);
    return `  ${box('║')} ${gradientLine(padded, logo.gradientStart, logo.gradientEnd)} ${box('║')}`;
  };

  // Centered text row (raw for length calc, styled for display)
  const _centerRow = (raw: string, styled: string) => {
    const pad = Math.max(0, BOX_INNER - raw.length);
    const l = Math.floor(pad / 2);
    const r = pad - l;
    return `  ${box('║')} ${' '.repeat(l)}${styled}${' '.repeat(r)} ${box('║')}`;
  };

  console.log('');
  console.log(topRow);
  console.log(emptyRow);
  combined.forEach((line) => console.log(artRow(line)));
  console.log(emptyRow);
  console.log(dividerRow);

  // --- Bottom: left/right split ---
  // Layout: ║ space(1) L │ space(1) R space(1) ║  → inner = BOX_INNER + 2 (matches other rows)
  const L = 40;
  const R = 40;
  // Fixed chars between ║…║: leading space(1) + pipe(1) + space(1) + trailing space(1) = 4
  // Variable L+R must fill: (BOX_INNER + 2) - 4 = BOX_INNER - 2
  const totalLR = BOX_INNER - 2;
  const adjustedL = Math.max(L, Math.floor(totalLR / 2));
  const adjustedR = Math.max(R, totalLR - adjustedL);

  // OSC 8 terminal hyperlink (works in iTerm2, Kitty, WezTerm, VS Code terminal)
  const link = (text: string, url: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

  const splitEmpty = `  ${box('║')} ${' '.repeat(adjustedL)}${box('│')} ${' '.repeat(adjustedR)} ${box('║')}`;

  // Use displayWidth for padding so CJK/wide chars don't overflow the box
  const splitRow = (lRaw: string, lStyled: string, rRaw: string, rStyled: string) => {
    const lPad = ' '.repeat(Math.max(0, adjustedL - displayWidth(lRaw)));
    const rPad = ' '.repeat(Math.max(0, adjustedR - displayWidth(rRaw)));
    return `  ${box('║')} ${lStyled}${lPad}${box('│')} ${rStyled}${rPad} ${box('║')}`;
  };

  // Right column: user + cwd info
  let userRaw: string;
  let userStyled: string;
  if (userDisplay) {
    const display = userDisplay.length > 32 ? userDisplay.slice(0, 31) + '…' : userDisplay;
    userRaw = display;
    userStyled = chalk.white(display);
  } else if (!resolveCredentials()) {
    userRaw = 'Not logged in';
    userStyled = chalk.dim('Not logged in');
  } else {
    userRaw = '';
    userStyled = '';
  }

  // Truncate cwd from the left so "· <cwd>" fits within R display cols
  const rawCwd = process.cwd().replace(homedir(), '~');
  const cwdRaw = truncatePathLeft(rawCwd, R - 2); // subtract 2 for "· "
  const cwdStyled = chalk.hex(colors.muted)(cwdRaw);

  const dim = (s: string) => chalk.hex(colors.muted)(s);
  const blue = (s: string) => chalk.hex(logo.link)(s);

  const websiteText = site.websiteUrl;
  const websiteStyled = blue(link(websiteText, `https://${site.websiteUrl}`));

  // Row definitions: [leftRaw, leftStyled, rightRaw, rightStyled]
  const rows: [string, string, string, string][] = [
    [
      site.cliDisplayName,
      chalk.bold.white(site.cliDisplayName),
      `· ${websiteText}`,
      `${dim('·')} ${websiteStyled}`,
    ],
    [
      `v${VERSION}`,
      chalk.hex(logo.gradientStart)(`v${VERSION}`),
      `· ${userRaw}`,
      `${dim('·')} ${userStyled}`,
    ],
    ['', '', `· ${cwdRaw}`, `${dim('·')} ${cwdStyled}`],
    [
      'Built for Builders. Native to Agents.',
      brand('Built for Builders. Native to Agents.'),
      '',
      '',
    ],
  ];

  console.log(splitEmpty);
  rows.forEach(([lR, lS, rR, rS]) => console.log(splitRow(lR, lS, rR, rS)));
  console.log(splitEmpty);
  console.log(bottomRow);
  console.log('');
  console.log(chalk.dim('  Type a command to get started. Run help for available commands.'));
  console.log(chalk.dim('  Type exit, quit, or q to leave.'));
  console.log('');
}

/**
 * Parse a command line string into tokens, respecting quoted strings.
 */
function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === ' ' || char === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}
