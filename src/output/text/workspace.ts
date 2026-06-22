import type {
  WorkspaceListViewModel,
  WorkspaceLimitViewModel,
} from '../../view-models/workspace/index.js';
import { formatTextTable } from '../format.js';

const LIST_HEADERS = ['ID', 'Name', 'Region', 'Created', 'Default'];

export function renderTextWorkspaceList(vm: WorkspaceListViewModel): void {
  const rows = vm.rows.map((row) => [
    row.id,
    row.name,
    row.region,
    row.createdAt,
    row.isDefault ? 'yes' : 'no',
  ]);

  console.log(formatTextTable(LIST_HEADERS, rows));
  const limitText = vm.limit > 0 ? `  ·  Limit ${vm.limit}` : '';
  console.log(`  ${vm.total} workspaces${limitText}`);
}

export function renderTextWorkspaceLimit(vm: WorkspaceLimitViewModel): void {
  console.log(`  Current   ${vm.current}`);
  console.log(`  Maximum   ${vm.max}`);
}
