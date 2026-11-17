import type { ApiCallViewModel } from '../../view-models/api-call.js';
import { formatTextTable } from '../format.js';

export function renderTextApiCall(vm: ApiCallViewModel): void {
  console.log(
    formatTextTable(
      ['FIELD', 'VALUE'],
      vm.rows.map(({ field, value }) => [field, value]),
    ),
  );
}
