import React, { useEffect, useState } from 'react';
import { createInterface } from 'node:readline/promises';
import { Box, Text, useApp, useInput } from 'ink';
import { colors } from './theme.js';
import { renderInteractive, renderWithInk } from './render.js';
import {
  captureStdinState,
  isolateTerminalListeners,
  attemptTerminalCleanup,
} from '../utils/stdin-control.js';
import { prepareStaticQr } from '../output/recharge-payment-block.js';
import {
  buildTokenPlanPurchasePreview,
  buildTokenPlanPaymentDisplay,
  type TokenPlanPurchasePreviewViewModel,
  type TokenPlanPurchaseResultViewModel,
} from '../view-models/subscription/tokenplan-purchase.js';
import type {
  TokenPlanPurchaseDecision,
  TokenPlanPurchaseInteraction,
} from '../services/tokenplan-purchase-service.js';
import { DecimalAmount } from '../utils/decimal-amount.js';
import { truncateByDisplayWidth } from './textWrap.js';
import { useTerminalSize } from './useTerminalSize.js';
import {
  PAYMENT_CHANNELS,
  DEFAULT_CHANNEL,
  CASH_BALANCE_DISPLAY,
} from '../config/payment-channels.js';

function useTerminalFrameSize(): { maxLines: number; width: number } {
  const { columns, rows } = useTerminalSize();
  return {
    // Ink switches to a full clear when output reaches the terminal height.
    // Keep one physical row unused so alt-screen redraws stay differential.
    maxLines: Math.max(1, rows - 1),
    // Reserving the final column also avoids eager physical wrapping on hosts
    // whose wrap behaviour differs from Ink's logical line measurement.
    width: Math.max(1, columns - 1),
  };
}

function fitLine(value: string, width: number): string {
  if (width <= 0) return '';
  return truncateByDisplayWidth(value || ' ', width);
}

interface CouponDisplayLine {
  key: string;
  text: string;
  kind: 'label' | 'detail' | 'spacer';
  optionIndex: number;
}

function couponDisplayLines(
  couponOptions: TokenPlanPurchasePreviewViewModel['couponOptions'],
  focusedIndex: number,
): CouponDisplayLine[] {
  return couponOptions.flatMap((option, optionIndex) => {
    const labelLines = option.label.split('\n');
    const focused = optionIndex === focusedIndex;
    return [
      {
        key: `${option.key}-label`,
        text: `  ${focused ? '❯' : ' '} ${labelLines[0] ?? ''}`,
        kind: 'label' as const,
        optionIndex,
      },
      ...labelLines.slice(1).map((detail, detailIndex) => ({
        key: `${option.key}-detail-${detailIndex}`,
        text: `     ${detail.trimStart()}`,
        kind: 'detail' as const,
        optionIndex,
      })),
      {
        key: `${option.key}-spacer`,
        text: ' ',
        kind: 'spacer' as const,
        optionIndex,
      },
    ];
  });
}

function focusedCouponOffset(
  lines: CouponDisplayLine[],
  focusedIndex: number,
  capacity: number,
): number {
  if (capacity <= 0 || lines.length <= capacity) return 0;
  const first = lines.findIndex((line) => line.optionIndex === focusedIndex);
  if (first < 0) return 0;
  let end = first;
  while (end < lines.length && lines[end]?.optionIndex === focusedIndex) end += 1;
  const focusedHeight = end - first;
  if (focusedHeight > capacity) return first;
  return Math.min(Math.max(0, lines.length - capacity), Math.max(0, end - capacity));
}

function CouponSelector({
  couponOptions,
  onSelect,
  onCancel,
}: {
  couponOptions: TokenPlanPurchasePreviewViewModel['couponOptions'];
  onSelect: (
    decision:
      | TokenPlanPurchaseDecision
      | { action: 'select-coupon' }
      | { action: 'custom-deduction' },
  ) => void;
  onCancel: () => void;
}) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const { maxLines, width } = useTerminalFrameSize();
  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      onCancel();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || value === 'k') {
      setFocusedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || value === 'j') {
      setFocusedIndex((i) => Math.min(couponOptions.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const option = couponOptions[focusedIndex];
      if (option) onSelect(option.decision);
    }
  });

  const showHeader = maxLines >= 2;
  const showFooter = maxLines >= 3;
  const showHeaderSpacer = maxLines >= 8;
  const contentCapacity = Math.max(
    1,
    maxLines - Number(showHeader) - Number(showFooter) - Number(showHeaderSpacer),
  );
  const allLines = couponDisplayLines(couponOptions, focusedIndex);
  const offset = focusedCouponOffset(allLines, focusedIndex, contentCapacity);
  const visibleLines = allLines.slice(offset, offset + contentCapacity);
  const current = Math.min(focusedIndex + 1, couponOptions.length);
  const header = `AVAILABLE COUPONS  [${current}/${couponOptions.length}]`;

  return (
    <Box flexDirection="column" width={width}>
      {showHeader ? (
        <Text bold wrap="truncate-end">
          {fitLine(header, width)}
        </Text>
      ) : null}
      {showHeaderSpacer ? <Text> </Text> : null}
      {visibleLines.map((line) => {
        const focused = line.optionIndex === focusedIndex && line.kind === 'label';
        return (
          <Text
            key={line.key}
            color={focused ? colors.brand : line.kind === 'detail' ? colors.muted : undefined}
            bold={focused}
            wrap="truncate-end"
          >
            {fitLine(line.text, width)}
          </Text>
        );
      })}
      {showFooter ? (
        <Text color={colors.muted} wrap="truncate-end">
          {fitLine('↑/↓ Navigate Enter Select Esc Back', width)}
        </Text>
      ) : null}
    </Box>
  );
}

function validateDeductionInput(
  raw: string,
  maxDeduction: string,
): { amount: string } | { error: string } {
  if (!raw || raw.trim() === '') return { error: '' };
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(trimmed)) {
    return { error: `Amount must be a valid number with at most two decimal places.` };
  }
  try {
    const parsed = DecimalAmount.parse(trimmed);
    const zero = DecimalAmount.parse('0');
    const max = DecimalAmount.parse(maxDeduction);
    if (parsed.compare(zero) < 0) {
      return { error: `Amount must not be negative.` };
    }
    if (parsed.compare(max) > 0) {
      return { error: `Amount must be between ¥0.00 and ¥${maxDeduction}.` };
    }
    return { amount: parsed.toCanonicalString() };
  } catch {
    return { error: `Amount must be a valid number with at most two decimal places.` };
  }
}

function DeductionInput({
  maxDeduction,
  onConfirm,
  onCancel,
}: {
  maxDeduction: string;
  onConfirm: (amount: string) => void;
  onCancel: () => void;
}) {
  const [deductionInput, setDeductionInput] = useState('');
  const [deductionError, setDeductionError] = useState('');
  const [cursorVisible, setCursorVisible] = useState(true);
  const { maxLines, width } = useTerminalFrameSize();
  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((v) => !v), 500);
    return () => clearInterval(timer);
  }, []);
  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      onCancel();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (!deductionInput.trim()) {
        onCancel();
        return;
      }
      const result = validateDeductionInput(deductionInput, maxDeduction);
      if ('error' in result) {
        setDeductionError(result.error);
      } else {
        onConfirm(result.amount);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setDeductionInput((current) => current.slice(0, -1));
      setDeductionError('');
      return;
    }
    if (/^[0-9.]$/.test(value)) {
      setDeductionInput((current) => {
        const next = current + value;
        if (value === '.' && current.includes('.')) return current;
        if (/^\d*\.?\d{0,2}$/.test(next)) return next;
        return current;
      });
      setDeductionError('');
    }
  });
  const showFooter = maxLines >= 2;
  const showTitle = maxLines >= 3;
  const showError = Boolean(deductionError) && maxLines >= 4;
  const showSpacer = maxLines >= 5 + Number(showError);
  const inputPrefix = `Amount: ${deductionInput}`;
  return (
    <Box flexDirection="column" width={width}>
      {showTitle ? (
        <Text bold wrap="truncate-end">
          {fitLine(`Enter deduction amount (max ¥${maxDeduction}):`, width)}
        </Text>
      ) : null}
      <Text wrap="truncate-end">
        {fitLine(inputPrefix, width - 1)}
        <Text color={colors.brand}>{cursorVisible ? '█' : ' '}</Text>
      </Text>
      {showError ? (
        <Text color="red" wrap="truncate-end">
          {fitLine(deductionError, width)}
        </Text>
      ) : null}
      {showSpacer ? <Text> </Text> : null}
      {showFooter ? (
        <Text color={colors.muted} wrap="truncate-end">
          {fitLine('Press Enter to confirm, Esc to go back', width)}
        </Text>
      ) : null}
    </Box>
  );
}

export function PurchasePrompt({
  vm,
  maxDeduction,
  signal,
  choose,
  cancel,
}: {
  vm: TokenPlanPurchasePreviewViewModel;
  maxDeduction: string;
  signal?: AbortSignal;
  choose: (decision: TokenPlanPurchaseDecision) => void;
  cancel: () => void;
}) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [selectingCoupon, setSelectingCoupon] = useState(false);
  const [enteringDeduction, setEnteringDeduction] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [scrollOffset, setScrollOffset] = useState(0);
  const { maxLines, width } = useTerminalFrameSize();
  const fullFooterLines = vm.options.length + 3;
  const showHeader = maxLines >= 2;
  const useFullFooter =
    maxLines - Number(showHeader) - fullFooterLines >= Math.min(1, vm.lines.length);
  const footerLines = useFullFooter ? fullFooterLines : Math.min(2, maxLines - Number(showHeader));
  const contentCapacity = Math.max(0, maxLines - Number(showHeader) - footerLines);
  const maxOffset = Math.max(0, vm.lines.length - contentCapacity);
  const safeOffset = Math.min(scrollOffset, maxOffset);
  const visibleLines = vm.lines.slice(safeOffset, safeOffset + contentCapacity);
  const inputPrefix = `Select an action (0 to cancel): ${input}`;
  const compactOptions = `Actions: ${vm.options
    .map((option) => `${option.key}=${option.label}`)
    .join('  ')}`;
  const range =
    maxOffset > 0 && contentCapacity > 0
      ? `  [${safeOffset + 1}-${safeOffset + visibleLines.length}/${vm.lines.length} ↑/↓ to view all details]`
      : '';

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, maxOffset));
  }, [maxOffset]);
  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((v) => !v), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const stop = () => exit();
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });
    return () => signal?.removeEventListener('abort', stop);
  }, [signal, exit]);
  useInput(
    (value, key) => {
      if (key.ctrl && value === 'c') {
        cancel();
        exit();
        return;
      }
      if (key.escape) {
        choose({ action: 'cancel' });
        exit();
        return;
      }
      if (key.upArrow || value === 'k') {
        setScrollOffset((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow || value === 'j') {
        setScrollOffset((current) => Math.min(maxOffset, current + 1));
        return;
      }
      const trailingReturn = /[\r\n]+$/.test(value);
      const printableValue = value.replace(/[\r\n]+$/, '');
      const trailingSubmission = trailingReturn && /^[a-z0-9]*$/i.test(printableValue);
      if (key.return || trailingSubmission) {
        const submittedInput = trailingSubmission ? `${input}${printableValue}`.slice(0, 8) : input;
        const option = vm.options.find((o) => o.key === submittedInput.trim().toLowerCase());
        if (option?.decision.action === 'select-coupon') {
          setSelectingCoupon(true);
          setInput('');
          return;
        }
        if (option?.decision.action === 'custom-deduction') {
          setEnteringDeduction(true);
          setInput('');
          return;
        }
        if (option) {
          choose(option.decision);
          exit();
        } else setInput('');
      } else if (key.backspace || key.delete) setInput((current) => current.slice(0, -1));
      else if (/^[a-z0-9]+$/i.test(value)) setInput((current) => `${current}${value}`.slice(0, 8));
    },
    { isActive: !selectingCoupon && !enteringDeduction },
  );
  if (selectingCoupon) {
    return (
      <CouponSelector
        couponOptions={vm.couponOptions}
        onSelect={(decision) => {
          if (decision.action !== 'select-coupon' && decision.action !== 'custom-deduction') {
            choose(decision);
            exit();
          }
          setSelectingCoupon(false);
        }}
        onCancel={() => setSelectingCoupon(false)}
      />
    );
  }
  if (enteringDeduction) {
    return (
      <DeductionInput
        maxDeduction={maxDeduction}
        onConfirm={(amount) => {
          choose({ action: 'balance', amount, intent: 'manual' });
          exit();
        }}
        onCancel={() => setEnteringDeduction(false)}
      />
    );
  }
  return (
    <Box flexDirection="column" width={width}>
      {showHeader ? (
        <Text bold wrap="truncate-end">
          {fitLine(`${vm.title}${range}`, width)}
        </Text>
      ) : null}
      {visibleLines.map((line, index) => (
        <Text key={`${safeOffset + index}:${line}`} wrap="truncate-end">
          {fitLine(line, width)}
        </Text>
      ))}
      {useFullFooter ? (
        <>
          <Text wrap="truncate-end">{fitLine('What would you like to do?', width)}</Text>
          <Text> </Text>
          {vm.options.map((option) => (
            <Text key={option.key} wrap="truncate-end">
              {fitLine(`${option.key}. ${option.label}`, width)}
            </Text>
          ))}
        </>
      ) : footerLines >= 2 ? (
        <Text wrap="truncate-end">{fitLine(compactOptions, width)}</Text>
      ) : null}
      {footerLines >= 1 ? (
        <Text wrap="truncate-end">
          {fitLine(inputPrefix, width - 1)}
          <Text color={colors.brand}>{cursorVisible ? '█' : ' '}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

async function plainPrompt(
  vm: TokenPlanPurchasePreviewViewModel,
  maxDeduction: string,
  signal?: AbortSignal,
): Promise<TokenPlanPurchaseDecision> {
  signal?.throwIfAborted();
  const restoreState = captureStdinState();
  const restoreListeners = isolateTerminalListeners(process.stdin, ['data', 'readable', 'end']);
  let reader: ReturnType<typeof createInterface> | undefined;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    reader = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    process.stderr.write(
      `${vm.title}\n\n${vm.lines.join('\n')}\n\nWhat would you like to do?\n${vm.options.map((option) => `${option.key}. ${option.label}`).join('\n')}\n`,
    );
    let selectingCoupon = false;
    while (true) {
      const prompt = selectingCoupon
        ? 'Select a coupon (Enter cancels purchase): '
        : 'Select an action (0 to cancel): ';
      const input = (await reader.question(prompt, { signal })).trim().toLowerCase();
      if (!input) {
        if (selectingCoupon) return { action: 'cancel' };
        continue;
      }
      const options = selectingCoupon ? vm.couponOptions : vm.options;
      const option = options.find((candidate) => candidate.key === input);
      if (option?.decision.action === 'select-coupon') {
        selectingCoupon = true;
        process.stderr.write(
          `\nAVAILABLE COUPONS\n${vm.couponOptions.map((coupon) => `${coupon.key}. ${coupon.label}`).join('\n')}\n`,
        );
        continue;
      }
      if (option?.decision.action === 'custom-deduction') {
        while (true) {
          const raw = await reader.question(
            `Enter deduction amount (max \u00a5${maxDeduction}), empty to go back: `,
            { signal },
          );
          if (!raw.trim()) break;
          const result = validateDeductionInput(raw, maxDeduction);
          if ('error' in result) {
            process.stderr.write(`${result.error}\n`);
            continue;
          }
          return { action: 'balance', amount: result.amount, intent: 'manual' };
        }
        continue;
      }
      if (option) return option.decision;
      process.stderr.write('Choose one of the displayed options.\n');
    }
  } finally {
    reader?.close();
    restoreListeners();
    restoreState();
  }
}

async function waitWithCancel(wait: Promise<unknown>, cancel: () => void): Promise<void> {
  const restoreState = captureStdinState();
  const restoreListeners = isolateTerminalListeners(process.stdin, ['data', 'readable']);
  const onData = (chunk: Buffer | string) => {
    if (String(chunk).includes(String.fromCharCode(3))) cancel();
  };
  try {
    process.stdin.on('data', onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    await wait;
  } finally {
    attemptTerminalCleanup(() => process.stdin.removeListener('data', onData));
    restoreListeners();
    restoreState();
  }
}

export function createTokenPlanPurchaseInteraction(
  format: 'json' | 'text' | 'table',
  cancel: () => void,
): TokenPlanPurchaseInteraction {
  return {
    async review(preview, signal) {
      signal?.throwIfAborted();
      const vm = buildTokenPlanPurchasePreview(preview);
      const maxDeduction = preview.maxDeduction;
      if (format !== 'table') return plainPrompt(vm, maxDeduction, signal);
      let decision: TokenPlanPurchaseDecision = { action: 'cancel' };
      await renderInteractive(
        <PurchasePrompt
          vm={vm}
          maxDeduction={maxDeduction}
          signal={signal}
          choose={(chosen) => {
            decision = chosen;
          }}
          cancel={cancel}
        />,
      );
      return decision;
    },
    async payment(url, wait, options) {
      if (format === 'json') {
        // JSON mode: no QR or text output; paymentUrl is included in the final JSON result.
        // Skip polling — return immediately so the caller gets a 'pending' result.
        return { skipPolling: true };
      }
      if (format === 'text') {
        // Text mode returns immediately; the final result owns all output, including the URL.
        return { skipPolling: true };
      }
      // Table (TTY Ink) mode: show QR + poll for payment result.
      const write = (value: string) => process.stdout.write(value);
      if (options?.details) {
        write('Creating payment order...\n\n');
        write(`${buildTokenPlanPaymentDisplay(options.details).join('\n')}\n\n`);
      }
      if (url) {
        const channelConfig = PAYMENT_CHANNELS[DEFAULT_CHANNEL];
        write(`Scan with ${channelConfig.name} to pay:\n`);
        const qr = prepareStaticQr(url, process.stdout.columns || 80);
        write(`${'lines' in qr ? qr.lines.join('\n') : qr.unavailable}\n`);
        write(`If the QR code cannot be scanned, open:\n${url}\n`);
      } else {
        write(
          `No ${PAYMENT_CHANNELS[DEFAULT_CHANNEL].name} QR payment is required. Checking payment result...\n`,
        );
        if (!options?.details) write(`CHANNEL              ${CASH_BALANCE_DISPLAY}\n`);
      }
      write(
        'Waiting for payment...\nAfter completing the payment, confirmation may take a few seconds. Please wait.\nCtrl+C stops waiting; it does not cancel the order.\n',
      );
      await waitWithCancel(wait, cancel);
    },
  };
}

export async function renderTokenPlanPurchaseResult(
  vm: TokenPlanPurchaseResultViewModel,
): Promise<void> {
  await renderWithInk(
    <Box flexDirection="column">
      <Text bold>{vm.title}</Text>
      {vm.lines.map((line) => (
        <Text key={line}>{line}</Text>
      ))}
    </Box>,
  );
}
