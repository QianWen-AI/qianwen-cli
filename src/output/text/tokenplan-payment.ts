import type { TokenPlanPaymentResultViewModel } from '../../types/tokenplan-payment.js';

export function renderTextTokenPlanPaymentResult(vm: TokenPlanPaymentResultViewModel): void {
  console.log('Token Plan Payment Result');
  for (const field of vm.fields) console.log(`  ${`${field.label}:`.padEnd(18)}${field.value}`);
  console.log(`\n${vm.note}`);
}
