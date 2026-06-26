import React from 'react';
import { resolveFormat, outputJSON, formatTextTable } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError, HandledError, CliError, invalidArgError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { createServices } from '../../services/index.js';
import { withSpinner } from '../../ui/spinner.js';
import { renderInteractive } from '../../ui/render.js';
import { renderWithInk } from '../../ui/render.js';
import { CategorySelector, type CategorySelection } from '../../ui/CategorySelector.js';
import { SuggestionPicker, type SuggestionChoice } from '../../ui/SuggestionPicker.js';
import { multilineInput } from '../../utils/multiline-input.js';
import { releaseOrKeepStdin } from '../../utils/stdin-control.js';
import { confirmPrompt } from '../../utils/confirm.js';
import { Table, type Column } from '../../ui/Table.js';
import type { CategoryNode } from '../../types/support.js';

const DESCRIPTION_MAX_LENGTH = 2000;

export interface SupportCreateOptions {
  format?: string;
  listCategories?: boolean;
  categoryId?: string;
  description?: string;
}

export async function supportCreateAction(options: SupportCreateOptions): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);
  const { listCategories, categoryId, description: descriptionFlag } = options;

  const isListMode = !!listCategories;
  const isNonInteractive =
    !isListMode &&
    categoryId !== undefined &&
    categoryId !== '' &&
    descriptionFlag !== undefined &&
    descriptionFlag !== '';

  try {
    // Parameter co-dependency validation (non-list, non-interactive)
    if (!isListMode && !isNonInteractive) {
      if (categoryId !== undefined && categoryId !== '' && (descriptionFlag === undefined || descriptionFlag === '')) {
        throw invalidArgError('--description is required when --category-id is provided.');
      }
      if (descriptionFlag !== undefined && descriptionFlag !== '' && (categoryId === undefined || categoryId === '')) {
        throw invalidArgError('--category-id is required when --description is provided.');
      }
    }

    // TTY guard: only for interactive mode
    if (!isListMode && !isNonInteractive && !process.stdin.isTTY) {
      throw new CliError({
        code: 'INVALID_ARGUMENT',
        message: 'Support create requires interactive terminal',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    ensureAuthenticated();
    const { supportService } = createServices();

    // ─── List mode ───────────────────────────────────────────────────────────────
    if (isListMode) {
      const tree = await withSpinner(
        'Loading categories',
        () => supportService.getCategoryTree(),
        format,
      );
      await outputCategoryTree(tree, format);
      return;
    }

    // ─── Non-interactive mode ────────────────────────────────────────────────────
    if (isNonInteractive) {
      let description = descriptionFlag.trim();
      if (description.length > DESCRIPTION_MAX_LENGTH) {
        process.stderr.write(
          `Warning: Input exceeds ${DESCRIPTION_MAX_LENGTH} characters and has been truncated.\n`,
        );
        description = description.slice(0, DESCRIPTION_MAX_LENGTH);
      }

      const validationTree = await withSpinner(
        'Validating category',
        () => supportService.getCategoryTree(),
        format,
      );
      const validIds: string[] = [];
      flattenCategoryIds(validationTree, validIds);
      if (!validIds.includes(categoryId)) {
        throw invalidArgError(
          `Invalid category ID: ${categoryId}. Use --list-categories to see available IDs.`,
        );
      }

      // Redirect: non-numeric category with helpUrl
      const targetNode = findNodeById(validationTree, categoryId);
      if (!/^\d+$/.test(categoryId) && targetNode?.helpUrl) {
        const message = `如需服务支持，请前往 ${targetNode.name} 官网获取帮助 ${targetNode.helpUrl}`;
        if (format === 'json') {
          outputJSON({ redirect: true, name: targetNode.name, url: targetNode.helpUrl });
        } else {
          console.log(message);
        }
        return;
      }

      const result = await withSpinner(
        'Creating ticket',
        () => supportService.createTicket({ categoryId, description }),
        format,
      );
      if (format === 'json') {
        outputJSON({ id: result.vid, status: 'created', categoryId });
      } else {
        console.log(`Ticket created successfully. ID: ${result.vid}`);
      }
      return;
    }

    // ─── Interactive mode ────────────────────────────────────────────────────────
    const tree = await withSpinner(
      'Loading categories',
      () => supportService.getCategoryTree(),
      format,
    );

    if (!tree || tree.length === 0) {
      throw new CliError({
        code: 'NO_CATEGORIES',
        message: 'No support categories available',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    const categorySelection = await selectCategory(tree);
    await new Promise((resolve) => setImmediate(resolve));
    releaseOrKeepStdin();

    if (!categorySelection) {
      console.log('Cancelled.');
      return;
    }

    // Redirect: non-numeric category with helpUrl
    if (!/^\d+$/.test(categorySelection.id) && categorySelection.helpUrl) {
      if (format === 'json') {
        printJSON({ redirect: true, name: categorySelection.name, url: categorySelection.helpUrl });
      } else {
        console.log(`如需服务支持，请前往 ${categorySelection.name} 官网获取帮助 ${categorySelection.helpUrl}`);
      }
      return;
    }

    // Phase 2: Description input
    let description = await multilineInput({
      title: 'Describe your issue',
      placeholder: 'Enter a detailed description of your problem...',
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseOrKeepStdin();

    if (!description.trim()) {
      console.log('Cancelled.');
      return;
    }
    description = description.trim();
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      process.stderr.write(
        `Warning: Input exceeds ${DESCRIPTION_MAX_LENGTH} characters and has been truncated.\n`,
      );
      description = description.slice(0, DESCRIPTION_MAX_LENGTH);
    }

    // Risk word check (non-blocking)
    try {
      const riskCheck = await supportService.identifyRiskWord('', description);
      if (riskCheck.hasRisk) {
        const words = riskCheck.words?.join(', ') || '';
        console.log(
          `\u26A0  Warning: Content may contain sensitive terms${words ? `: ${words}` : ''}`,
        );
      }
    } catch {
      // Silent ignore — non-blocking
    }

    // Phase 3: AI suggestion + confirmation
    let finalCategoryId = categorySelection.id;
    let finalCategoryPath = categorySelection.path;

    try {
      const suggestions = await withSpinner(
        'Getting suggestions',
        () => supportService.suggestCategory(description),
        format,
      );

      if (suggestions.length > 0) {
        const choice = await pickSuggestion(
          categorySelection.id,
          categorySelection.path,
          suggestions,
        );
        await new Promise((resolve) => setImmediate(resolve));
        releaseOrKeepStdin();

        if (!choice) {
          console.log('Cancelled.');
          return;
        }

        if (choice.kind === 'suggestion') {
          finalCategoryId = choice.categoryId;
          finalCategoryPath = choice.categoryPath;
        }
      }
    } catch {
      // Suggestion failure is non-blocking — proceed with user's original category
    }

    // Confirmation
    console.log('');
    console.log(`  Category: ${finalCategoryPath}`);
    console.log(
      `  Description: ${description.slice(0, 80)}${description.length > 80 ? '...' : ''}`,
    );
    console.log('');

    const confirmed = await confirmPrompt('Submit this ticket? [y/N]');
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }

    // Submit
    const result = await withSpinner(
      'Creating ticket',
      () => supportService.createTicket({ categoryId: finalCategoryId, description }),
      format,
    );

    if (format === 'json') {
      printJSON({ ticketId: result.vid, status: 'created' });
      return;
    }

    console.log(`\u2714  Ticket created: ${result.vid}`);
  } catch (error) {
    if (error instanceof HandledError) throw error;
    handleError(error, format);
  }
}

// ─── Helper functions ──────────────────────────────────────────────────────────

function flattenCategoryTree(nodes: CategoryNode[]): Array<{ id: string; category: string }> {
  const result: Array<{ id: string; category: string }> = [];
  function walk(items: CategoryNode[], parentPath: string) {
    for (const node of items) {
      if (node.children && node.children.length > 0) {
        walk(node.children, parentPath ? `${parentPath} > ${node.name}` : node.name);
      } else {
        const category = parentPath ? `${parentPath} > ${node.name}` : node.name;
        result.push({ id: node.id, category });
      }
    }
  }
  walk(nodes, '');
  return result;
}

function flattenCategoryIds(nodes: CategoryNode[], ids: string[]): void {
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      flattenCategoryIds(node.children, ids);
    } else {
      ids.push(node.id);
    }
  }
}

function findNodeById(nodes: CategoryNode[], id: string): CategoryNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children && node.children.length > 0) {
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

const CATEGORY_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', minWidth: 10 },
  { key: 'category', header: 'Category', minWidth: 20 },
];

async function outputCategoryTree(tree: CategoryNode[], format: string): Promise<void> {
  const items = flattenCategoryTree(tree);

  if (format === 'json') {
    outputJSON(items);
    return;
  }

  if (format === 'text') {
    const text = formatTextTable(
      ['ID', 'Category'],
      items.map((i) => [i.id, i.category]),
    );
    console.log(text);
    return;
  }

  // table (Ink)
  await renderWithInk(
    React.createElement(Table, { columns: CATEGORY_COLUMNS, data: items }),
  );
}

// ─── Interactive helpers ─────────────────────────────────────────────────────

async function selectCategory(tree: CategoryNode[]): Promise<CategorySelection | null> {
  let selection: CategorySelection | null = null;

  const element = React.createElement(CategorySelector, {
    tree,
    onSelect: (s: CategorySelection) => {
      selection = s;
    },
    onCancel: () => {
      selection = null;
    },
  });

  await renderInteractive(element);
  return selection;
}

async function pickSuggestion(
  userCategoryId: string,
  userCategoryPath: string,
  suggestions: Array<{
    categoryId: string;
    categoryName: string;
    categoryPath: string;
    score?: number;
  }>,
): Promise<SuggestionChoice | null> {
  let choice: SuggestionChoice | null = null;

  const element = React.createElement(SuggestionPicker, {
    userCategoryId,
    userCategoryPath,
    suggestions,
    onSelect: (c: SuggestionChoice) => {
      choice = c;
    },
    onCancel: () => {
      choice = null;
    },
  });

  await renderInteractive(element);
  return choice;
}
