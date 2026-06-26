import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { colors } from './theme.js';

// Visible caret marker that survives stripAnsi (unlike a pure `inverse` style),
// rendered immediately before the cursor column so the insertion point is
// always discernible — including on an empty buffer.
const CURSOR_GLYPH = '▌';

export interface TextAreaProps {
  title?: string;
  placeholder?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

type Focus = 'editor' | 'buttons';
type ButtonId = 'submit' | 'cancel';

export function TextArea({ title, placeholder, onSubmit, onCancel }: TextAreaProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>(['']);
  const [cursorRow, setCursorRow] = useState(0);
  const [cursorCol, setCursorCol] = useState(0);
  const [focus, setFocus] = useState<Focus>('editor');
  const [selectedButton, setSelectedButton] = useState<ButtonId>('submit');

  const cancel = () => {
    onCancel();
    exit();
  };

  const submit = () => {
    onSubmit(lines.join('\n'));
    exit();
  };

  useInput((input, key) => {
    if (input === '\x03' || (input === 'c' && key.ctrl)) {
      cancel();
      return;
    }
    if (key.escape) {
      cancel();
      return;
    }

    if (key.tab) {
      setFocus((f) => (f === 'editor' ? 'buttons' : 'editor'));
      return;
    }

    if (focus === 'buttons') {
      if (key.leftArrow || key.rightArrow) {
        setSelectedButton((b) => (b === 'submit' ? 'cancel' : 'submit'));
        return;
      }
      if (key.return) {
        if (selectedButton === 'submit') submit();
        else cancel();
        return;
      }
      return;
    }

    if (key.return) {
      setLines((prev) => {
        const current = prev[cursorRow] ?? '';
        const before = current.slice(0, cursorCol);
        const after = current.slice(cursorCol);
        const next = [...prev];
        next.splice(cursorRow, 1, before, after);
        return next;
      });
      setCursorRow((r) => r + 1);
      setCursorCol(0);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorCol > 0) {
        setLines((prev) => {
          const next = [...prev];
          const line = next[cursorRow] ?? '';
          next[cursorRow] = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
          return next;
        });
        setCursorCol((c) => c - 1);
      } else if (cursorRow > 0) {
        const prevLineLen = lines[cursorRow - 1]?.length ?? 0;
        setLines((prev) => {
          const next = [...prev];
          next[cursorRow - 1] = (next[cursorRow - 1] ?? '') + (next[cursorRow] ?? '');
          next.splice(cursorRow, 1);
          return next;
        });
        setCursorRow((r) => r - 1);
        setCursorCol(prevLineLen);
      }
      return;
    }

    if (key.upArrow) {
      if (cursorRow > 0) {
        const target = lines[cursorRow - 1]?.length ?? 0;
        setCursorRow((r) => r - 1);
        setCursorCol((c) => Math.min(c, target));
      }
      return;
    }
    if (key.downArrow) {
      if (cursorRow < lines.length - 1) {
        const target = lines[cursorRow + 1]?.length ?? 0;
        setCursorRow((r) => r + 1);
        setCursorCol((c) => Math.min(c, target));
      }
      return;
    }
    if (key.leftArrow) {
      if (cursorCol > 0) {
        setCursorCol((c) => c - 1);
      } else if (cursorRow > 0) {
        const target = lines[cursorRow - 1]?.length ?? 0;
        setCursorRow((r) => r - 1);
        setCursorCol(target);
      }
      return;
    }
    if (key.rightArrow) {
      const lineLen = lines[cursorRow]?.length ?? 0;
      if (cursorCol < lineLen) {
        setCursorCol((c) => c + 1);
      } else if (cursorRow < lines.length - 1) {
        setCursorRow((r) => r + 1);
        setCursorCol(0);
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setLines((prev) => {
        const next = [...prev];
        const line = next[cursorRow] ?? '';
        next[cursorRow] = line.slice(0, cursorCol) + input + line.slice(cursorCol);
        return next;
      });
      setCursorCol((c) => c + input.length);
    }
  });

  const isEmpty = lines.length === 1 && lines[0] === '';
  const lineNumberWidth = String(Math.max(lines.length, 1)).length;
  const editorFooter = '\u2191\u2193\u2190\u2192 Move  Enter New line  Tab Switch focus';
  const buttonFooter = '\u2190\u2192 Select  Enter Confirm  Tab Back to editor';

  return (
    <Box flexDirection="column">
      {title ? (
        <Box marginBottom={1}>
          <Text bold color={colors.brand}>
            {title}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" borderStyle="single" borderColor={colors.border} paddingX={1}>
        {isEmpty && placeholder ? (
          focus === 'editor' ? (
            <Text>
              <Text color={colors.brand}>{CURSOR_GLYPH}</Text>
              <Text color={colors.muted}>{placeholder}</Text>
            </Text>
          ) : (
            <Text color={colors.muted}>{placeholder}</Text>
          )
        ) : (
          lines.map((line, rowIdx) => (
            <Box key={rowIdx}>
              <Text color={colors.muted}>{String(rowIdx + 1).padStart(lineNumberWidth)} </Text>
              {focus === 'editor' && rowIdx === cursorRow ? (
                renderLineWithCursor(line, cursorCol)
              ) : (
                <Text>{line || ' '}</Text>
              )}
            </Box>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>{focus === 'editor' ? editorFooter : buttonFooter}</Text>
      </Box>
      <Box marginTop={1}>
        {renderButton('submit', 'Submit', focus, selectedButton)}
        <Text>{'    '}</Text>
        {renderButton('cancel', 'Cancel', focus, selectedButton)}
      </Box>
    </Box>
  );
}

/**
 * Render a single line with a visible caret glyph inserted before the cursor
 * column. The caret sits between characters (standard editor behaviour), so the
 * character under the cursor shifts one column to the right. At the end of a
 * line (or on an empty line) only the caret is shown.
 */
function renderLineWithCursor(line: string, cursorCol: number): React.ReactElement {
  const before = line.slice(0, cursorCol);
  const after = line.slice(cursorCol);
  return (
    <Text>
      {before}
      <Text color={colors.brand}>{CURSOR_GLYPH}</Text>
      {after}
    </Text>
  );
}

function renderButton(
  id: ButtonId,
  label: string,
  focus: Focus,
  selected: ButtonId,
): React.ReactElement {
  const isActive = focus === 'buttons' && selected === id;
  if (isActive) {
    return (
      <Text bold color={colors.brand}>
        {`[ \u25B8 ${label} ]`}
      </Text>
    );
  }
  return <Text color={colors.muted}>{`[ ${label} ]`}</Text>;
}
