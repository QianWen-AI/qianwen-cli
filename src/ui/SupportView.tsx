import React from 'react';
import { Box, Text } from 'ink';
import { Card, CardLine, Section as CardSection } from './Card.js';
import { theme } from './theme.js';
import {
  wrapTextWithIndent,
  padEndVisible,
  visibleWidth,
  truncateByDisplayWidth,
} from './textWrap.js';
import { renderWithInk } from './render.js';
import { useTerminalSize } from './useTerminalSize.js';
import type {
  SupportViewViewModel,
  SupportMessageViewModel,
} from '../view-models/support/index.js';

export interface SupportViewInkProps {
  vm: SupportViewViewModel;
}

const LABEL_WIDTH = 11;

function kv(label: string, value: string): string {
  return theme.label(padEndVisible(label, LABEL_WIDTH)) + value;
}

function roleColor(role: string): (text: string) => string {
  const lower = role.toLowerCase();
  if (lower === 'customer' || lower === 'user') return theme.brand;
  if (lower === 'system' || lower === 'robot') return theme.muted;
  return theme.data;
}

function MessageBlock({
  msg,
  innerWidth,
  width,
}: {
  msg: SupportMessageViewModel;
  innerWidth: number;
  width: number;
}) {
  const colorize = roleColor(msg.role);
  const speaker = msg.nickName ? `${msg.displayRole} \u00B7 ${msg.nickName}` : msg.displayRole;
  const dateStr = msg.createdAt;

  const speakerColored = colorize(speaker);
  const dateColored = theme.muted(dateStr);
  const combined = `${speakerColored}  ${dateColored}`;

  let headerLines: string[];
  if (visibleWidth(combined) <= innerWidth) {
    headerLines = [combined];
  } else {
    const maxSpeakerWidth = Math.max(
      innerWidth - visibleWidth(dateStr) - 2,
      Math.floor(innerWidth * 0.6),
    );
    const truncatedSpeaker =
      visibleWidth(speaker) > maxSpeakerWidth
        ? colorize(truncateByDisplayWidth(speaker, maxSpeakerWidth))
        : speakerColored;
    const retry = `${truncatedSpeaker}  ${dateColored}`;
    if (visibleWidth(retry) <= innerWidth) {
      headerLines = [retry];
    } else {
      headerLines = [truncatedSpeaker, dateColored];
    }
  }

  const body = msg.content && msg.content.trim().length > 0 ? msg.content : '\u2014';
  const wrapped = wrapTextWithIndent(body, innerWidth);

  return (
    <>
      <CardLine width={width} lines={headerLines} />
      <CardLine width={width} lines={wrapped} />
    </>
  );
}

export function SupportViewInk({ vm }: SupportViewInkProps) {
  const paddingLeft = 2;
  const { columns } = useTerminalSize();
  const terminalWidth = Math.max(20, columns);
  const w = Math.max(40, Math.min(terminalWidth - paddingLeft, 100));
  const innerWidth = Math.max(0, w - 6);

  const titleLines = wrapTextWithIndent(vm.ticket.title, innerWidth);
  const descriptionLines = wrapTextWithIndent(vm.ticket.description, innerWidth);

  const cardTitle = `Ticket ${vm.ticket.id}`;

  const overviewLines: string[] = [
    ...titleLines.map((line, idx) =>
      idx === 0 ? kv('Title', line) : ' '.repeat(LABEL_WIDTH) + line,
    ),
    kv('Status', theme.accent(vm.ticket.status)),
    kv('Category', vm.ticket.category),
    kv('Created', vm.ticket.createdAt),
  ];

  return (
    <Card title={cardTitle} width={w}>
      <CardSection title="Overview" width={w}>
        <CardLine width={w} lines={overviewLines} />
      </CardSection>

      <CardSection title="Description" width={w}>
        <CardLine width={w} lines={descriptionLines} />
      </CardSection>

      {vm.messageCount > 0 && (
        <CardSection title={`Messages (${vm.messageCount})`} width={w}>
          {vm.messages.map((msg, idx) => (
            <React.Fragment key={`msg-${idx}`}>
              <MessageBlock msg={msg} innerWidth={innerWidth} width={w} />
              {idx < vm.messages.length - 1 && (
                <Box flexDirection="column">
                  <Text>
                    {theme.border('\u251C') +
                      theme.border('\u2500'.repeat(w - 2)) +
                      theme.border('\u2524')}
                  </Text>
                </Box>
              )}
            </React.Fragment>
          ))}
          {vm.truncated && (
            <CardLine
              width={w}
              lines={[theme.muted('Showing latest 100 messages. Older messages truncated.')]}
            />
          )}
        </CardSection>
      )}
    </Card>
  );
}

export async function renderSupportViewInk(vm: SupportViewViewModel): Promise<void> {
  await renderWithInk(<SupportViewInk vm={vm} />);
}
