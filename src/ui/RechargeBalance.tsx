import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { RECHARGE_LABEL_WIDTH } from '../view-models/billing/recharge.js';
import type { BalanceSummaryViewModel } from '../view-models/billing/balance.js';
import { formatCmd } from '../utils/runtime-mode.js';

/** Properties accepted by the post-recharge balance panel. */
export interface RechargeBalanceInkProps {
  /** Omitted when the balance lookup did not succeed. */
  readonly vm?: BalanceSummaryViewModel;
}

/**
 * Show the account balance read after a recharge attempt finishes.
 *
 * The balance is informational only and never changes how the recharge result
 * is classified. A lookup failure is reported as unavailable rather than
 * replacing the payment or polling outcome.
 */
export function RechargeBalanceInk({ vm }: RechargeBalanceInkProps): React.ReactElement {
  return (
    <Section title="Balance">
      <Box flexDirection="column" paddingLeft={2}>
        {vm ? (
          <Text>
            {'AVAILABLE AMOUNT'.padEnd(RECHARGE_LABEL_WIDTH)}
            <Text color="green" bold>
              {vm.displayAmount}
            </Text>{' '}
            {vm.currency}
          </Text>
        ) : (
          <Text color="yellow">
            {`Balance is unavailable right now. Run: ${formatCmd('billing balance summary')} to try again.`}
          </Text>
        )}
      </Box>
    </Section>
  );
}
