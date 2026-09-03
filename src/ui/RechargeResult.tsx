import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { colors, theme } from './theme.js';
import {
  RECHARGE_LABEL_WIDTH,
  buildRechargeResultDisplay,
  describeRechargeResult,
} from '../view-models/billing/recharge.js';
import type {
  RechargeResultFinalViewModel,
  RechargeResultViewModel,
} from '../view-models/billing/recharge.js';
import { formatCmd } from '../utils/runtime-mode.js';
import { classifyRechargeStatus } from '../utils/recharge-status.js';
import { wrapText } from './textWrap.js';

/** Properties accepted by the recharge result panel. */
export interface RechargeResultInkProps {
  readonly vm: RechargeResultViewModel;
  /** Whether a processing status is still being actively polled. */
  readonly polling?: boolean;
  /** Cap dynamic output so terminal resizes cannot create physical wraps. */
  readonly maxWidth?: number;
}

/** Properties accepted by the live polling result panel. */
export interface RechargeResultPollingInkProps {
  readonly rechargeOrderId: string;
  readonly resultPromise: Promise<RechargeResultFinalViewModel>;
  /** Show the local cancellation shortcut only while polling is active. */
  readonly showCancelHint?: boolean;
  /** Called after a settled result has replaced the waiting frame. */
  readonly onFinalRender?: () => void;
  /** Cap dynamic output so terminal resizes cannot create physical wraps. */
  readonly maxWidth?: number;
}

/** Render the processing, successful, failed, or inconclusive payment result. */
export function RechargeResultInk({
  vm,
  polling = false,
  maxWidth,
}: RechargeResultInkProps): React.ReactElement {
  const display = buildRechargeResultDisplay(vm);
  const disposition =
    display.status === 'succeeded'
      ? 'success'
      : display.failureReason
        ? 'failure'
        : classifyRechargeStatus(vm.status);
  return (
    <Section title="Recharge Result" maxWidth={maxWidth}>
      <Box flexDirection="column" paddingLeft={2}>
        {disposition === 'processing' && polling ? (
          <Text color="yellow">Waiting for payment...</Text>
        ) : (
          <>
            {disposition === 'success' ? (
              <Text color="green">{theme.symbols.pass} Recharge completed.</Text>
            ) : disposition === 'failure' ? (
              <>
                <Text color="red">{theme.symbols.fail} Recharge failed or timed out.</Text>
                <Text color="yellow">
                  Before trying again, check your balance: {formatCmd('billing balance summary')}
                </Text>
              </>
            ) : (
              <Text color="yellow">
                {describeRechargeResult(
                  vm.status,
                  vm.reason,
                  formatCmd('billing balance summary'),
                  formatCmd('billing balance recharge-history'),
                )}
              </Text>
            )}
            <Text> </Text>
            <Text>
              {'TYPE'.padEnd(RECHARGE_LABEL_WIDTH)}
              {vm.type}
            </Text>
            <Text>
              {'STATUS'.padEnd(RECHARGE_LABEL_WIDTH)}
              {display.status}
            </Text>
            {display.failureReason ? (
              <Text>
                {'FAILURE REASON'.padEnd(RECHARGE_LABEL_WIDTH)}
                {display.failureReason}
              </Text>
            ) : null}
          </>
        )}
      </Box>
    </Section>
  );
}

/** Properties accepted by the safe result-query failure panel. */
export interface RechargeResultQueryFailureInkProps {
  readonly maxWidth?: number;
}

/** Render a safe unknown state when the result request itself fails. */
export function RechargeResultQueryFailureInk({
  maxWidth,
}: RechargeResultQueryFailureInkProps): React.ReactElement {
  const message =
    'Payment result query stopped with an error. The recharge result is unknown; see the error below.';
  const messageLines = maxWidth ? wrapText(message, Math.max(1, maxWidth - 4)) : [message];

  return (
    <Section title="Recharge Result" maxWidth={maxWidth}>
      <Box flexDirection="column" paddingLeft={2}>
        {messageLines.map((line, index) => (
          <Text key={index} color="yellow" wrap="truncate-end">
            {line}
          </Text>
        ))}
        <Text> </Text>
        <Text>
          {'TYPE'.padEnd(RECHARGE_LABEL_WIDTH)}
          recharge
        </Text>
        <Text>{'STATUS'.padEnd(RECHARGE_LABEL_WIDTH)}unknown</Text>
      </Box>
    </Section>
  );
}

/**
 * Render a waiting frame immediately and replace it with the final safe result
 * when the existing-order polling promise settles.
 *
 * @param props Existing order identifier and its single polling promise.
 * @returns A live Ink result panel; rejected promises replace the waiting frame
 * with an unknown result while the command layer renders the classified error.
 */
export function RechargeResultPollingInk({
  rechargeOrderId,
  resultPromise,
  showCancelHint = false,
  onFinalRender,
  maxWidth,
}: RechargeResultPollingInkProps): React.ReactElement {
  const [value, setValue] = useState<RechargeResultViewModel>({
    type: 'recharge',
    rechargeOrderId,
    status: 'WAIT',
  });
  const [queryFailed, setQueryFailed] = useState(false);
  const isProcessing = classifyRechargeStatus(value.status) === 'processing';

  useEffect(() => {
    let active = true;
    void resultPromise.then(
      (result) => {
        if (active) setValue(result);
      },
      () => {
        // The command owns the precise error and exit code. The frame only
        // records that polling stopped and the payment result remains unknown.
        if (active) setQueryFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [resultPromise]);

  useEffect(() => {
    if ((isProcessing && !queryFailed) || !onFinalRender) return;
    // Passive effects run after the final frame commits. Deferring one tick
    // lets Ink flush it before the parent closes the interactive renderer.
    const handle = setImmediate(onFinalRender);
    return () => clearImmediate(handle);
  }, [isProcessing, onFinalRender, queryFailed]);

  return (
    <>
      {queryFailed ? (
        <RechargeResultQueryFailureInk maxWidth={maxWidth} />
      ) : (
        <RechargeResultInk vm={value} polling maxWidth={maxWidth} />
      )}
      {showCancelHint && isProcessing && !queryFailed ? (
        <Box paddingLeft={4} flexDirection="column">
          {(maxWidth == null
            ? ['Press Ctrl+C to stop.']
            : wrapText('Press Ctrl+C to stop.', Math.max(1, maxWidth - 4))
          ).map((line, index) => (
            <Text key={index} color={colors.muted} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </>
  );
}
